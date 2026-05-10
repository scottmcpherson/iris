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


def test_device_pairing_token_auth_and_revocation(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), token="admin-token"))
    client = TestClient(app)
    admin_headers = {"Authorization": "Bearer admin-token"}

    paired = client.post(
        "/v1/devices/pair",
        json={
            "name": "Scott's MacBook",
            "kind": "desktop",
            "metadata": {
                "tailnet": "test",
                "tokenHash": "must-not-persist",
                "nested": {"accessToken": "also-blocked", "label": "ok"},
            },
        },
        headers=admin_headers,
    )
    payload = paired.json()
    token = payload["token"]
    device_id = payload["device"]["id"]

    assert paired.status_code == 200
    assert token.startswith("agui_")
    assert payload["tokenShownOnce"] is True
    assert "tokenHash" not in payload["device"]
    assert payload["device"]["name"] == "Scott's MacBook"
    assert payload["device"]["metadata"] == {"nested": {"label": "ok"}, "tailnet": "test"}
    with app.state.core_store.connect() as connection:
        stored = connection.execute("select token_hash from devices where id = ?", (device_id,)).fetchone()
    assert stored["token_hash"].startswith("v1:")

    device_headers = {"Authorization": f"Bearer {token}"}
    health = client.get("/v1/health", headers=device_headers)
    current = client.get("/v1/devices/me", headers=device_headers)
    cursor = client.post(
        "/v1/devices/me/cursors",
        json={"streamName": "global", "lastCursor": 42},
        headers=device_headers,
    )
    devices = client.get("/v1/devices", headers=admin_headers).json()["devices"]

    assert health.status_code == 200
    assert current.json()["device"]["id"] == device_id
    assert cursor.json()["cursor"]["lastCursor"] == 42
    assert next(device for device in devices if device["id"] == device_id)["lastSeenAt"] is not None

    revoked = client.delete(f"/v1/devices/{device_id}", headers=admin_headers)
    blocked = client.get("/v1/health", headers=device_headers)

    assert revoked.status_code == 200
    assert revoked.json()["device"]["revokedAt"] is not None
    assert blocked.status_code == 401
    assert blocked.json() == {"ok": False, "error": "Bearer token is invalid."}


def test_non_loopback_bind_requires_bearer_auth(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), host="0.0.0.0"))
    client = TestClient(app)

    missing = client.get("/health")
    invalid = client.get("/health", headers={"Authorization": "Bearer nope"})
    status = client.get("/v1/status", headers={"Authorization": "Bearer nope"})

    assert missing.status_code == 401
    assert missing.json() == {"ok": False, "error": "Bearer token is required."}
    assert invalid.status_code == 401
    assert status.status_code == 401
