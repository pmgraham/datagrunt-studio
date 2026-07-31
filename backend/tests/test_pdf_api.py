"""Endpoint tests for rationalized-output persistence.

The LLM call is monkeypatched — these tests cover the save path only.
"""

import io
import json
import logging

from fastapi.testclient import TestClient

import app.pdf_service as pdf_svc
from app.main import app

client = TestClient(app)

BODY = {"prompt": "clean it", "use_local": True, "model": "test-model", "use_page_images": False}


def _upload(filename: str = "Invoice 2024.pdf") -> str:
    resp = client.post(
        "/pdf/upload",
        files=[("file", (filename, io.BytesIO(b"%PDF-1.4 fake"), "application/pdf"))],
    )
    assert resp.status_code == 200
    return resp.json()["doc_id"]


def _mock_rationalize(monkeypatch, output: str) -> None:
    """Replace the LLM call: write `output` to the schema file and return it."""

    def fake(doc_id, prompt, use_local, model, use_page_images=False):
        pdf_svc.schema_path(doc_id).write_text(output)
        return output

    monkeypatch.setattr(pdf_svc, "rationalize", fake)


def _rationalized_tables() -> list[str]:
    datasets = client.get("/datasets").json()["datasets"]
    return sorted(d["table"] for d in datasets if d["schema_name"] == "rationalized")


def _mock_extract(monkeypatch, output: dict) -> None:
    """Replace the real datagrunt PDF parsing call: write `output` to the
    extraction JSON path and return its text, mirroring extract_pdf's contract."""

    def fake(doc_id):
        text = json.dumps(output)
        pdf_svc.json_path(doc_id).write_text(text)
        return text

    monkeypatch.setattr(pdf_svc, "extract_pdf", fake)


def test_json_mode_saves_to_rationalized(monkeypatch):
    client.post("/session/reset")
    doc_id = _upload()
    _mock_rationalize(monkeypatch, json.dumps([{"invoice_no": "A-1", "total": 10.5}]))
    resp = client.post(f"/pdf/rationalize/{doc_id}", json=BODY)
    assert resp.status_code == 200
    data = resp.json()
    assert data["saved"] is True
    assert data["save_error"] is None
    assert data["dataset"]["schema_name"] == "rationalized"
    assert data["dataset"]["type"] == "pdf_rationalized"
    assert data["dataset"]["table"].endswith("rationalized.invoice_2024")
    assert _rationalized_tables() == [data["dataset"]["table"]]


def test_page_image_mode_gets_own_table(monkeypatch):
    client.post("/session/reset")
    doc_id = _upload()
    _mock_rationalize(monkeypatch, json.dumps({"invoice_no": "A-1"}))
    json_mode = client.post(f"/pdf/rationalize/{doc_id}", json=BODY).json()
    page_mode = client.post(f"/pdf/rationalize/{doc_id}", json={**BODY, "use_page_images": True}).json()
    assert json_mode["dataset"]["table"].endswith("rationalized.invoice_2024")
    assert page_mode["dataset"]["table"].endswith("rationalized.invoice_2024_page_images")
    assert len(_rationalized_tables()) == 2


def test_rerun_replaces_table_for_same_mode(monkeypatch):
    client.post("/session/reset")
    doc_id = _upload()
    _mock_rationalize(monkeypatch, json.dumps({"total": 1}))
    first = client.post(f"/pdf/rationalize/{doc_id}", json=BODY).json()
    _mock_rationalize(monkeypatch, json.dumps({"total": 2}))
    second = client.post(f"/pdf/rationalize/{doc_id}", json=BODY).json()
    # Same table, no _2 collision suffix, still exactly one dataset.
    assert second["dataset"]["table"] == first["dataset"]["table"]
    assert _rationalized_tables() == [first["dataset"]["table"]]


def test_invalid_json_returns_unsaved(monkeypatch):
    client.post("/session/reset")
    doc_id = _upload()
    _mock_rationalize(monkeypatch, "sorry, here is your schema: {broken")
    resp = client.post(f"/pdf/rationalize/{doc_id}", json=BODY)
    assert resp.status_code == 200
    data = resp.json()
    assert data["saved"] is False
    assert data["dataset"] is None
    assert "not valid JSON" in data["save_error"]
    assert data["schema"] == "sorry, here is your schema: {broken"
    assert _rationalized_tables() == []


def test_uningestable_json_returns_unsaved(monkeypatch, caplog):
    client.post("/session/reset")
    doc_id = _upload()
    # `NaN` is accepted by Python's json.loads (a non-standard but long-standing
    # extension), so json.loads succeeds. DuckDB's read_json_auto parses a bare
    # scalar array with its stricter, standards-compliant JSON parser and rejects
    # the NaN token as malformed JSON, so ingestion raises.
    _mock_rationalize(monkeypatch, "[1, NaN]")
    with caplog.at_level(logging.ERROR, logger="app.error_reporting"):
        resp = client.post(f"/pdf/rationalize/{doc_id}", json=BODY)
    assert resp.status_code == 200
    data = resp.json()
    assert data["saved"] is False
    assert data["dataset"] is None
    assert "Could not ingest" in data["save_error"]
    # The DuckDB error quotes the schema file's absolute path; it must not
    # reach the client, but it must still reach the log.
    assert str(pdf_svc.schema_path(doc_id)) not in data["save_error"]
    assert str(pdf_svc.schema_path(doc_id)) in caplog.text
    assert _rationalized_tables() == []


def test_extract_saves_to_documents_schema(monkeypatch):
    """Regression test for the PREVIEW_DIR path escape: extraction writes its
    JSON under PREVIEW_DIR and then ingests it via DuckDB, which only allows
    reads under the session data directory."""
    client.post("/session/reset")
    doc_id = _upload()
    _mock_extract(monkeypatch, {"document": {"pages": []}})
    resp = client.post(f"/pdf/extract/{doc_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["images"] == []
    assert data["page_images"] == []
    datasets = client.get("/datasets").json()["datasets"]
    doc_tables = [d["table"] for d in datasets if d["schema_name"] == "documents"]
    assert len(doc_tables) == 1
    assert doc_tables[0].endswith("documents.invoice_2024")


def test_model_list_error_does_not_leak_the_exception_text(monkeypatch, caplog):
    sentinel = "/srv/secret-dir/credentials.json"

    def fail():
        raise RuntimeError(f"could not load {sentinel}")

    monkeypatch.setattr(pdf_svc, "get_gemini_models", fail)

    with caplog.at_level(logging.ERROR, logger="app.error_reporting"):
        resp = client.get("/pdf/gemini-models")

    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert sentinel not in detail
    assert detail == "Could not list Gemini models. (RuntimeError)"
    assert sentinel in caplog.text


def test_pdf_upload_error_does_not_leak_the_exception_text(monkeypatch, caplog):
    sentinel = "/secret/server/path/file.csv"

    def fail(filename, contents):
        raise ValueError(f"failed save_upload for {sentinel}")

    monkeypatch.setattr(pdf_svc, "save_upload", fail)

    with caplog.at_level(logging.ERROR, logger="app.error_reporting"):
        resp = client.post(
            "/pdf/upload",
            files=[("file", ("Invoice.pdf", io.BytesIO(b"%PDF-1.4 fake"), "application/pdf"))],
        )

    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert sentinel not in resp.text
    assert sentinel not in detail
    assert detail == "Could not save the uploaded PDF. (ValueError)"
    assert sentinel in caplog.text


def test_pdf_extract_error_does_not_leak_the_exception_text(monkeypatch, caplog):
    client.post("/session/reset")
    doc_id = _upload()

    sentinel = "/secret/server/path/file.csv"

    def fail(doc_id):
        raise ValueError(f"failed extract_pdf for {sentinel}")

    monkeypatch.setattr(pdf_svc, "extract_pdf", fail)

    with caplog.at_level(logging.ERROR, logger="app.error_reporting"):
        resp = client.post(f"/pdf/extract/{doc_id}")

    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert sentinel not in resp.text
    assert sentinel not in detail
    assert detail == "Extraction failed. (ValueError)"
    assert sentinel in caplog.text


def test_pdf_rationalize_error_does_not_leak_the_exception_text(monkeypatch, caplog):
    client.post("/session/reset")
    doc_id = _upload()

    sentinel = "/secret/server/path/file.csv"

    def fail(*args, **kwargs):
        raise ValueError(f"failed rationalize for {sentinel}")

    monkeypatch.setattr(pdf_svc, "rationalize", fail)

    with caplog.at_level(logging.ERROR, logger="app.error_reporting"):
        resp = client.post(f"/pdf/rationalize/{doc_id}", json=BODY)

    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert sentinel not in resp.text
    assert sentinel not in detail
    assert detail == "Rationalization failed. (ValueError)"
    assert sentinel in caplog.text


def test_get_ollama_models_error_does_not_leak_the_exception_text(monkeypatch, caplog):
    sentinel = "/secret/server/path/file.csv"

    def fail():
        raise ValueError(f"failed get_ollama_models for {sentinel}")

    monkeypatch.setattr(pdf_svc, "get_ollama_models", fail)

    with caplog.at_level(logging.ERROR, logger="app.error_reporting"):
        resp = client.get("/pdf/ollama-models")

    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert sentinel not in resp.text
    assert sentinel not in detail
    assert detail == "Could not list Ollama models. (ValueError)"
    assert sentinel in caplog.text
