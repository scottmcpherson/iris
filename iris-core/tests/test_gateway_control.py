from __future__ import annotations

import os
import subprocess

import pytest
from fastapi.testclient import TestClient

from hermes_management_server.main import Settings, create_app
from hermes_management_server.runtime_adapters.hermes import HermesRuntimeAdapter, local_runtime_config, probe_endpoint
from hermes_management_server.security import ManagementError


def test_gateway_control_constructs_safe_argv_and_env(tmp_path, monkeypatch):
    calls = []
    hermes_home = tmp_path / ".hermes"
    adapter = HermesRuntimeAdapter(local_runtime_config(), hermes_home=hermes_home)

    monkeypatch.setattr("hermes_management_server.runtime_adapters.hermes.shutil.which", lambda name: "/usr/local/bin/hermes" if name == "hermes" else "")

    def fake_run(argv, **kwargs):
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0, stdout="started", stderr="")

    monkeypatch.setattr("hermes_management_server.runtime_adapters.hermes.subprocess.run", fake_run)

    result = adapter.gateway_control("research", "start")

    assert result["ok"] is True
    assert calls[0][0] == ["/usr/local/bin/hermes", "--profile", "research", "gateway", "start"]
    assert calls[0][1]["shell"] is False
    assert calls[0][1]["capture_output"] is True
    assert calls[0][1]["text"] is True
    assert calls[0][1]["env"]["HERMES_HOME"] == os.fspath(hermes_home)


def test_gateway_control_rejects_unknown_action(tmp_path):
    adapter = HermesRuntimeAdapter(local_runtime_config(), hermes_home=tmp_path / ".hermes")

    result = adapter.gateway_control("default", "start --all")

    assert result["ok"] is False
    assert "Unsupported" in result["error"]


def test_gateway_control_rejects_unsafe_profile(tmp_path):
    adapter = HermesRuntimeAdapter(local_runtime_config(), hermes_home=tmp_path / ".hermes")

    with pytest.raises(ManagementError):
        adapter.gateway_control("../bad", "start")


def test_gateway_control_reports_missing_cli(tmp_path, monkeypatch):
    adapter = HermesRuntimeAdapter(local_runtime_config(), hermes_home=tmp_path / ".hermes")
    monkeypatch.setattr("hermes_management_server.runtime_adapters.hermes.shutil.which", lambda _name: None)

    result = adapter.gateway_control("default", "status")

    assert result["ok"] is False
    assert result["status"] is None
    assert "Hermes CLI was not found" in result["error"]


def test_gateway_control_reports_timeout(tmp_path, monkeypatch):
    adapter = HermesRuntimeAdapter(local_runtime_config(), hermes_home=tmp_path / ".hermes")
    monkeypatch.setattr("hermes_management_server.runtime_adapters.hermes.shutil.which", lambda _name: "/usr/local/bin/hermes")

    def fake_run(argv, **_kwargs):
        raise subprocess.TimeoutExpired(argv, 25, output="partial", stderr="slow")

    monkeypatch.setattr("hermes_management_server.runtime_adapters.hermes.subprocess.run", fake_run)

    result = adapter.gateway_control("default", "restart")

    assert result["ok"] is False
    assert result["status"] is None
    assert "timed out" in result["error"]
    assert result["stdout"] == "partial"
    assert result["stderr"] == "slow"


def test_install_hermes_plugin_endpoint_invokes_local_installer(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    root.mkdir()
    app = create_app(Settings(hermes_home=str(root), core_store_path=str(tmp_path / "core.sqlite3")))
    client = TestClient(app)

    captured = {}

    def fake_install(hermes_home, *, host, port, token, inbound_port):
        captured["args"] = {
            "hermes_home": hermes_home,
            "host": host,
            "port": port,
            "token": token,
            "inbound_port": inbound_port,
        }
        return {
            "ok": True,
            "hermesHome": hermes_home,
            "pluginPath": f"{hermes_home}/plugins/iris-platform",
            "enabled": True,
            "enableError": "",
            "restartRequired": True,
        }

    monkeypatch.setattr("hermes_management_server.main.install_hermes_plugin", fake_install)

    response = client.post("/v1/system/install-hermes-plugin")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["restartRequired"] is True
    assert captured["args"]["hermes_home"].endswith(".hermes")


def test_install_hermes_plugin_endpoint_returns_error_for_failed_install(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    root.mkdir()
    app = create_app(Settings(hermes_home=str(root), core_store_path=str(tmp_path / "core.sqlite3")))
    client = TestClient(app)

    def fake_install(hermes_home, *, host, port, token, inbound_port):
        raise SystemExit("Bundled iris-platform payload was not found")

    monkeypatch.setattr("hermes_management_server.main.install_hermes_plugin", fake_install)

    response = client.post("/v1/system/install-hermes-plugin")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert "iris-platform payload" in body["error"]


def test_install_hermes_plugin_endpoint_installs_profile_homes(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    (root / "profiles" / "health").mkdir(parents=True)
    (root / "profiles" / "research").mkdir(parents=True)
    app = create_app(Settings(hermes_home=str(root), core_store_path=str(tmp_path / "core.sqlite3")))
    client = TestClient(app)

    homes = []

    ports = []

    def fake_install(hermes_home, *, host, port, token, inbound_port):
        homes.append(hermes_home)
        ports.append(inbound_port)
        return {
            "ok": True,
            "hermesHome": hermes_home,
            "pluginPath": f"{hermes_home}/plugins/iris-platform",
            "enabled": True,
            "enableError": "",
            "restartRequired": True,
        }

    monkeypatch.setattr("hermes_management_server.main.install_hermes_plugin", fake_install)

    response = client.post("/v1/system/install-hermes-plugin")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["enabled"] is True
    assert homes == [
        os.fspath(root),
        os.fspath(root / "profiles" / "health"),
        os.fspath(root / "profiles" / "research"),
    ]
    assert ports == [8766, 8767, 8768]
    assert [item["hermesHome"] for item in body["installations"]] == homes


def test_agent_gateway_route_resolves_profile_and_returns_fresh_probe(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    (root / "profiles" / "research").mkdir(parents=True)
    app = create_app(Settings(hermes_home=str(root), core_store_path=str(tmp_path / "core.sqlite3")))
    client = TestClient(app)
    agent = next(agent for agent in client.get("/v1/agents").json()["agents"] if agent["runtimeProfile"] == "research")

    calls = []

    def fake_gateway_control(runtime_id, profile, action):
        calls.append((runtime_id, profile, action))
        return {"ok": True, "stdout": "started", "stderr": "", "status": 0}

    def fake_probe(runtime_id, profile="default"):
        return {
            "gateway": {"ok": True, "url": "http://127.0.0.1:8642"},
            "irisAdapter": {"ok": True, "url": "http://127.0.0.1:8766/health", "profile": profile},
            "management": {"ok": True, "url": "http://127.0.0.1:8765/health"},
        }

    monkeypatch.setattr(app.state.runtime_registry, "gateway_control", fake_gateway_control)
    monkeypatch.setattr(app.state.runtime_registry, "probe", fake_probe)

    response = client.post(f"/v1/agents/{agent['id']}/gateway/start")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["profile"] == "research"
    assert body["action"] == "start"
    assert body["probe"]["irisAdapter"]["ok"] is True
    assert calls == [(agent["runtimeId"], "research", "start")]


def test_agent_gateway_status_route_resolves_profile_and_returns_fresh_probe(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    (root / "profiles" / "health").mkdir(parents=True)
    app = create_app(Settings(hermes_home=str(root), core_store_path=str(tmp_path / "core.sqlite3")))
    client = TestClient(app)
    agent = next(agent for agent in client.get("/v1/agents").json()["agents"] if agent["runtimeProfile"] == "health")

    calls = []

    def fake_gateway_status(runtime_id, profile):
        calls.append((runtime_id, profile))
        return {"ok": True, "stdout": "running", "stderr": "", "status": 0}

    def fake_probe(runtime_id, profile="default"):
        return {
            "gateway": {"ok": True, "url": "http://127.0.0.1:8642"},
            "irisAdapter": {"ok": True, "url": "http://127.0.0.1:8767/health", "profile": profile},
            "management": {"ok": True, "url": "http://127.0.0.1:8765/health"},
        }

    monkeypatch.setattr(app.state.runtime_registry, "gateway_status", fake_gateway_status)
    monkeypatch.setattr(app.state.runtime_registry, "probe", fake_probe)

    response = client.get(f"/v1/agents/{agent['id']}/gateway/status")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["profile"] == "health"
    assert body["action"] == "status"
    assert body["command"]["stdout"] == "running"
    assert body["probe"]["irisAdapter"]["profile"] == "health"
    assert calls == [(agent["runtimeId"], "health")]


def test_adapter_probe_rejects_mismatched_profile(monkeypatch):
    class FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, _exc_type, _exc, _traceback):
            return False

        def read(self, _size):
            return b'{"ok": true, "profile": "default"}'

    monkeypatch.setattr("hermes_management_server.runtime_adapters.hermes.urllib.request.urlopen", lambda *_args, **_kwargs: FakeResponse())

    result = probe_endpoint("http://127.0.0.1:8766/health", expected_profile="health")

    assert result["ok"] is False
    assert result["profile"] == "default"
    assert "not 'health'" in result["error"]


def test_iris_gateway_url_derives_profile_port(tmp_path):
    root = tmp_path / ".hermes"
    (root / "profiles" / "health").mkdir(parents=True)
    (root / "profiles" / "research").mkdir(parents=True)
    adapter = HermesRuntimeAdapter(local_runtime_config(), hermes_home=root)

    assert adapter.iris_gateway_url("default") == "http://127.0.0.1:8766"
    assert adapter.iris_gateway_url("health") == "http://127.0.0.1:8767"
    assert adapter.iris_gateway_url("research") == "http://127.0.0.1:8768"
