from __future__ import annotations

import hashlib

from fastapi.testclient import TestClient

from hermes_management_server.main import Settings, create_app
from hermes_management_server.security import device_token_hash


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


def test_non_loopback_bind_allows_loopback_client_without_token(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), host="0.0.0.0"))
    client = TestClient(app, client=("127.0.0.1", 48123))

    response = client.post(
        "/v1/mobile/pairing-codes",
        json={"hostLabel": "Mac mini", "coreUrl": "http://100.110.38.56:8765/v1"},
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_non_loopback_bind_accepts_valid_iris_token(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), host="0.0.0.0", token="secret-token"))
    client = TestClient(app)

    valid = client.get("/health", headers={"Authorization": "Bearer secret-token"})

    assert valid.status_code == 200
    assert valid.json()["ok"] is True


def test_mobile_pairing_redeems_phone_generated_device_token_hash(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), host="0.0.0.0", token="admin-token"))
    client = TestClient(app)
    admin_headers = {"Authorization": "Bearer admin-token"}
    raw_token = "iris_mobile_test-token"
    pairing = client.post(
        "/v1/mobile/pairing-codes",
        json={"hostLabel": "Mac mini", "coreUrl": "http://100.110.38.56:8765"},
        headers=admin_headers,
    )

    assert pairing.status_code == 200
    redeem = client.post(
        "/v1/mobile/pair",
        json={
            "code": pairing.json()["code"],
            "deviceName": "Scott's iPhone",
            "deviceTokenHash": device_token_hash(raw_token),
        },
    )
    health = client.get("/v1/health", headers={"Authorization": f"Bearer {raw_token}"})
    replay = client.post(
        "/v1/mobile/pair",
        json={
            "code": pairing.json()["code"],
            "deviceName": "Replay",
            "deviceTokenHash": device_token_hash("iris_mobile_replay"),
        },
    )

    assert redeem.status_code == 200
    assert redeem.json()["device"]["kind"] == "mobile"
    assert health.status_code == 200
    assert health.json()["ok"] is True
    assert replay.status_code == 401


def test_legacy_device_tokens_with_old_prefix_are_rejected(tmp_path):
    app = create_app(Settings(hermes_home=str(tmp_path / ".hermes"), host="0.0.0.0", token="admin-token"))
    client = TestClient(app)
    raw_token = "agui_legacy-token"
    old_hash = "v1:" + hashlib.sha256(f"iris-core-device-token:v1:{raw_token}".encode("utf-8")).hexdigest()
    app.state.core_store.create_device(name="Legacy desktop", kind="desktop", token_hash=old_hash)

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
