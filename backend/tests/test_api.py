import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

FIXTURES = Path(__file__).parent / "fixtures"

# datagrunt 4.5.4 deprecation-warns on the read_options dict spelling, but it
# is the only spelling pl.read_excel accepts for calamine options — tracked in
# https://github.com/pmgraham/datagrunt/issues/290. Tolerated until resolved.
_READ_OPTIONS_DEPRECATION = "ignore:Passing 'read_options' as a dictionary is deprecated:DeprecationWarning"

client = TestClient(app)


def test_presets_seeded():
    resp = client.post("/session/reset")
    assert resp.status_code == 200
    names = [d["name"] for d in resp.json()["datasets"]]
    assert "raw_sales_data.csv" in names
    assert any("q4_forecast" in n for n in names)


def test_upload_csv():
    csv = b"a;b\n1;2\n3;4\n"  # semicolon delimiter -> Datagrunt inference
    resp = client.post("/datasets", files=[("files", ("up.csv", io.BytesIO(csv), "text/csv"))])
    assert resp.status_code == 200
    ds = resp.json()["datasets"][0]
    assert [c["name"] for c in ds["columns"]] == ["a", "b"]


def test_query_sql_join():
    client.post("/session/reset")
    body = {
        "mode": "sql",
        "sql": "SELECT raw_sales_data.id, region_master.region_name "
        "FROM raw_sales_data JOIN region_master "
        "ON raw_sales_data.region_id = region_master.region_id ORDER BY raw_sales_data.id",
    }
    resp = client.post("/query", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["error"] is None
    assert "region_name" in data["columns"]
    assert len(data["rows"]) >= 1


def test_query_clean_drop_null():
    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")
    body = {"mode": "clean", "clean": {"datasetId": sales["id"], "op": "dedup"}}
    resp = client.post("/query", json=body)
    assert resp.status_code == 200
    assert resp.json()["error"] is None


def test_query_clean_pipeline():
    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")
    body = {
        "mode": "clean",
        "clean_pipeline": [
            {"datasetId": sales["id"], "op": "drop_null", "column": "sku_name"},
            {"datasetId": sales["id"], "op": "rename", "column": "sku_name", "newName": "product_name"},
        ],
    }
    resp = client.post("/query", json=body)
    assert resp.status_code == 200
    assert resp.json()["error"] is None
    assert "product_name" in resp.json()["columns"]


def test_query_clean_fill_null_validation():
    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")

    body = {
        "mode": "clean",
        "clean_pipeline": [
            {"datasetId": sales["id"], "op": "cast", "column": "price_unit", "castType": "DOUBLE"},
            {"datasetId": sales["id"], "op": "fill_null", "column": "price_unit", "value": "not_a_number"},
        ],
    }
    resp = client.post("/query", json=body)
    assert resp.status_code == 200
    assert resp.json()["error"] is not None
    assert "not a valid number" in resp.json()["detail"]


def test_query_bad_sql_returns_structured_error():
    body = {"mode": "sql", "sql": "SELECT * FROM nonexistent_table"}
    resp = client.post("/query", json=body)
    assert resp.status_code == 200
    assert resp.json()["error"] is not None


def test_export_csv():
    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")
    resp = client.post("/export", json={"datasetId": sales["id"], "format": "csv"})
    assert resp.status_code == 200
    assert b"sku_name" in resp.content


def test_dataset_has_table_name():
    reset = client.post("/session/reset").json()
    datasets = reset["datasets"]
    for ds in datasets:
        assert "table" in ds and ds["table"], f"Dataset {ds['name']!r} missing non-empty table field"
    sales = next(d for d in datasets if d["name"] == "raw_sales_data.csv")
    assert sales["table"] == "session.imported.raw_sales_data"


def test_uploaded_file_referencable_by_stable_name():
    client.post("/session/reset")
    csv = b"a,b\n1,2\n"
    resp = client.post("/datasets", files=[("files", ("up.csv", io.BytesIO(csv), "text/csv"))])
    assert resp.status_code == 200
    uploaded = resp.json()["datasets"][0]
    table_name = uploaded["table"]  # "up" if fresh session, "up_2" etc. if collision
    query_resp = client.post("/query", json={"mode": "sql", "sql": f"SELECT * FROM {table_name}"})
    assert query_resp.status_code == 200
    data = query_resp.json()
    assert data["error"] is None
    assert len(data["rows"]) >= 1


def test_uploaded_file_preview_and_confirm():
    client.post("/session/reset")
    csv = b"First Name,Price Unit\nJohn,200\n"
    # 1. Preview
    resp = client.post("/datasets/preview", files=[("files", ("up_cols.csv", io.BytesIO(csv), "text/csv"))])
    assert resp.status_code == 200
    preview = resp.json()
    assert preview["is_single"] is True
    staged = preview["files"][0]
    assert staged["filename"] == "up_cols.csv"
    assert staged["columns"] == ["First Name", "Price Unit"]
    assert staged["columns_normalized"] == ["first_name", "price_unit"]
    assert staged["rows"] == [["John", "200"]]
    staged_id = staged["staged_id"]

    # 2. Confirm with normalize_columns = True
    confirm_resp = client.post(
        "/datasets/confirm",
        json={"files": [{"staged_id": staged_id, "filename": "up_cols.csv", "normalize_columns": True}]},
    )
    assert confirm_resp.status_code == 200
    datasets = confirm_resp.json()["datasets"]
    assert len(datasets) == 1
    ds = datasets[0]
    assert ds["columns"][0]["name"] == "first_name"
    assert ds["columns"][1]["name"] == "price_unit"


def test_confirm_import_custom_schema():
    client.post("/session/reset")
    csv = b"col1,col2\nval1,val2\n"
    preview = client.post("/datasets/preview", files=[("files", ("custom_up.csv", io.BytesIO(csv), "text/csv"))]).json()
    staged_id = preview["files"][0]["staged_id"]

    # Confirm with a custom schema
    confirm_resp = client.post(
        "/datasets/confirm",
        json={"files": [{"staged_id": staged_id, "filename": "custom_up.csv", "schema_name": "my_custom_schema"}]},
    )
    assert confirm_resp.status_code == 200
    datasets = confirm_resp.json()["datasets"]
    assert len(datasets) == 1
    ds = datasets[0]
    assert ds["schema_name"] == "my_custom_schema"
    assert ds["table"] == "session.my_custom_schema.custom_up"

    # Query the custom schema table
    q = client.post("/query", json={"mode": "sql", "sql": "SELECT * FROM my_custom_schema.custom_up"})
    assert q.status_code == 200
    assert q.json()["error"] is None
    assert len(q.json()["rows"]) == 1

    # Verify that it is NOT in the default 'imported' schema
    q_bad = client.post("/query", json={"mode": "sql", "sql": "SELECT * FROM imported.custom_up"})
    assert q_bad.json()["error"] is not None


def test_dataset_sheets():
    reset = client.post("/session/reset").json()
    excel_ds = next(d for d in reset["datasets"] if d["name"].startswith("q4_forecast.xlsx"))
    resp = client.get(f"/datasets/{excel_ds['id']}/sheets")
    assert resp.status_code == 200
    assert "forecast" in resp.json()["sheets"]


def test_export_unknown_dataset_returns_404():
    resp = client.post("/export", json={"datasetId": "nope", "format": "csv"})
    assert resp.status_code == 404


def test_export_dataset_parquet():
    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")
    resp = client.post("/export", json={"datasetId": sales["id"], "format": "parquet"})
    assert resp.status_code == 200
    assert resp.content[:4] == b"PAR1"  # parquet magic bytes


def test_export_sql_returns_all_rows_csv():
    client.post("/session/reset")
    resp = client.post("/export", json={"sql": "SELECT * FROM range(500) r(n);", "format": "csv"})
    assert resp.status_code == 200
    lines = resp.content.decode().strip().splitlines()
    assert len(lines) == 501  # header + 500 rows — full result, not the 200-row grid cap


def test_export_sql_parquet():
    client.post("/session/reset")
    resp = client.post("/export", json={"sql": "SELECT 1 AS x", "format": "parquet"})
    assert resp.status_code == 200
    assert resp.content[:4] == b"PAR1"


def test_export_requires_exactly_one_source():
    reset = client.post("/session/reset").json()
    ds = reset["datasets"][0]
    assert client.post("/export", json={"format": "csv"}).status_code == 400
    both = client.post("/export", json={"datasetId": ds["id"], "sql": "SELECT 1", "format": "csv"})
    assert both.status_code == 400


def test_export_bad_sql_returns_400():
    client.post("/session/reset")
    resp = client.post("/export", json={"sql": "SELECT * FROM nope_missing", "format": "csv"})
    assert resp.status_code == 400
    assert "nope_missing" in resp.json()["detail"]


def test_export_bad_format_returns_400():
    reset = client.post("/session/reset").json()
    ds = reset["datasets"][0]
    resp = client.post("/export", json={"datasetId": ds["id"], "format": "xml"})
    assert resp.status_code == 400


def test_export_blank_sql_returns_400():
    resp = client.post("/export", json={"sql": "", "format": "csv"})
    assert resp.status_code == 400


def test_cast_column_success():
    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")
    resp = client.post(f"/datasets/{sales['id']}/cast", json={"column": "price_unit", "type": "decimal"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    cols = {c["name"]: c["type"] for c in body["columns"]}
    assert cols["price_unit"] == "DOUBLE"
    # persisted: a numeric query now works
    q = client.post("/query", json={"mode": "sql", "sql": "SELECT count(*) FROM raw_sales_data WHERE price_unit > 500"})
    assert q.json()["error"] is None


def test_cast_column_strict_failure_reports_without_mutating():
    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")
    # sku_name is non-numeric text -> casting to integer fails for every row
    resp = client.post(f"/datasets/{sales['id']}/cast", json={"column": "sku_name", "type": "integer"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert body["failingCount"] >= 1
    assert body["example"] is not None
    # unchanged
    cols = {c["name"]: c["type"] for c in body["columns"]}
    assert cols["sku_name"] == "VARCHAR"


def test_cast_column_lenient_nulls():
    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")
    resp = client.post(f"/datasets/{sales['id']}/cast", json={"column": "status", "type": "integer", "lenient": True})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["nulledCount"] >= 1


def test_cast_unknown_dataset_returns_404():
    resp = client.post("/datasets/nope/cast", json={"column": "x", "type": "integer"})
    assert resp.status_code == 404


def test_cast_label_mapping_to_invalid_duck_type_returns_400(monkeypatch):
    from app import main as main_mod

    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")
    monkeypatch.setitem(main_mod._UI_TYPE_TO_DUCK, "text", "NOT_A_REAL_TYPE")
    resp = client.post(f"/datasets/{sales['id']}/cast", json={"column": "sku_name", "type": "text"})
    assert resp.status_code == 400


def test_excel_preset_loads_as_text():
    reset = client.post("/session/reset").json()
    excel = next(d for d in reset["datasets"] if d["name"].startswith("q4_forecast.xlsx"))
    types = {c["name"]: c["type"] for c in excel["columns"]}
    # 'projected' is numeric in the workbook but must load as text until the user converts
    assert types["projected"] == "VARCHAR"
    assert all(t == "VARCHAR" for t in types.values())


def test_delete_dataset_returns_updated_list():
    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")
    resp = client.delete(f"/datasets/{sales['id']}")
    assert resp.status_code == 200
    names = [d["name"] for d in resp.json()["datasets"]]
    assert "raw_sales_data.csv" not in names
    # the table is gone: a query against it errors
    q = client.post("/query", json={"mode": "sql", "sql": "SELECT * FROM raw_sales_data"})
    assert q.json()["error"] is not None


def test_delete_unknown_dataset_returns_404():
    resp = client.delete("/datasets/nope")
    assert resp.status_code == 404


def test_upload_multiple_csvs_preserves_order():
    a = ("files", ("one.csv", io.BytesIO(b"a,b\n1,2\n"), "text/csv"))
    b = ("files", ("two.csv", io.BytesIO(b"c,d\n3,4\n"), "text/csv"))
    resp = client.post("/datasets", files=[a, b])
    assert resp.status_code == 200
    body = resp.json()
    assert body["errors"] == []
    assert [d["name"] for d in body["datasets"]] == ["one.csv", "two.csv"]


def test_upload_reports_per_file_errors():
    good = ("files", ("good.csv", io.BytesIO(b"a,b\n1,2\n"), "text/csv"))
    bad = ("files", ("bad.xlsx", io.BytesIO(b"not a real workbook"), "application/octet-stream"))
    resp = client.post("/datasets", files=[good, bad])
    assert resp.status_code == 200
    body = resp.json()
    assert [d["name"] for d in body["datasets"]] == ["good.csv"]
    assert len(body["errors"]) == 1
    assert body["errors"][0]["filename"] == "bad.xlsx"
    assert body["errors"][0]["message"]


def test_confirm_rejects_staged_id_path_traversal(tmp_path):
    """A client-supplied staged_id must not escape the upload dir.

    Regression for a path-traversal hole: /datasets/confirm joined staged_id
    onto the upload dir, then read the target into a table and unlink()ed it,
    yielding arbitrary file read + delete via '../' or an absolute path.
    """
    client.post("/session/reset")
    victim = tmp_path / "victim.csv"
    victim.write_text("secret,value\ntop,secret\n")

    for staged_id in (str(victim), "../../../../../../etc/hosts"):
        resp = client.post("/datasets/confirm", json={"files": [{"staged_id": staged_id, "filename": "pwned.csv"}]})
        assert resp.status_code == 200
        body = resp.json()
        assert body["datasets"] == []
        assert body["errors"] and body["errors"][0]["message"] == "Staged file not found"

    # The traversal target was neither ingested nor deleted.
    assert victim.exists(), "victim file was deleted via traversal"
    listing = client.post(
        "/query",
        json={
            "mode": "sql",
            "sql": "SELECT count(*) AS n FROM information_schema.tables WHERE table_name ILIKE '%pwned%'",
        },
    ).json()
    assert listing["rows"][0][0] == 0


def test_upload_excel_and_csv_expands_sheets():
    xlsx = (FIXTURES / "two_sheets.xlsx").read_bytes()
    files = [
        (
            "files",
            ("two_sheets.xlsx", io.BytesIO(xlsx), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ),
        ("files", ("extra.csv", io.BytesIO(b"a,b\n1,2\n"), "text/csv")),
    ]
    resp = client.post("/datasets", files=files)
    assert resp.status_code == 200
    body = resp.json()
    assert body["errors"] == []
    # two_sheets.xlsx -> 2 datasets (east, west) + extra.csv -> 1 = 3
    assert len(body["datasets"]) == 3
    assert {d["sheet"] for d in body["datasets"] if d["sheet"]} == {"east", "west"}


def test_dataset_preview_returns_rows():
    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")
    resp = client.get(f"/datasets/{sales['id']}/preview")
    assert resp.status_code == 200
    data = resp.json()
    assert data["columns"] == [c["name"] for c in sales["columns"]]
    assert len(data["rows"]) >= 1
    assert data["truncated"] is False


def test_dataset_preview_clamps_limit():
    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")
    # limit=1 respected; limit=999999 clamped server-side to 1000 (no error)
    resp = client.get(f"/datasets/{sales['id']}/preview", params={"limit": 1})
    assert len(resp.json()["rows"]) == 1
    resp = client.get(f"/datasets/{sales['id']}/preview", params={"limit": 999999})
    assert resp.status_code == 200


def test_dataset_preview_unknown_id_404():
    resp = client.get("/datasets/nope-not-real/preview")
    assert resp.status_code == 404


def test_query_multi_statement_returns_tabbed_results():
    client.post("/session/reset")
    body = {"mode": "sql", "sql": "SELECT 1 AS a; SELECT 2 AS b"}
    resp = client.post("/query", json=body)
    data = resp.json()
    assert data["error"] is None
    assert len(data["results"]) == 2
    assert data["results"][0]["columns"] == ["a"]
    assert data["results"][1]["columns"] == ["b"]
    # top-level mirrors the last successful result set (back-compat)
    assert data["columns"] == ["b"]


def test_query_multi_statement_error_keeps_earlier_results():
    client.post("/session/reset")
    body = {"mode": "sql", "sql": "SELECT 1 AS a; SELECT * FROM missing_tbl"}
    resp = client.post("/query", json=body)
    data = resp.json()
    assert data["error"] is None  # first statement succeeded
    assert len(data["results"]) == 2
    assert data["results"][1]["error"] is not None
    assert data["columns"] == ["a"]


def test_query_all_statements_fail_sets_top_level_error():
    client.post("/session/reset")
    resp = client.post("/query", json={"mode": "sql", "sql": "SELECT * FROM missing_tbl"})
    data = resp.json()
    assert data["error"] is not None
    assert len(data["results"]) == 1


def test_query_save_as_rejects_multi_statement():
    client.post("/session/reset")
    body = {"mode": "sql", "sql": "SELECT 1; SELECT 2", "saveAs": "combo"}
    resp = client.post("/query", json=body)
    data = resp.json()
    assert data["error"] is not None
    assert "single" in data["detail"].lower()


def test_query_single_statement_shape_unchanged():
    client.post("/session/reset")
    resp = client.post("/query", json={"mode": "sql", "sql": "SELECT 1 AS x"})
    data = resp.json()
    assert data["error"] is None
    assert data["columns"] == ["x"]
    assert data["rows"] == [[1]]
    assert len(data["results"]) == 1


def test_query_empty_sql_returns_structured_error():
    client.post("/session/reset")
    for sql in ("", "   ", "-- just a comment"):
        resp = client.post("/query", json={"mode": "sql", "sql": sql})
        assert resp.status_code == 200
        data = resp.json()
        assert data["error"] is not None
        assert "index" not in (data["detail"] or "").lower()
        assert data["results"] == []


def test_page_sql_window():
    client.post("/session/reset")
    resp = client.post("/page", json={"sql": "SELECT * FROM range(300) r(n) ORDER BY n;", "offset": 250, "limit": 25})
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 300
    assert [r[0] for r in data["rows"]] == list(range(250, 275))


def test_page_dataset_source():
    reset = client.post("/session/reset").json()
    sales = next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")
    resp = client.post("/page", json={"datasetId": sales["id"], "offset": 0, "limit": 25})
    assert resp.status_code == 200
    data = resp.json()
    assert "sku_name" in data["columns"]
    assert data["total"] == len(data["rows"])  # small fixture fits one page


def test_page_validation_errors():
    reset = client.post("/session/reset").json()
    ds = reset["datasets"][0]
    assert client.post("/page", json={"offset": 0, "limit": 25}).status_code == 400
    assert client.post("/page", json={"sql": "", "offset": 0, "limit": 25}).status_code == 400
    assert (
        client.post("/page", json={"datasetId": ds["id"], "sql": "SELECT 1", "offset": 0, "limit": 25}).status_code
        == 400
    )
    assert client.post("/page", json={"sql": "SELECT 1", "offset": -1, "limit": 25}).status_code == 400
    assert client.post("/page", json={"sql": "SELECT 1", "offset": 0, "limit": 0}).status_code == 400
    assert client.post("/page", json={"sql": "SELECT 1", "offset": 0, "limit": 201}).status_code == 400


def test_page_unknown_dataset_returns_404():
    assert client.post("/page", json={"datasetId": "nope", "offset": 0, "limit": 25}).status_code == 404


def test_page_bad_sql_returns_400():
    client.post("/session/reset")
    resp = client.post("/page", json={"sql": "SELECT * FROM missing_tbl", "offset": 0, "limit": 25})
    assert resp.status_code == 400
    assert "missing_tbl" in resp.json()["detail"]


def test_page_whitespace_sql_returns_400():
    resp = client.post("/page", json={"sql": "   ", "offset": 0, "limit": 25})
    assert resp.status_code == 400


def test_page_no_result_set_sql_returns_400():
    client.post("/session/reset")
    resp = client.post("/page", json={"sql": "CREATE TABLE page_ddl_probe(i INT)", "offset": 0, "limit": 25})
    assert resp.status_code == 400


def test_page_search_filters_and_counts():
    client.post("/session/reset")
    body = {
        "sql": (
            "SELECT CASE WHEN r % 2 = 0 THEN 'even' ELSE 'odd' END AS parity, r AS n FROM range(100) t(r) ORDER BY r"
        ),
        "offset": 0,
        "limit": 25,
        "search": "even",
    }
    resp = client.post("/page", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 50
    assert len(data["rows"]) == 25
    assert all(row[0] == "even" for row in data["rows"])


def test_page_sort_param():
    client.post("/session/reset")
    body = {
        "sql": "SELECT * FROM (VALUES (2), (10), (1)) t(n)",
        "offset": 0,
        "limit": 25,
        "sortColumn": "n",
        "sortDirection": "desc",
    }
    resp = client.post("/page", json=body)
    assert resp.status_code == 200
    assert [r[0] for r in resp.json()["rows"]] == [10, 2, 1]


def test_page_bad_sort_direction_returns_400():
    resp = client.post(
        "/page",
        json={
            "sql": "SELECT 1 AS a",
            "offset": 0,
            "limit": 25,
            "sortColumn": "a",
            "sortDirection": "sideways",
        },
    )
    assert resp.status_code == 400


def test_page_unknown_sort_column_returns_400():
    client.post("/session/reset")
    resp = client.post(
        "/page",
        json={
            "sql": "SELECT 1 AS a",
            "offset": 0,
            "limit": 25,
            "sortColumn": "nope",
        },
    )
    assert resp.status_code == 400
    assert "nope" in resp.json()["detail"]


def _stage_fixture(filename: str) -> str:
    """Upload a fixture through /datasets/preview and return its staged_id."""
    with open(FIXTURES / filename, "rb") as f:
        resp = client.post("/datasets/preview", files=[("files", (filename, f))])
    assert resp.status_code == 200
    return resp.json()["files"][0]["staged_id"]


def test_stage_ragged_preamble_csv_tolerated():
    """A CSV whose preamble breaks default parsing still stages, with the
    error surfaced — the modal's skip-rows flow is how the user fixes it."""
    with open(FIXTURES / "preamble.csv", "rb") as f:
        resp = client.post("/datasets/preview", files=[("files", ("preamble.csv", f))])
    assert resp.status_code == 200
    entry = resp.json()["files"][0]
    assert entry["error"]
    assert entry["columns"] is None
    assert entry["rows"] is None


def test_stage_clean_csv_has_no_error():
    with open(FIXTURES / "semicolon.csv", "rb") as f:
        resp = client.post("/datasets/preview", files=[("files", ("semicolon.csv", f))])
    assert resp.status_code == 200
    entry = resp.json()["files"][0]
    assert entry["error"] is None
    # semicolon.csv fixture is id;name;price (not the brief's a;b example) —
    # asserting the real inferred columns for this fixture.
    assert entry["columns"] == ["id", "name", "price"]


def test_staged_repreview_csv_skip_rows():
    staged_id = _stage_fixture("preamble.csv")
    resp = client.post(
        f"/datasets/staged/{staged_id}/preview",
        json={"skip_rows": 3, "has_header": True},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["columns"] == ["name", "amount"]
    assert data["rows"] == [["alice", "10"], ["bob", "20"]]


def test_staged_repreview_excel_sheet():
    staged_id = _stage_fixture("preamble_two_sheets.xlsx")
    resp = client.post(
        f"/datasets/staged/{staged_id}/preview",
        json={"sheet": "messy", "skip_rows": 3, "has_header": True},
    )
    assert resp.status_code == 200
    assert resp.json()["columns"] == ["name", "amount"]


def test_staged_repreview_skip_past_end_is_400():
    staged_id = _stage_fixture("preamble.csv")
    resp = client.post(
        f"/datasets/staged/{staged_id}/preview",
        json={"skip_rows": 999, "has_header": True},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]


def test_staged_repreview_unknown_id_is_404():
    resp = client.post(
        "/datasets/staged/deadbeef_missing.csv/preview",
        json={"skip_rows": 0, "has_header": True},
    )
    assert resp.status_code == 404


def test_staged_repreview_negative_skip_is_422():
    staged_id = _stage_fixture("preamble.csv")
    resp = client.post(
        f"/datasets/staged/{staged_id}/preview",
        json={"skip_rows": -1, "has_header": True},
    )
    assert resp.status_code == 422


def test_confirm_import_csv_with_skip_rows():
    client.post("/session/reset")
    staged_id = _stage_fixture("preamble.csv")
    resp = client.post(
        "/datasets/confirm",
        json={
            "files": [
                {
                    "staged_id": staged_id,
                    "filename": "preamble.csv",
                    "skip_rows": 3,
                    "has_header": True,
                }
            ]
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["errors"] == []
    ds = body["datasets"][0]
    assert [c["name"] for c in ds["columns"]] == ["name", "amount"]


@pytest.mark.filterwarnings(_READ_OPTIONS_DEPRECATION)
def test_confirm_import_excel_per_sheet_options():
    client.post("/session/reset")
    staged_id = _stage_fixture("preamble_two_sheets.xlsx")
    resp = client.post(
        "/datasets/confirm",
        json={
            "files": [
                {
                    "staged_id": staged_id,
                    "filename": "preamble_two_sheets.xlsx",
                    "sheet_options": {"messy": {"skip_rows": 3, "has_header": True}},
                }
            ]
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["errors"] == []
    by_sheet = {d["sheet"]: d for d in body["datasets"]}
    assert [c["name"] for c in by_sheet["messy"]["columns"]] == ["name", "amount"]
    assert [c["name"] for c in by_sheet["clean"]["columns"]] == ["name", "amount"]


def test_confirm_import_defaults_still_work():
    client.post("/session/reset")
    staged_id = _stage_fixture("semicolon.csv")
    resp = client.post(
        "/datasets/confirm",
        json={
            "files": [
                {
                    "staged_id": staged_id,
                    "filename": "semicolon.csv",
                }
            ]
        },
    )
    assert resp.status_code == 200
    assert resp.json()["errors"] == []
