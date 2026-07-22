import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb
import pytest

from app.query_engine import CastResult, ColumnInfo, QueryEngine, QueryResult


def _make_parquet(path: Path, rows: list[tuple], columns: list[str]) -> Path:
    con = duckdb.connect()
    values = ", ".join(str(r) for r in rows)
    cols = ", ".join(columns)
    con.execute(f"CREATE TABLE t({cols})")
    con.execute(f"INSERT INTO t VALUES {values}")
    con.execute(f"COPY t TO '{path.as_posix()}' (FORMAT PARQUET)")
    return path


def test_ingest_and_schema(tmp_path):
    pq = _make_parquet(tmp_path / "a.parquet", [(1, "x"), (2, "y")], ["id INTEGER", "name VARCHAR"])
    eng = QueryEngine(tmp_path / "session.duckdb")
    eng.ingest_parquet("sales", pq)
    schema = eng.table_schema("sales")
    assert schema == [ColumnInfo("id", "INTEGER"), ColumnInfo("name", "VARCHAR")]
    eng.close()


def test_run_sql_caps_rows(tmp_path):
    pq = _make_parquet(tmp_path / "b.parquet", [(i, "x") for i in range(10)], ["id INTEGER", "name VARCHAR"])
    eng = QueryEngine(tmp_path / "session.duckdb")
    eng.ingest_parquet("t", pq)
    result = eng.run_sql("SELECT * FROM t", limit=5)
    assert isinstance(result, QueryResult)
    assert result.columns == ["id", "name"]
    assert len(result.rows) == 5
    assert result.truncated is True
    eng.close()


def test_cross_table_join(tmp_path):
    left = _make_parquet(tmp_path / "l.parquet", [(1, "E"), (2, "W")], ["id INTEGER", "region_id VARCHAR"])
    right = _make_parquet(
        tmp_path / "r.parquet", [("E", "East"), ("W", "West")], ["region_id VARCHAR", "region VARCHAR"]
    )
    eng = QueryEngine(tmp_path / "session.duckdb")
    eng.ingest_parquet("orders", left)
    eng.ingest_parquet("regions", right)
    result = eng.run_sql(
        "SELECT orders.id, regions.region FROM orders"
        " JOIN regions ON orders.region_id = regions.region_id ORDER BY orders.id"
    )
    assert result.rows == [[1, "East"], [2, "West"]]
    eng.close()


def test_materialize_creates_table(tmp_path):
    pq = _make_parquet(tmp_path / "c.parquet", [(1, "x"), (2, "y")], ["id INTEGER", "name VARCHAR"])
    eng = QueryEngine(tmp_path / "session.duckdb")
    eng.ingest_parquet("t", pq)
    eng.materialize("t_clean", "SELECT * FROM t WHERE id > 1")
    assert "t_clean" in eng.list_tables()
    assert eng.table_sample("t_clean").rows == [[2, "y"]]
    eng.close()


def test_export_parquet_roundtrip(tmp_path):
    pq = _make_parquet(tmp_path / "d.parquet", [(1, "x")], ["id INTEGER", "name VARCHAR"])
    eng = QueryEngine(tmp_path / "session.duckdb")
    eng.ingest_parquet("t", pq)
    out = eng.export("t", "parquet", tmp_path / "export.parquet")
    assert out.exists()
    eng.close()


def test_run_sql_error_raises(tmp_path):
    eng = QueryEngine(tmp_path / "session.duckdb")
    with pytest.raises(Exception):
        eng.run_sql("SELECT * FROM does_not_exist")
    eng.close()


def _make_text_parquet(path, rows, columns):
    con = duckdb.connect()
    cols = ", ".join(f"{c} VARCHAR" for c in columns)
    con.execute(f"CREATE TABLE t({cols})")
    con.execute(f"INSERT INTO t VALUES {', '.join(str(r) for r in rows)}")
    con.execute(f"COPY t TO '{path.as_posix()}' (FORMAT PARQUET)")
    return path


def test_cast_column_strict_success(tmp_path):
    pq = _make_text_parquet(tmp_path / "a.parquet", [("1", "10.5"), ("2", "20")], ["id", "price"])
    eng = QueryEngine(tmp_path / "s.duckdb")
    eng.ingest_parquet("t", pq)
    result = eng.cast_column("t", "price", "DOUBLE", lenient=False)
    assert isinstance(result, CastResult)
    assert result.ok is True
    assert result.failing_count == 0
    assert result.nulled_count == 0
    types = {c.name: c.type for c in result.columns}
    assert types["price"] == "DOUBLE"
    # persistence: a numeric comparison now works
    assert eng.run_sql("SELECT * FROM t WHERE price > 15").rows == [["2", 20.0]]
    eng.close()


def test_cast_column_strict_failure_does_not_mutate(tmp_path):
    pq = _make_text_parquet(tmp_path / "b.parquet", [("1", "10.5"), ("2", "N/A")], ["id", "price"])
    eng = QueryEngine(tmp_path / "s.duckdb")
    eng.ingest_parquet("t", pq)
    result = eng.cast_column("t", "price", "DOUBLE", lenient=False)
    assert result.ok is False
    assert result.failing_count == 1
    assert result.example == "N/A"
    # table unchanged: price is still VARCHAR
    assert {c.name: c.type for c in eng.table_schema("t")}["price"] == "VARCHAR"
    eng.close()


def test_cast_column_lenient_nulls_bad_values(tmp_path):
    pq = _make_text_parquet(tmp_path / "c.parquet", [("1", "10.5"), ("2", "N/A")], ["id", "price"])
    eng = QueryEngine(tmp_path / "s.duckdb")
    eng.ingest_parquet("t", pq)
    result = eng.cast_column("t", "price", "DOUBLE", lenient=True)
    assert result.ok is True
    assert result.nulled_count == 1
    assert {c.name: c.type for c in result.columns}["price"] == "DOUBLE"
    rows = eng.run_sql("SELECT * FROM t ORDER BY id").rows
    assert rows == [["1", 10.5], ["2", None]]
    eng.close()


def test_cast_column_invalid_type_raises(tmp_path):
    pq = _make_text_parquet(tmp_path / "d.parquet", [("1", "x")], ["id", "name"])
    eng = QueryEngine(tmp_path / "s.duckdb")
    eng.ingest_parquet("t", pq)
    with pytest.raises(ValueError):
        eng.cast_column("t", "name", "EVILTYPE", lenient=False)
    eng.close()


def test_ingest_parquet_force_text_makes_all_columns_varchar(tmp_path):
    pq = _make_parquet(tmp_path / "typed.parquet", [(1, "x"), (2, "y")], ["id INTEGER", "name VARCHAR"])
    eng = QueryEngine(tmp_path / "s.duckdb")
    eng.ingest_parquet("t", pq, force_text=True)
    types = {c.name: c.type for c in eng.table_schema("t")}
    assert types == {"id": "VARCHAR", "name": "VARCHAR"}
    assert eng.run_sql("SELECT * FROM t ORDER BY id").rows == [["1", "x"], ["2", "y"]]
    eng.close()


def test_ingest_parquet_default_preserves_types(tmp_path):
    pq = _make_parquet(tmp_path / "typed2.parquet", [(1, "x")], ["id INTEGER", "name VARCHAR"])
    eng = QueryEngine(tmp_path / "s.duckdb")
    eng.ingest_parquet("t", pq)  # default: type-preserving
    assert {c.name: c.type for c in eng.table_schema("t")}["id"] == "INTEGER"
    eng.close()


def test_drop_table_removes_table(tmp_path):
    pq = _make_parquet(tmp_path / "a.parquet", [(1, "x")], ["id INTEGER", "name VARCHAR"])
    eng = QueryEngine(tmp_path / "s.duckdb")
    eng.ingest_parquet("t", pq)
    eng.drop_table("t")
    assert "t" not in eng.list_tables()
    with pytest.raises(Exception):
        eng.run_sql("SELECT * FROM t")
    eng.close()


def test_drop_table_missing_is_noop(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    eng.drop_table("does_not_exist")  # must not raise
    eng.close()


def test_concurrent_access_is_thread_safe(tmp_path):
    """The engine's connection is shared across FastAPI's threadpool, so many
    requests can reach it at once. Concurrent calls must neither raise nor return
    corrupted results. Regression: fails without the connection lock (DuckDB
    connections are not safe for concurrent use)."""
    pq = _make_parquet(
        tmp_path / "big.parquet",
        [(i, f"n{i}") for i in range(500)],
        ["id INTEGER", "name VARCHAR"],
    )
    eng = QueryEngine(tmp_path / "session.duckdb")
    eng.ingest_parquet("sales", pq)

    workers, iterations = 16, 40
    start = threading.Barrier(workers)
    errors: list[Exception] = []
    wrong_counts: list[int] = []

    def hammer(worker_id: int) -> None:
        start.wait()  # release all threads together to maximize overlap
        try:
            for i in range(iterations):
                n = eng.run_sql("SELECT count(*) FROM sales").rows[0][0]
                if n != 500:
                    wrong_counts.append(n)
                eng.create_schema(f"w{worker_id}")
                eng.run_sql(f"SELECT id FROM sales WHERE id < {i}", limit=1000)
        except Exception as exc:  # noqa: BLE001 - the test asserts none occur
            errors.append(exc)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(hammer, range(workers)))
    eng.close()

    assert not errors, f"concurrent access raised: {errors[:3]}"
    assert not wrong_counts, f"corrupted row counts under concurrency: {wrong_counts[:5]}"


def test_split_statements_ignores_semicolons_in_strings():
    stmts = QueryEngine.split_statements("SELECT 1; SELECT ';' AS s; SELECT 2")
    assert len(stmts) == 3
    assert stmts[1] == "SELECT ';' AS s"


def test_run_statements_returns_one_result_per_statement(tmp_path):
    eng = QueryEngine(tmp_path / "session.duckdb")
    results = eng.run_statements("SELECT 1 AS a; SELECT 2 AS b, 3 AS c")
    assert [r.columns for r in results] == [["a"], ["b", "c"]]
    assert [r.rows for r in results] == [[[1]], [[2, 3]]]
    assert all(r.has_result_set and r.error is None for r in results)
    eng.close()


def test_run_statements_non_select_gets_status_entry(tmp_path):
    eng = QueryEngine(tmp_path / "session.duckdb")
    results = eng.run_statements("CREATE TABLE t(i INTEGER); SELECT * FROM t")
    assert results[0].has_result_set is False
    assert results[0].error is None
    assert results[1].columns == ["i"]
    eng.close()


def test_run_statements_stops_at_failing_statement(tmp_path):
    eng = QueryEngine(tmp_path / "session.duckdb")
    results = eng.run_statements("SELECT 1 AS ok; SELECT * FROM missing_table; SELECT 2 AS never_runs")
    assert len(results) == 2  # third statement never ran
    assert results[0].error is None
    assert results[1].error is not None
    assert "missing_table" in (results[1].detail or "")
    eng.close()


def test_run_statements_caps_each_result(tmp_path):
    eng = QueryEngine(tmp_path / "session.duckdb")
    results = eng.run_statements("SELECT * FROM range(10)", limit=5)
    assert len(results[0].rows) == 5
    assert results[0].truncated is True
    eng.close()


def test_ingest_json_forces_all_columns_to_text(tmp_path):
    jf = tmp_path / "doc.json"
    jf.write_text('[{"invoice_no": 1001, "amount": 12.5, "vendor": "Acme", "meta": {"page": 1}}]')
    eng = QueryEngine(tmp_path / "session.duckdb")
    eng.ingest_json("documents.doc", jf)
    schema = eng.table_schema("documents.doc")
    assert [c.type for c in schema] == ["VARCHAR"] * 4
    # numeric-looking values survive as their text form
    result = eng.run_sql("SELECT invoice_no, amount FROM documents.doc")
    assert result.rows == [["1001", "12.5"]]
    eng.close()


def test_ingest_json_nested_columns_are_json_text(tmp_path):
    """Nested structs/lists must land as parseable JSON text, not DuckDB's
    struct-literal syntax ({'key': bare_value}), so the frontend can offer
    the View-as-JSON toggle on document blobs."""
    import json

    jf = tmp_path / "doc.json"
    jf.write_text(
        '{"document": {"source": "a.pdf", "total_pages": 1, "pages": [{"page_number": 1, "lines": ["x", "y"]}]}}'
    )
    eng = QueryEngine(tmp_path / "session.duckdb")
    eng.ingest_json("documents.doc", jf)
    schema = eng.table_schema("documents.doc")
    assert [c.type for c in schema] == ["VARCHAR"]
    blob = eng.run_sql("SELECT document FROM documents.doc").rows[0][0]
    assert json.loads(blob) == {
        "source": "a.pdf",
        "total_pages": 1,
        "pages": [{"page_number": 1, "lines": ["x", "y"]}],
    }
    eng.close()


def test_run_statements_captures_runtime_errors(tmp_path):
    eng = QueryEngine(tmp_path / "session.duckdb")
    results = eng.run_statements("SELECT 1 AS ok; SELECT CAST('abc' AS INT) AS boom")
    assert len(results) == 2
    assert results[0].error is None
    assert results[0].rows == [[1]]
    assert results[1].error is not None
    assert results[1].statement == "SELECT CAST('abc' AS INT) AS boom"
    eng.close()


def test_export_parquet_full_result_set(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    out = eng.export_parquet("SELECT * FROM range(500)", tmp_path / "r.parquet")
    con = duckdb.connect()
    count = con.execute(f"SELECT COUNT(*) FROM read_parquet('{out.as_posix()}')").fetchone()[0]
    assert count == 500  # well past the 200-row grid cap
    eng.close()


def test_export_parquet_supports_cte_statements(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    out = eng.export_parquet("WITH x AS (SELECT 1 AS n) SELECT * FROM x", tmp_path / "cte.parquet")
    con = duckdb.connect()
    rows = con.execute(f"SELECT * FROM read_parquet('{out.as_posix()}')").fetchall()
    assert rows == [(1,)]
    eng.close()


def test_export_parquet_reflects_cast_state(tmp_path):
    pq = _make_text_parquet(tmp_path / "a.parquet", [("1", "10.5"), ("2", "20")], ["id", "price"])
    eng = QueryEngine(tmp_path / "s.duckdb")
    eng.ingest_parquet("t", pq)
    eng.cast_column("t", "price", "DOUBLE", lenient=False)
    out = eng.export_parquet(eng.table_select_sql("t"), tmp_path / "t.parquet")
    con = duckdb.connect()
    (price_type,) = con.execute(f"SELECT typeof(price) FROM read_parquet('{out.as_posix()}') LIMIT 1").fetchone()
    assert price_type == "DOUBLE"  # export reads live DuckDB state, not the original file
    eng.close()


def test_page_windows_and_total(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    res = eng.page("SELECT * FROM range(100) ORDER BY range", offset=25, limit=25)
    assert res.total == 100
    assert res.columns == ["range"]
    assert len(res.rows) == 25
    assert res.rows[0] == [25] and res.rows[-1] == [49]
    eng.close()


def test_page_cte_source(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    res = eng.page(
        "WITH x AS (SELECT * FROM range(10)) SELECT * FROM x ORDER BY range",
        offset=8,
        limit=5,
    )
    assert res.total == 10
    assert [r[0] for r in res.rows] == [8, 9]
    eng.close()


def test_page_offset_past_end(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    res = eng.page("SELECT * FROM range(10)", offset=50, limit=25)
    assert res.rows == []
    assert res.total == 10
    eng.close()


_SEARCH_SRC = (
    "SELECT * FROM (VALUES "
    "('Smith', 2024, 'east'), ('Jones', 2024, 'west'), ('Smithers', 2023, 'east')"
    ") t(name, year, region) ORDER BY name"
)


def test_page_search_words_match_across_columns(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    # 'smith' hits name, '2024' hits year — different columns, same row (AND of words)
    res = eng.page(_SEARCH_SRC, offset=0, limit=25, search="smith 2024")
    assert res.total == 1
    assert res.rows == [["Smith", 2024, "east"]]
    eng.close()


def test_page_search_case_insensitive_substring(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    res = eng.page(_SEARCH_SRC, offset=0, limit=25, search="WEST")
    assert res.total == 1 and res.rows[0][0] == "Jones"
    res = eng.page(_SEARCH_SRC, offset=0, limit=25, search="smith")
    assert res.total == 2  # Smith and Smithers — substring match
    eng.close()


def test_page_search_text_is_literal(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    src = "SELECT * FROM (VALUES ('100%'), ('100x'), ('a_b'), ('axb'), ('O''Brien'), ('back\\slash')) t(v)"
    assert eng.page(src, offset=0, limit=25, search="100%").total == 1  # % not a wildcard
    assert eng.page(src, offset=0, limit=25, search="a_b").total == 1  # _ not a wildcard
    assert eng.page(src, offset=0, limit=25, search="o'brien").total == 1
    assert eng.page(src, offset=0, limit=25, search="back\\slash").total == 1
    eng.close()


def test_page_search_windowing_and_total(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    src = "SELECT CASE WHEN r % 3 = 0 THEN 'fizz' ELSE 'plain' END AS w, r AS n FROM range(300) t(r) ORDER BY r"
    res = eng.page(src, offset=25, limit=25, search="fizz")
    assert res.total == 100  # 0,3,...,297
    assert len(res.rows) == 25
    assert res.rows[0][1] == 75  # 26th fizz row is n = 3 * 25
    eng.close()


def test_page_blank_search_is_no_filter(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    res = eng.page("SELECT * FROM range(300)", offset=0, limit=25, search="   ")
    assert res.total == 300
    eng.close()


def test_page_search_null_cells_match_nothing(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    src = "SELECT * FROM (VALUES ('x'), (NULL)) t(v)"
    res = eng.page(src, offset=0, limit=25, search="x")
    assert res.total == 1
    assert res.rows == [["x"]]
    eng.close()


def test_page_sort_uses_native_type_order(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    src = "SELECT * FROM (VALUES (2), (10), (1)) t(n)"
    asc = eng.page(src, offset=0, limit=25, sort_column="n", sort_direction="asc")
    assert [r[0] for r in asc.rows] == [1, 2, 10]  # numeric order, not string ('1','10','2')
    desc = eng.page(src, offset=0, limit=25, sort_column="n", sort_direction="desc")
    assert [r[0] for r in desc.rows] == [10, 2, 1]
    eng.close()


def test_page_sort_overrides_inner_order_by(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    src = "SELECT * FROM range(10) ORDER BY range DESC"
    res = eng.page(src, offset=0, limit=3, sort_column="range", sort_direction="asc")
    assert [r[0] for r in res.rows] == [0, 1, 2]
    eng.close()


def test_page_sort_composes_with_search_and_window(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    src = "SELECT CASE WHEN r % 3 = 0 THEN 'fizz' ELSE 'plain' END AS w, r AS n FROM range(300) t(r)"
    res = eng.page(src, offset=0, limit=3, search="fizz", sort_column="n", sort_direction="desc")
    assert res.total == 100
    assert [r[1] for r in res.rows] == [297, 294, 291]
    eng.close()


def test_page_sort_unknown_column_raises(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    with pytest.raises(duckdb.Error, match="Unknown sort column"):
        eng.page("SELECT 1 AS a", offset=0, limit=25, sort_column="nope")
    eng.close()
