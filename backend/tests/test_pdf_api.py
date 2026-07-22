"""Endpoint tests for rationalized-output persistence.

The LLM call is monkeypatched — these tests cover the save path only
(spec: docs/superpowers/specs/2026-07-14-raw-rationalized-datasets-design.md).
"""

import io
import json

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


def test_uningestable_json_returns_unsaved(monkeypatch):
    client.post("/session/reset")
    doc_id = _upload()
    # `NaN` is accepted by Python's json.loads (a non-standard but long-standing
    # extension), so json.loads succeeds. DuckDB's read_json_auto parses a bare
    # scalar array with its stricter, standards-compliant JSON parser and rejects
    # the NaN token as malformed JSON, so ingestion raises.
    _mock_rationalize(monkeypatch, "[1, NaN]")
    resp = client.post(f"/pdf/rationalize/{doc_id}", json=BODY)
    assert resp.status_code == 200
    data = resp.json()
    assert data["saved"] is False
    assert data["dataset"] is None
    assert "Could not ingest" in data["save_error"]
    assert _rationalized_tables() == []
