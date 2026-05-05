from __future__ import annotations

from fastapi.testclient import TestClient

from hermes_management_server.main import Settings, create_app


def test_token_auth_blocks_missing_and_invalid_token(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), token="secret-token"))
    client = TestClient(app)

    missing = client.get("/health")
    invalid = client.get("/health", headers={"Authorization": "Bearer nope"})
    valid = client.get("/health", headers={"Authorization": "Bearer secret-token"})

    assert missing.status_code == 401
    assert missing.json() == {"ok": False, "error": "Bearer token is required."}
    assert invalid.status_code == 401
    assert invalid.json() == {"ok": False, "error": "Bearer token is invalid."}
    assert valid.status_code == 200
    assert valid.json()["ok"] is True


def test_auth_is_disabled_without_token(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes")))
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["ok"] is True
