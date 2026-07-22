import shutil
from pathlib import Path

import duckdb
from fastapi.testclient import TestClient

from app import gcs_service, pdf_service
from app.main import app

client = TestClient(app)

FIXTURES = Path(__file__).parent / "fixtures"


def _write_parquet(dest: Path) -> None:
    con = duckdb.connect()
    con.execute(f"COPY (SELECT 1::BIGINT AS id, 'alpha' AS label) TO '{dest.as_posix()}' (FORMAT PARQUET)")
    con.close()


def test_gcs_buckets_lists_names(monkeypatch):
    monkeypatch.setattr(gcs_service, "list_buckets", lambda project=None: ["alpha", "beta"])
    resp = client.get("/gcs/buckets")
    assert resp.status_code == 200
    assert resp.json() == {"buckets": ["alpha", "beta"]}


def test_gcs_buckets_forwards_project(monkeypatch):
    captured = {}

    def fake_buckets(project=None):
        captured["project"] = project
        return ["alpha"]

    monkeypatch.setattr(gcs_service, "list_buckets", fake_buckets)
    resp = client.get("/gcs/buckets", params={"project": "my-proj"})
    assert resp.status_code == 200
    assert resp.json() == {"buckets": ["alpha"]}
    assert captured["project"] == "my-proj"


def test_gcs_buckets_missing_credentials_is_400_with_hint(monkeypatch):
    def boom(project=None):
        raise gcs_service.GcsCredentialsError()

    monkeypatch.setattr(gcs_service, "list_buckets", boom)
    resp = client.get("/gcs/buckets")
    assert resp.status_code == 400
    assert "gcloud auth application-default login" in resp.json()["detail"]


def test_gcs_projects_lists_ids_and_names(monkeypatch):
    monkeypatch.setattr(
        gcs_service,
        "list_projects",
        lambda: [{"id": "p1", "name": "Project One"}, {"id": "p2", "name": "p2"}],
    )
    resp = client.get("/gcs/projects")
    assert resp.status_code == 200
    assert resp.json() == {
        "projects": [
            {"id": "p1", "name": "Project One"},
            {"id": "p2", "name": "p2"},
        ]
    }


def test_gcs_projects_missing_credentials_is_400_with_hint(monkeypatch):
    def boom():
        raise gcs_service.GcsCredentialsError()

    monkeypatch.setattr(gcs_service, "list_projects", boom)
    resp = client.get("/gcs/projects")
    assert resp.status_code == 400
    assert "gcloud auth application-default login" in resp.json()["detail"]


def test_gcs_objects_lists_folders_and_files(monkeypatch):
    def fake_list(bucket, prefix="", suffixes=None):
        assert bucket == "alpha"
        assert prefix == "raw/"
        return {
            "folders": ["raw/2026/"],
            "files": [gcs_service.GcsObject(name="raw/sales.csv", size=42, updated="2026-07-13T00:00:00")],
        }

    monkeypatch.setattr(gcs_service, "list_objects", fake_list)
    resp = client.get("/gcs/objects", params={"bucket": "alpha", "prefix": "raw/"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["folders"] == ["raw/2026/"]
    assert data["files"] == [{"name": "raw/sales.csv", "size": 42, "updated": "2026-07-13T00:00:00"}]


def test_gcs_import_csv_returns_preview_and_confirm_creates_dataset(monkeypatch):
    client.post("/session/reset")

    def fake_download(bucket, name, dest):
        dest.write_bytes(b"a,b\n1,2\n3,4\n")
        return dest

    monkeypatch.setattr(gcs_service, "download_object", fake_download)

    resp = client.post("/gcs/import", json={"bucket": "alpha", "objects": ["raw/gcs_sales.csv"]})
    assert resp.status_code == 200
    data = resp.json()
    assert data["datasets"] == []
    assert data["errors"] == []
    preview = data["previews"][0]
    assert preview["filename"] == "gcs_sales.csv"
    assert preview["columns"] == ["a", "b"]

    confirm = client.post(
        "/datasets/confirm",
        json={
            "files": [
                {
                    "staged_id": preview["staged_id"],
                    "filename": preview["filename"],
                }
            ]
        },
    )
    assert confirm.status_code == 200
    created = confirm.json()["datasets"]
    assert len(created) == 1
    assert [c["name"] for c in created[0]["columns"]] == ["a", "b"]


def test_gcs_import_parquet_registers_directly_with_types(monkeypatch):
    client.post("/session/reset")

    def fake_download(bucket, name, dest):
        _write_parquet(dest)
        return dest

    monkeypatch.setattr(gcs_service, "download_object", fake_download)

    resp = client.post("/gcs/import", json={"bucket": "alpha", "objects": ["curated/metrics.parquet"]})
    assert resp.status_code == 200
    data = resp.json()
    assert data["previews"] == []
    assert data["errors"] == []
    ds = data["datasets"][0]
    assert ds["name"] == "metrics.parquet"
    # force_text=False must preserve parquet types (BIGINT, not VARCHAR)
    types = {c["name"]: c["type"] for c in ds["columns"]}
    assert "INT" in types["id"].upper()


def test_gcs_import_json_registers_directly(monkeypatch):
    client.post("/session/reset")

    def fake_download(bucket, name, dest):
        dest.write_text('[{"id": 1, "label": "alpha"}, {"id": 2, "label": "beta"}]')
        return dest

    monkeypatch.setattr(gcs_service, "download_object", fake_download)

    resp = client.post("/gcs/import", json={"bucket": "alpha", "objects": ["docs/items.json"]})
    assert resp.status_code == 200
    data = resp.json()
    ds = data["datasets"][0]
    assert ds["name"] == "items.json"
    assert ds["schema_name"] == "imported"
    assert {c["name"] for c in ds["columns"]} == {"id", "label"}


def test_gcs_import_unsupported_type_is_an_error_entry(monkeypatch):
    def fake_download(bucket, name, dest):  # must not be called
        raise AssertionError("download should not happen for unsupported types")

    monkeypatch.setattr(gcs_service, "download_object", fake_download)

    resp = client.post("/gcs/import", json={"bucket": "alpha", "objects": ["book.xlsx"]})
    assert resp.status_code == 200
    data = resp.json()
    assert data["previews"] == [] and data["datasets"] == []
    assert data["errors"][0]["filename"] == "book.xlsx"


def test_gcs_import_download_failure_isolated_per_object(monkeypatch):
    client.post("/session/reset")

    def fake_download(bucket, name, dest):
        if name.endswith("bad.csv"):
            raise RuntimeError("403 forbidden")
        dest.write_bytes(b"x,y\n1,2\n")
        return dest

    monkeypatch.setattr(gcs_service, "download_object", fake_download)

    resp = client.post("/gcs/import", json={"bucket": "alpha", "objects": ["bad.csv", "good.csv"]})
    assert resp.status_code == 200
    data = resp.json()
    assert data["errors"][0]["filename"] == "bad.csv"
    assert data["previews"][0]["filename"] == "good.csv"


def _reset_and_get_sales_id():
    reset = client.post("/session/reset").json()
    return next(d for d in reset["datasets"] if d["name"] == "raw_sales_data.csv")["id"]


def test_gcs_export_dataset_csv_uploads_and_returns_uri(monkeypatch):
    sales_id = _reset_and_get_sales_id()
    captured = {}

    def fake_upload(local_path, bucket, name):
        captured["existed"] = Path(local_path).exists()
        captured["bucket"], captured["name"] = bucket, name
        return f"gs://{bucket}/{name}"

    monkeypatch.setattr(gcs_service, "upload_file", fake_upload)

    resp = client.post(
        "/gcs/export",
        json={
            "datasetId": sales_id,
            "format": "csv",
            "bucket": "alpha",
            "path": "exports/",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["uri"] == "gs://alpha/exports/raw_sales_data.csv"
    assert captured["existed"] is True
    assert captured["name"] == "exports/raw_sales_data.csv"


def test_gcs_export_sql_json_format(monkeypatch):
    client.post("/session/reset")
    captured = {}

    def fake_upload(local_path, bucket, name):
        captured["suffix"] = Path(local_path).suffix
        return f"gs://{bucket}/{name}"

    monkeypatch.setattr(gcs_service, "upload_file", fake_upload)

    resp = client.post(
        "/gcs/export",
        json={
            "sql": "SELECT 1 AS id",
            "format": "json",
            "bucket": "alpha",
            "path": "out",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["uri"] == "gs://alpha/out.json"
    assert captured["suffix"] == ".json"


def test_gcs_export_rejects_bad_format():
    resp = client.post(
        "/gcs/export",
        json={
            "sql": "SELECT 1",
            "format": "xlsx",
            "bucket": "alpha",
            "path": "out",
        },
    )
    assert resp.status_code == 400


def test_gcs_export_requires_bucket():
    resp = client.post(
        "/gcs/export",
        json={
            "sql": "SELECT 1",
            "format": "csv",
            "bucket": "   ",
            "path": "out",
        },
    )
    assert resp.status_code == 400


def test_gcs_export_upload_failure_maps_to_gcs_error(monkeypatch):
    def fake_upload(local_path, bucket, name):
        raise RuntimeError("network unreachable")

    monkeypatch.setattr(gcs_service, "upload_file", fake_upload)

    resp = client.post(
        "/gcs/export",
        json={
            "sql": "SELECT 1 AS id",
            "format": "csv",
            "bucket": "alpha",
            "path": "out",
        },
    )
    assert resp.status_code == 502
    assert "network unreachable" in resp.json()["detail"]


def test_gcs_objects_kind_pdf_uses_pdf_suffixes(monkeypatch):
    captured = {}

    def fake_list(bucket, prefix="", suffixes=None):
        captured["suffixes"] = suffixes
        return {"folders": [], "files": []}

    monkeypatch.setattr(gcs_service, "list_objects", fake_list)

    resp = client.get("/gcs/objects", params={"bucket": "alpha", "kind": "pdf"})
    assert resp.status_code == 200
    assert captured["suffixes"] == gcs_service.PDF_SUFFIXES


def test_gcs_objects_kind_defaults_to_datasets(monkeypatch):
    captured = {}

    def fake_list(bucket, prefix="", suffixes=None):
        captured["suffixes"] = suffixes
        return {"folders": [], "files": []}

    monkeypatch.setattr(gcs_service, "list_objects", fake_list)

    resp = client.get("/gcs/objects", params={"bucket": "alpha"})
    assert resp.status_code == 200
    assert captured["suffixes"] == gcs_service.IMPORTABLE_SUFFIXES


def test_gcs_objects_unknown_kind_is_400():
    resp = client.get("/gcs/objects", params={"bucket": "alpha", "kind": "spreadsheets"})
    assert resp.status_code == 400


def test_pdf_import_gcs_returns_doc_id_and_serves_file(monkeypatch):
    monkeypatch.setattr(gcs_service, "download_object_bytes", lambda bucket, name: b"%PDF-1.4 fake")
    resp = client.post("/pdf/import-gcs", json={"bucket": "alpha", "object": "docs/Invoice 2024.pdf"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["filename"] == "Invoice 2024.pdf"
    served = client.get(f"/pdf/file/{data['doc_id']}")
    assert served.status_code == 200
    assert served.content == b"%PDF-1.4 fake"


def test_pdf_import_gcs_rejects_non_pdf(monkeypatch):
    def fake_download(bucket, name):  # must not be called
        raise AssertionError("download should not happen for non-pdf objects")

    monkeypatch.setattr(gcs_service, "download_object_bytes", fake_download)

    resp = client.post("/pdf/import-gcs", json={"bucket": "alpha", "object": "docs/data.csv"})
    assert resp.status_code == 400


def test_pdf_import_gcs_missing_credentials_is_400_with_hint(monkeypatch):
    def boom(bucket, name):
        raise gcs_service.GcsCredentialsError()

    monkeypatch.setattr(gcs_service, "download_object_bytes", boom)

    resp = client.post("/pdf/import-gcs", json={"bucket": "alpha", "object": "docs/a.pdf"})
    assert resp.status_code == 400
    assert "gcloud auth application-default login" in resp.json()["detail"]


def test_pdf_import_gcs_save_failure_is_formatted_500(monkeypatch):
    monkeypatch.setattr(gcs_service, "download_object_bytes", lambda bucket, name: b"%PDF-1.4 fake")

    def boom(filename, contents):
        raise OSError("disk full")

    monkeypatch.setattr(pdf_service, "save_upload", boom)

    resp = client.post("/pdf/import-gcs", json={"bucket": "alpha", "object": "docs/a.pdf"})
    assert resp.status_code == 500
    assert resp.json()["detail"] == "disk full"


def test_pdf_import_gcs_download_failure_maps_to_gcs_error(monkeypatch):
    def boom(bucket, name):
        raise RuntimeError("network unreachable")

    monkeypatch.setattr(gcs_service, "download_object_bytes", boom)

    resp = client.post("/pdf/import-gcs", json={"bucket": "alpha", "object": "docs/a.pdf"})
    assert resp.status_code == 502
    assert "network unreachable" in resp.json()["detail"]


def test_gcs_import_xlsx_returns_preview_with_sheets(monkeypatch):
    client.post("/session/reset")

    def fake_download(bucket, name, dest):
        shutil.copyfile(FIXTURES / "two_sheets.xlsx", dest)
        return dest

    monkeypatch.setattr(gcs_service, "download_object", fake_download)

    resp = client.post("/gcs/import", json={"bucket": "alpha", "objects": ["raw/two_sheets.xlsx"]})
    assert resp.status_code == 200
    data = resp.json()
    assert data["datasets"] == []
    assert data["errors"] == []
    preview = data["previews"][0]
    assert preview["filename"] == "two_sheets.xlsx"
    assert preview["sheets"] == ["east", "west"]
    assert preview["columns"] == ["region", "amount"]


def test_gcs_import_xlsx_confirm_imports_every_sheet(monkeypatch):
    client.post("/session/reset")

    def fake_download(bucket, name, dest):
        shutil.copyfile(FIXTURES / "two_sheets.xlsx", dest)
        return dest

    monkeypatch.setattr(gcs_service, "download_object", fake_download)

    resp = client.post("/gcs/import", json={"bucket": "alpha", "objects": ["raw/two_sheets.xlsx"]})
    preview = resp.json()["previews"][0]

    confirm = client.post(
        "/datasets/confirm",
        json={
            "files": [
                {
                    "staged_id": preview["staged_id"],
                    "filename": preview["filename"],
                }
            ]
        },
    )
    assert confirm.status_code == 200
    created = confirm.json()["datasets"]
    assert len(created) == 2
    assert sorted(d["sheet"] for d in created) == ["east", "west"]


def test_gcs_import_xls_suffix_routes_to_staging(monkeypatch):
    client.post("/session/reset")

    def fake_download(bucket, name, dest):
        dest.write_bytes(b"stub")
        return dest

    monkeypatch.setattr(gcs_service, "download_object", fake_download)

    from app import main as main_module

    canned = {"sheets": ["only"], "columns": ["a"], "columns_normalized": ["a"], "rows": []}
    monkeypatch.setattr(main_module.svc, "preview_file", lambda path: canned)

    resp = client.post("/gcs/import", json={"bucket": "alpha", "objects": ["legacy/book.xls"]})
    assert resp.status_code == 200
    data = resp.json()
    assert data["errors"] == []
    assert data["datasets"] == []
    assert data["previews"][0]["sheets"] == ["only"]


def test_gcs_import_xls_parses_real_legacy_workbook(monkeypatch):
    client.post("/session/reset")

    def fake_download(bucket, name, dest):
        shutil.copyfile(FIXTURES / "legacy_book.xls", dest)
        return dest

    monkeypatch.setattr(gcs_service, "download_object", fake_download)

    resp = client.post("/gcs/import", json={"bucket": "alpha", "objects": ["legacy/legacy_book.xls"]})
    assert resp.status_code == 200
    data = resp.json()
    assert data["errors"] == []
    preview = data["previews"][0]
    assert preview["sheets"] == ["legacy"]
    assert preview["columns"] == ["item", "count"]

    confirm = client.post(
        "/datasets/confirm",
        json={
            "files": [
                {
                    "staged_id": preview["staged_id"],
                    "filename": preview["filename"],
                }
            ]
        },
    )
    assert confirm.status_code == 200
    created = confirm.json()["datasets"]
    assert [d["sheet"] for d in created] == ["legacy"]
