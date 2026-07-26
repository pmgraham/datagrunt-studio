from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_cross_site_mutation_is_rejected():
    resp = client.post(
        "/session/reset",
        headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"},
    )
    assert resp.status_code == 403
    assert "cross-site" in resp.json()["detail"].lower()


def test_same_origin_mutation_is_allowed():
    resp = client.post(
        "/session/reset",
        headers={"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"},
    )
    assert resp.status_code == 200


def test_direct_navigation_to_a_mutation_is_rejected():
    resp = client.post("/session/reset", headers={"Sec-Fetch-Site": "none"})
    assert resp.status_code == 403


def test_headerless_request_is_allowed():
    # The Next.js proxy, scripts/smoke.sh and the rest of this suite send no
    # browser headers. CSRF is browser-mediated, so there is nothing to forge.
    assert client.post("/session/reset").status_code == 200


def test_safe_methods_are_never_blocked():
    resp = client.get(
        "/datasets",
        headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"},
    )
    assert resp.status_code == 200
