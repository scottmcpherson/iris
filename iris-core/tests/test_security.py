from __future__ import annotations

import hashlib

from fastapi.testclient import TestClient

from hermes_management_server.main import Settings, create_app


def test_loopback_core_allows_missing_auth_without_token(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), host="127.0.0.1"))
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_loopback_core_allows_missing_auth_with_stale_iris_token(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), token="secret-token"))
    client = TestClient(app)

    missing = client.get("/health")
    invalid = client.get("/health", headers={"Authorization": "Bearer nope"})
    valid = client.get("/health", headers={"Authorization": "Bearer secret-token"})

    assert missing.status_code == 200
    assert invalid.status_code == 200
    assert valid.status_code == 200
    assert missing.json()["ok"] is True
    assert invalid.json()["ok"] is True
    assert valid.json()["ok"] is True


def test_non_loopback_bind_without_token_requires_bearer_auth(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), host="0.0.0.0"))
    client = TestClient(app)

    missing = client.get("/health")
    invalid = client.get("/health", headers={"Authorization": "Bearer nope"})

    assert missing.status_code == 401
    assert missing.json() == {"ok": False, "error": "Bearer token is required."}
    assert invalid.status_code == 401
    assert invalid.json() == {"ok": False, "error": "Bearer token is invalid."}


def test_non_loopback_bind_accepts_valid_iris_token(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), host="0.0.0.0", token="secret-token"))
    client = TestClient(app)

    valid = client.get("/health", headers={"Authorization": "Bearer secret-token"})

    assert valid.status_code == 200
    assert valid.json()["ok"] is True


def test_device_pairing_routes_are_removed_and_device_tokens_are_rejected(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), host="0.0.0.0", token="admin-token"))
    client = TestClient(app)
    admin_headers = {"Authorization": "Bearer admin-token"}
    raw_token = "agui_legacy-token"
    old_hash = "v1:" + hashlib.sha256(f"iris-core-device-token:v1:{raw_token}".encode("utf-8")).hexdigest()
    app.state.core_store.create_device(name="Legacy desktop", kind="desktop", token_hash=old_hash)

    assert client.get("/v1/devices", headers=admin_headers).status_code == 404
    assert client.get("/v1/devices/me", headers=admin_headers).status_code == 404
    assert client.post("/v1/devices/pair", json={}, headers=admin_headers).status_code == 404
    assert client.delete("/v1/devices/dev_legacy", headers=admin_headers).status_code == 404
    assert client.post("/v1/devices/me/cursors", json={"streamName": "global", "lastCursor": 42}, headers=admin_headers).status_code == 404

    blocked = client.get("/v1/health", headers={"Authorization": f"Bearer {raw_token}"})

    assert blocked.status_code == 401
    assert blocked.json() == {"ok": False, "error": "Bearer token is invalid."}


def test_non_loopback_bind_requires_configured_bearer_auth(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), host="0.0.0.0", token="secret-token"))
    client = TestClient(app)

    missing = client.get("/health")
    invalid = client.get("/health", headers={"Authorization": "Bearer nope"})
    status = client.get("/v1/status", headers={"Authorization": "Bearer nope"})

    assert missing.status_code == 401
    assert missing.json() == {"ok": False, "error": "Bearer token is required."}
    assert invalid.status_code == 401
    assert status.status_code == 401
