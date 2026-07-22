"""Unit tests for pdf_service Ollama connectivity.

These pin the OLLAMA_HOST environment contract that the container configs
(docker-compose.yml and the Makefile's Apple Container recipe) rely on to
point the backend at a host-side Ollama daemon.
"""

import app.pdf_service as pdf_svc


class _FakeResponse:
    def __init__(self, payload: dict):
        self._payload = payload
        self.status_code = 200

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return self._payload


def test_call_ollama_honors_ollama_host_env(monkeypatch):
    seen = {}

    def fake_post(url, json, timeout):
        seen["url"] = url
        return _FakeResponse({"response": "{}"})

    monkeypatch.setenv("OLLAMA_HOST", "http://host.docker.internal:11434/")
    monkeypatch.setattr(pdf_svc.requests, "post", fake_post)

    pdf_svc._call_ollama("llama3", "system", "prompt", [])

    assert seen["url"] == "http://host.docker.internal:11434/api/generate"


def test_call_ollama_defaults_to_localhost(monkeypatch):
    seen = {}

    def fake_post(url, json, timeout):
        seen["url"] = url
        return _FakeResponse({"response": "{}"})

    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    monkeypatch.setattr(pdf_svc.requests, "post", fake_post)

    pdf_svc._call_ollama("llama3", "system", "prompt", [])

    assert seen["url"] == "http://localhost:11434/api/generate"


def test_get_ollama_models_honors_ollama_host_env(monkeypatch):
    seen = {}

    def fake_get(url, timeout):
        seen["url"] = url
        return _FakeResponse({"models": [{"name": "llama3"}]})

    monkeypatch.setenv("OLLAMA_HOST", "http://192.168.64.1:11434")
    monkeypatch.setattr(pdf_svc.requests, "get", fake_get)

    result = pdf_svc.get_ollama_models()

    assert seen["url"] == "http://192.168.64.1:11434/api/tags"
    assert result == {"models": ["llama3"], "active": True}
