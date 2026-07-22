from pathlib import Path

import duckdb
import pytest

from app.query_engine import QueryEngine
from app.session_registry import Dataset, SessionRegistry, base_table_name


# Cross-language contract with the frontend lib/table-naming.ts. The same inputs
# are asserted in lib/table-naming.test.ts; change one side, change both.
@pytest.mark.parametrize(
    "name, sheet, schema, expected",
    [
        ("raw_sales_data.csv", None, "imported", "raw_sales_data"),
        ("a--b.csv", None, "imported", "a_b"),  # collapse AFTER replace, not a__b
        ("book.xlsx", "Sheet 1", "imported", "book_Sheet_1"),
        ("---.csv", None, "imported", "dataset"),  # empty stem -> fallback
        ("My Report.pdf", None, "documents", "my_report"),
        ("My Report.pdf", None, "rationalized", "my_report"),
        # already-snake-cased names pass through unchanged (Task 3 pre-bakes the
        # _page_images suffix into the name, so this must be idempotent)
        ("my_report_page_images", None, "rationalized", "my_report_page_images"),
    ],
)
def test_base_table_name_contract(name, sheet, schema, expected):
    assert base_table_name(name, sheet, schema) == expected


def _make_parquet(path: Path) -> Path:
    con = duckdb.connect()
    con.execute("CREATE TABLE t(id INTEGER, name VARCHAR)")
    con.execute("INSERT INTO t VALUES (1,'a'),(2,'b')")
    con.execute(f"COPY t TO '{path.as_posix()}' (FORMAT PARQUET)")
    return path


def test_add_and_list(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    reg = SessionRegistry(eng)
    pq = _make_parquet(tmp_path / "a.parquet")
    ds = reg.add_from_parquet("raw.csv", "csv", pq)
    assert isinstance(ds, Dataset)
    assert ds.name == "raw.csv"
    assert [c.name for c in ds.columns] == ["id", "name"]
    assert reg.get(ds.id).table == ds.table
    assert len(reg.list()) == 1
    eng.close()


def test_unique_tables_for_same_name(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    reg = SessionRegistry(eng)
    pq = _make_parquet(tmp_path / "a.parquet")
    d1 = reg.add_from_parquet("raw.csv", "csv", pq)
    d2 = reg.add_from_parquet("raw.csv", "csv", pq)
    assert d1.table != d2.table
    assert d1.name == "raw.csv"
    assert d2.name == "raw_2.csv"
    eng.close()


def test_reset_clears(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    reg = SessionRegistry(eng)
    reg.add_from_parquet("raw.csv", "csv", _make_parquet(tmp_path / "a.parquet"))
    reg.reset()
    assert reg.list() == []
    assert eng.list_tables() == []
    eng.close()


def test_get_unknown_raises(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    reg = SessionRegistry(eng)
    with pytest.raises(KeyError):
        reg.get("nope")
    eng.close()


def test_sheet_name_format(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    reg = SessionRegistry(eng)
    ds = reg.add_from_parquet("sales.csv", "csv", _make_parquet(tmp_path / "a.parquet"), sheet="Q1")
    assert ds.name == "sales.csv [Q1]"
    assert ds.sheet == "Q1"
    eng.close()


def test_refresh_columns_picks_up_type_change(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    reg = SessionRegistry(eng)
    ds = reg.add_from_parquet("raw.csv", "csv", _make_parquet(tmp_path / "a.parquet"))
    # _make_parquet builds id INTEGER, name VARCHAR; change id to VARCHAR in the engine
    eng.cast_column(ds.table, "id", "VARCHAR", lenient=False)
    refreshed = reg.refresh_columns(ds.id)
    assert {c.name: c.type for c in refreshed.columns}["id"] == "VARCHAR"
    # the stored dataset is updated too
    assert {c.name: c.type for c in reg.get(ds.id).columns}["id"] == "VARCHAR"
    eng.close()


def test_add_from_parquet_loads_all_columns_as_text(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    reg = SessionRegistry(eng)
    # _make_parquet builds id INTEGER, name VARCHAR -> dataset must load both as text
    ds = reg.add_from_parquet("raw.csv", "csv", _make_parquet(tmp_path / "a.parquet"))
    assert {c.name: c.type for c in ds.columns} == {"id": "VARCHAR", "name": "VARCHAR"}
    eng.close()


def test_remove_drops_table_and_entry(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    reg = SessionRegistry(eng)
    ds = reg.add_from_parquet("raw.csv", "csv", _make_parquet(tmp_path / "a.parquet"))
    reg.remove(ds.id)
    assert reg.list() == []
    assert ds.table not in eng.list_tables()
    with pytest.raises(KeyError):
        reg.get(ds.id)
    eng.close()


def test_remove_unknown_raises(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    reg = SessionRegistry(eng)
    with pytest.raises(KeyError):
        reg.remove("nope")
    eng.close()


def test_add_materialized_custom_schema(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    reg = SessionRegistry(eng)
    eng.create_schema("cleaned")
    eng._con.execute("CREATE TABLE cleaned.cleaned_table (id INTEGER, val VARCHAR)")
    mat = reg.add_materialized("cleaned_table", "cleaned", "cleaned.cleaned_table", schema_name="cleaned")
    assert mat.schema_name == "cleaned"
    assert mat.table == "s.cleaned.cleaned_table"
    assert mat.source_type == "cleaned"
    eng.close()


def test_add_from_json_documents(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    reg = SessionRegistry(eng)
    json_file = tmp_path / "my_document_file.json"
    json_file.write_text('{"document": {"source": "my_document_file.pdf", "pages": []}}')
    ds = reg.add_from_json("my_document_file.pdf", "pdf", json_file)
    assert ds.schema_name == "documents"
    assert ds.table == "s.documents.my_document_file"
    assert ds.source_type == "pdf"
    assert "documents.my_document_file" in eng.list_tables()
    eng.close()


def test_remove_by_name_and_overwrite(tmp_path):
    eng = QueryEngine(tmp_path / "s.duckdb")
    reg = SessionRegistry(eng)
    pq = _make_parquet(tmp_path / "a.parquet")

    # 1. Excel/CSV overwrite test
    d1 = reg.add_from_parquet("raw.csv", "csv", pq)
    assert d1.table == "s.imported.raw"
    assert len(reg.list()) == 1

    # Under regular flow, same file generates "raw_2"
    d2 = reg.add_from_parquet("raw.csv", "csv", pq)
    assert d2.table == "s.imported.raw_2"
    assert len(reg.list()) == 2

    # Under overwrite flow, we drop "raw" and add it again
    reg.remove_by_name("imported", "raw")
    assert len(reg.list()) == 1
    assert "imported.raw" not in eng.list_tables()
    assert "imported.raw_2" in eng.list_tables()  # raw_2 remains intact!

    d3 = reg.add_from_parquet("raw.csv", "csv", pq)
    assert d3.table == "s.imported.raw"
    assert len(reg.list()) == 2

    # 2. PDF overwrite test
    json_file = tmp_path / "doc.json"
    json_file.write_text('{"pages": []}')
    p1 = reg.add_from_json("doc.pdf", "pdf", json_file)
    assert p1.table == "s.documents.doc"

    # Re-importing same PDF stem under documents schema
    reg.remove_by_name("documents", "doc")
    p2 = reg.add_from_json("doc.pdf", "pdf", json_file)
    assert p2.table == "s.documents.doc"
    eng.close()
