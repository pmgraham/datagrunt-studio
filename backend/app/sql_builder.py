"""Translate the UI's Clean/Join tab parameters into DuckDB SQL, and build the
Datagrunt-flavored code snippet shown in the UI's live code panel."""

_VALID_CAST = {"VARCHAR", "INTEGER", "DOUBLE", "BOOLEAN", "DATE", "BIGINT", "TIMESTAMP"}
_VALID_JOIN = {"inner": "INNER", "left": "LEFT", "right": "RIGHT", "outer": "FULL OUTER"}


def _q(name: str) -> str:
    if "." in name:
        return ".".join('"' + p.replace('"', '""') + '"' for p in name.split("."))
    return '"' + name.replace('"', '""') + '"'


def _is_number(value: str) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def get_column_type_at_step(steps: list, current_idx: int, initial_columns: list, target_column: str) -> str | None:
    curr_col = target_column
    for idx in range(current_idx - 1, -1, -1):
        step = steps[idx]
        op = getattr(step, "op", None) or (step.get("op") if isinstance(step, dict) else None)
        column = getattr(step, "column", None) or (step.get("column") if isinstance(step, dict) else None)
        newName = getattr(step, "newName", None) or (step.get("newName") if isinstance(step, dict) else None)
        castType = getattr(step, "castType", None) or (step.get("castType") if isinstance(step, dict) else None)

        if op == "rename" and newName == curr_col:
            curr_col = column
        elif op == "cast" and column == curr_col:
            return castType

    for col in initial_columns:
        col_name = getattr(col, "name", None) or (
            col.get("name") if isinstance(col, dict) else col[0] if isinstance(col, tuple) else None
        )
        col_type = getattr(col, "type", None) or (
            col.get("type") if isinstance(col, dict) else col[1] if isinstance(col, tuple) else None
        )
        if col_name == curr_col:
            return col_type
    return None


def build_clean_sql(
    table: str,
    op: str,
    column: str | None = None,
    value: str | None = None,
    new_name: str | None = None,
    cast_type: str | None = None,
    column_type: str | None = None,
) -> str:
    t = _q(table)
    if op == "drop_null":
        return f"SELECT * FROM {t} WHERE {_q(column)} IS NOT NULL"
    if op == "fill_null":
        is_numeric = True
        if column_type:
            ctype = column_type.upper()
            if ctype not in (
                "INTEGER",
                "BIGINT",
                "SMALLINT",
                "TINYINT",
                "HUGEINT",
                "DOUBLE",
                "FLOAT",
                "REAL",
                "DECIMAL",
                "NUMERIC",
            ):
                is_numeric = False

        if is_numeric and _is_number(value):
            literal = value
        else:
            literal = "'" + str(value).replace("'", "''") + "'"
        col = _q(column)
        return f"SELECT * REPLACE (COALESCE({col}, {literal}) AS {col}) FROM {t}"
    if op == "rename":
        col = _q(column)
        return f"SELECT * EXCLUDE ({col}), {col} AS {_q(new_name)} FROM {t}"
    if op == "cast":
        ctype = (cast_type or "").upper()
        if ctype not in _VALID_CAST:
            raise ValueError(f"Unsupported cast type: {cast_type}")
        col = _q(column)
        return f"SELECT * REPLACE (CAST({col} AS {ctype}) AS {col}) FROM {t}"
    if op == "dedup":
        return f"SELECT DISTINCT * FROM {t}"
    raise ValueError(f"Unsupported clean op: {op}")


def build_clean_pipeline_sql(table: str, steps: list, initial_columns: list = []) -> str:
    """Build a CTE sequence of clean steps."""
    if not steps:
        return f"SELECT * FROM {_q(table)}"

    ctes = []
    prev_table = table
    for idx, step in enumerate(steps):
        step_name = f"step_{idx + 1}"
        op = getattr(step, "op", None) or (step.get("op") if isinstance(step, dict) else None)
        column = getattr(step, "column", None) or (step.get("column") if isinstance(step, dict) else None)
        value = getattr(step, "value", None) or (step.get("value") if isinstance(step, dict) else None)
        newName = getattr(step, "newName", None) or (step.get("newName") if isinstance(step, dict) else None)
        castType = getattr(step, "castType", None) or (step.get("castType") if isinstance(step, dict) else None)

        col_type = get_column_type_at_step(steps, idx, initial_columns, column) if column else None

        step_sql = build_clean_sql(prev_table, op, column, value, newName, castType, column_type=col_type)
        ctes.append(f"{_q(step_name)} AS ({step_sql})")
        prev_table = step_name

    return "WITH " + ",\n".join(ctes) + f"\nSELECT * FROM {_q(prev_table)}"


def build_join_sql(left: str, right: str, left_key: str, right_key: str, how: str) -> str:
    join_kw = _VALID_JOIN.get(how)
    if join_kw is None:
        raise ValueError(f"Unsupported join type: {how}")
    return (
        f"SELECT * FROM {_q(left)} {join_kw} JOIN {_q(right)} "
        f"ON {_q(left)}.{_q(left_key)} = {_q(right)}.{_q(right_key)}"
    )


def snippet_for_load(table: str, source_name: str, source_type: str) -> str:
    if source_type == "cleaned":
        return f"# Materialized cleansed table: {source_name}\n# Query this table directly in DuckDB via: {table}"
    reader = "ExcelReader" if source_type == "excel" else "CSVReader"
    return (
        "import datagrunt as dg\n\n"
        f"# Datagrunt loads and parses the file (delimiter / sheet inference)\n"
        f"reader = dg.{reader}('{source_name}')\n"
        f"reader.write_parquet('{table}.parquet')  # bridge to the Studio's DuckDB session"
    )
