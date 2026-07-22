"""The Studio's transform engine: a persisted DuckDB database. Every dataset is a
table; every transform (SQL/Clean/Join) is SQL run here. Datagrunt is not involved."""

import functools
import threading
from dataclasses import dataclass
from pathlib import Path

import duckdb


@dataclass(frozen=True)
class ColumnInfo:
    name: str
    type: str


@dataclass(frozen=True)
class QueryResult:
    columns: list[str]
    rows: list[list]
    truncated: bool


@dataclass(frozen=True)
class PageResult:
    columns: list[str]
    rows: list[list]
    total: int


@dataclass(frozen=True)
class StatementResult:
    columns: list[str]
    rows: list[list]
    truncated: bool
    statement: str
    has_result_set: bool
    error: str | None = None
    detail: str | None = None


@dataclass(frozen=True)
class CastResult:
    ok: bool
    failing_count: int
    example: str | None
    nulled_count: int
    columns: list[ColumnInfo]


def _quote_ident(name: str) -> str:
    if "." in name:
        return ".".join('"' + p.replace('"', '""') + '"' for p in name.split("."))
    return '"' + name.replace('"', '""') + '"'


def _quote_col(name: str) -> str:
    """Quote a result-column identifier verbatim. Unlike _quote_ident there
    is no dot-splitting — result columns may legitimately contain dots."""
    return '"' + name.replace('"', '""') + '"'


def _is_nested_type(col_type: str) -> bool:
    """True for DuckDB types whose VARCHAR cast is struct-literal syntax
    rather than JSON (STRUCT/MAP/UNION/lists/JSON)."""
    return col_type.startswith(("STRUCT", "MAP", "UNION")) or "[]" in col_type or col_type == "JSON"


def _text_expr(name: str, col_type: str) -> str:
    """SELECT expression that lands a column as VARCHAR: to_json() for nested
    types so the text is parseable JSON, plain CAST for scalars so values
    keep their bare text form ("12.5", not "\"12.5\"")."""
    ident = _quote_col(name)
    if _is_nested_type(col_type):
        return f"to_json({ident})::VARCHAR AS {ident}"
    return f"CAST({ident} AS VARCHAR) AS {ident}"


def _search_predicate(columns: list[str], search: str) -> str | None:
    """SQL predicate mirroring the frontend's filterRows semantics: every
    whitespace-separated word must match some column (case-insensitive
    substring); the search text is always literal, never a wildcard."""
    words = search.split()
    if not words:
        return None
    clauses = []
    for word in words:
        escaped = word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_").replace("'", "''")
        pattern = f"'%{escaped}%' ESCAPE '\\'"
        per_word = " OR ".join(f"CAST({_quote_col(col)} AS VARCHAR) ILIKE {pattern}" for col in columns)
        clauses.append(f"({per_word})")
    return " AND ".join(clauses)


def _synchronized(method):
    """Serialize a public engine method on the connection lock.

    DuckDB connections are not safe for concurrent use, yet FastAPI runs the
    Studio's sync endpoints on a threadpool, so two requests can reach the shared
    connection at once. Holding the (reentrant) lock for the whole method also
    keeps multi-statement operations — ingest's DROP+CREATE, cast's probe+ALTER,
    move's CREATE+DROP — atomic against other threads.
    """

    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return wrapper


class QueryEngine:
    def __init__(self, db_path: Path):
        self._db_path = db_path
        self._con_obj = None
        self._catalog = None
        self._lock = threading.RLock()

    @property
    def _con(self):
        if self._con_obj is None:
            with self._lock:
                if self._con_obj is None:
                    self._db_path.parent.mkdir(parents=True, exist_ok=True)
                    self._con_obj = duckdb.connect(str(self._db_path))
        return self._con_obj

    @property
    def catalog(self):
        with self._lock:
            if self._catalog is None:
                self._catalog = self._con.execute("SELECT current_database()").fetchone()[0]
            return self._catalog

    @_synchronized
    def ingest_parquet(self, table: str, parquet_path: Path, force_text: bool = False) -> None:
        if "." in table:
            parts = table.split(".")
            if len(parts) >= 2:
                self.create_schema(parts[-2])
        ident = _quote_ident(table)
        # force_text loads every column as VARCHAR so datasets always start as text;
        # the user converts types explicitly. Datagrunt's Excel reader otherwise carries
        # the workbook's native cell types through. Default preserves the Parquet types.
        projection = "CAST(COLUMNS(*) AS VARCHAR)" if force_text else "*"
        self._con.execute(f"DROP TABLE IF EXISTS {ident}")
        self._con.execute(
            f"CREATE TABLE {ident} AS SELECT {projection} FROM read_parquet(?)",
            [parquet_path.as_posix()],
        )

    @_synchronized
    def ingest_json(self, table: str, json_path: Path) -> None:
        if "." in table:
            parts = table.split(".")
            if len(parts) >= 2:
                self.create_schema(parts[-2])
        ident = _quote_ident(table)
        self._con.execute(f"DROP TABLE IF EXISTS {ident}")
        # Documents always land as text — read_json_auto's inferred types
        # (BIGINT etc.) are discarded so users convert types explicitly,
        # matching the force_text parquet path. Nested columns must go
        # through to_json(): a plain VARCHAR cast yields DuckDB's
        # struct-literal syntax ({'key': bare_value}), which is not
        # parseable JSON and breaks the frontend's View-as-JSON toggle.
        described = self._con.execute("DESCRIBE SELECT * FROM read_json_auto(?)", [json_path.as_posix()]).fetchall()
        select_list = ", ".join(_text_expr(name, col_type) for name, col_type, *_ in described)
        self._con.execute(
            f"CREATE TABLE {ident} AS SELECT {select_list} FROM read_json_auto(?)",
            [json_path.as_posix()],
        )

    @_synchronized
    def run_sql(self, sql: str, limit: int = 200) -> QueryResult:
        relation = self._con.sql(sql)
        columns = list(relation.columns)
        fetched = relation.limit(limit + 1).fetchall()
        truncated = len(fetched) > limit
        rows = [list(r) for r in fetched[:limit]]
        return QueryResult(columns=columns, rows=rows, truncated=truncated)

    @_synchronized
    def page(
        self,
        sql: str,
        offset: int,
        limit: int,
        search: str | None = None,
        sort_column: str | None = None,
        sort_direction: str = "asc",
    ) -> PageResult:
        """One LIMIT/OFFSET window of a statement's result set, plus the
        full COUNT(*) total — both computed over the search-filtered rows
        when a search is given. Sort applies after the search filter, uses native
        type order, and overrides any inner ORDER BY. The relation API accepts
        CTE statements natively, so no subquery wrapping is needed."""
        relation = self._con.sql(sql)
        if relation is None:
            raise duckdb.InvalidInputException("Statement has no result set to page")
        columns = list(relation.columns)
        if search:
            predicate = _search_predicate(columns, search)
            if predicate:
                relation = relation.filter(predicate)
        if sort_column is not None:
            if sort_column not in columns:
                raise duckdb.InvalidInputException(f"Unknown sort column: {sort_column}")
            direction = "DESC" if sort_direction == "desc" else "ASC"
            relation = relation.order(f"{_quote_col(sort_column)} {direction}")
        rows = [list(r) for r in relation.limit(limit, offset).fetchall()]
        total = relation.aggregate("COUNT(*)").fetchone()[0]
        return PageResult(columns=columns, rows=rows, total=total)

    @staticmethod
    def split_statements(sql: str) -> list[str]:
        """Parser-accurate statement split — semicolons inside string literals
        and comments do not split."""
        return [s.query.strip() for s in duckdb.extract_statements(sql) if s.query.strip()]

    @_synchronized
    def run_statements(self, sql: str, limit: int = 200) -> list[StatementResult]:
        """Run each statement in order, one result per statement. Statements
        without a result set (CREATE, INSERT, ...) yield a status entry; a
        failing statement yields an error entry and stops execution."""
        results: list[StatementResult] = []
        for statement in self.split_statements(sql):
            try:
                relation = self._con.sql(statement)
                if relation is None:
                    results.append(
                        StatementResult(
                            columns=[],
                            rows=[],
                            truncated=False,
                            statement=statement,
                            has_result_set=False,
                        )
                    )
                    continue
                columns = list(relation.columns)
                fetched = relation.limit(limit + 1).fetchall()
            except Exception as exc:
                results.append(
                    StatementResult(
                        columns=[],
                        rows=[],
                        truncated=False,
                        statement=statement,
                        has_result_set=False,
                        error=type(exc).__name__,
                        detail=str(exc),
                    )
                )
                break
            results.append(
                StatementResult(
                    columns=columns,
                    rows=[list(r) for r in fetched[:limit]],
                    truncated=len(fetched) > limit,
                    statement=statement,
                    has_result_set=True,
                )
            )
        return results

    @_synchronized
    def materialize(self, table: str, sql: str) -> None:
        if "." in table:
            self.create_schema(table.split(".", 1)[0])
        ident = _quote_ident(table)
        self._con.execute(f"DROP TABLE IF EXISTS {ident}")
        self._con.execute(f"CREATE TABLE {ident} AS {sql}")

    @_synchronized
    def cast_column(self, table: str, column: str, duck_type: str, lenient: bool) -> CastResult:
        from app.sql_builder import _VALID_CAST

        if duck_type not in _VALID_CAST:
            raise ValueError(f"Unsupported type: {duck_type}")
        t = _quote_ident(table)
        c = _quote_ident(column)
        probe = self._con.execute(
            f"SELECT "
            f"count(*) FILTER (WHERE {c} IS NOT NULL AND TRY_CAST({c} AS {duck_type}) IS NULL), "
            f"any_value({c}) FILTER (WHERE {c} IS NOT NULL AND TRY_CAST({c} AS {duck_type}) IS NULL) "
            f"FROM {t}"
        ).fetchone()
        failing = int(probe[0])
        example = None if probe[1] is None else str(probe[1])
        if failing > 0 and not lenient:
            return CastResult(
                ok=False,
                failing_count=failing,
                example=example,
                nulled_count=0,
                columns=self.table_schema(table),
            )
        cast_fn = "TRY_CAST" if lenient else "CAST"
        self._con.execute(f"ALTER TABLE {t} ALTER COLUMN {c} TYPE {duck_type} USING {cast_fn}({c} AS {duck_type})")
        return CastResult(
            ok=True,
            failing_count=failing,
            example=example,
            nulled_count=failing if lenient else 0,
            columns=self.table_schema(table),
        )

    @_synchronized
    def table_schema(self, table: str) -> list[ColumnInfo]:
        ident = _quote_ident(table)
        described = self._con.execute(f"DESCRIBE {ident}").fetchall()
        return [ColumnInfo(name=row[0], type=row[1]) for row in described]

    @_synchronized
    def table_sample(self, table: str, limit: int = 50) -> QueryResult:
        return self.run_sql(f"SELECT * FROM {_quote_ident(table)}", limit=limit)

    @_synchronized
    def export(self, sql_or_table: str, fmt: str, out_path: Path) -> Path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        source = (
            sql_or_table
            if sql_or_table.strip().lower().startswith("select")
            else f"SELECT * FROM {_quote_ident(sql_or_table)}"
        )
        fmt_clause = {
            "csv": "(FORMAT CSV, HEADER)",
            "parquet": "(FORMAT PARQUET)",
            "json": "(FORMAT JSON)",
        }[fmt]
        self._con.execute(f"COPY ({source}) TO '{out_path.as_posix()}' {fmt_clause}")
        return out_path

    @_synchronized
    def export_parquet(self, sql: str, out_path: Path) -> Path:
        """Export a statement's full result set to a parquet file.

        Parquet is the canonical export format; other formats are produced
        from it by datagrunt writers at the service layer.
        """
        out_path.parent.mkdir(parents=True, exist_ok=True)
        self._con.execute(f"COPY ({sql}) TO '{out_path.as_posix()}' (FORMAT PARQUET)")
        return out_path

    def table_select_sql(self, table: str) -> str:
        """SELECT * source statement for a (possibly schema-qualified) table."""
        return f"SELECT * FROM {_quote_ident(table)}"

    @_synchronized
    def list_tables(self) -> list[str]:
        rows = self._con.execute(
            "SELECT table_schema, table_name "
            "FROM information_schema.tables "
            "WHERE table_schema NOT IN ('information_schema', 'pg_catalog')"
        ).fetchall()
        tables = []
        for schema, name in rows:
            if schema == "main":
                tables.append(name)
            else:
                tables.append(f"{schema}.{name}")
        return tables

    @_synchronized
    def set_search_path(self, path: str) -> None:
        self._con.execute(f"SET search_path = '{path}'")

    @_synchronized
    def create_schema(self, schema: str) -> None:
        self._con.execute(f"CREATE SCHEMA IF NOT EXISTS {_quote_ident(schema)}")

    @_synchronized
    def move_table(self, old_table: str, new_table: str) -> None:
        old_ident = _quote_ident(old_table)
        new_ident = _quote_ident(new_table)
        self._con.execute(f"CREATE TABLE {new_ident} AS SELECT * FROM {old_ident}")
        self._con.execute(f"DROP TABLE {old_ident}")

    @_synchronized
    def drop_all(self) -> None:
        for table in self.list_tables():
            self._con.execute(f"DROP TABLE IF EXISTS {_quote_ident(table)}")

    @_synchronized
    def drop_table(self, table: str) -> None:
        self._con.execute(f"DROP TABLE IF EXISTS {_quote_ident(table)}")

    @_synchronized
    def close(self) -> None:
        if self._con_obj is not None:
            self._con_obj.close()
            self._con_obj = None
