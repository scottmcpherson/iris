from __future__ import annotations

import importlib
import asyncio
import json
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest


@dataclass
class FakeSendResult:
    success: bool
    error: str | None = None
    retryable: bool = False
    message_id: str | None = None
    raw_response: dict[str, Any] | None = None


def load_adapter_module(monkeypatch: pytest.MonkeyPatch):
    gateway = types.ModuleType("gateway")
    gateway_config = types.ModuleType("gateway.config")
    gateway_platforms = types.ModuleType("gateway.platforms")
    gateway_platforms_base = types.ModuleType("gateway.platforms.base")
    gateway_session = types.ModuleType("gateway.session")

    class FakePlatform(str):
        pass

    class FakeBasePlatformAdapter:
        def __init__(self, *, config, platform):
            self.config = config
            self.platform = platform
            self.connected = False
            self.fatal_error = None

        def _set_fatal_error(self, code, message, retryable):
            self.fatal_error = {"code": code, "message": message, "retryable": retryable}

        def _mark_connected(self):
            self.connected = True

        def _mark_disconnected(self):
            self.connected = False

    class FakeMessageType:
        TEXT = "text"
        VOICE = "voice"
        PHOTO = "photo"
        VIDEO = "video"
        DOCUMENT = "document"

    @dataclass
    class FakeMessageEvent:
        text: str
        message_type: str
        source: Any
        raw_message: dict[str, Any]
        message_id: str
        media_urls: list[str]
        media_types: list[str]
        channel_prompt: str | None = None

    @dataclass
    class FakeSessionSource:
        platform: Any
        chat_id: str
        chat_name: str
        chat_type: str
        user_id: str
        user_name: str

    gateway_config.Platform = FakePlatform
    gateway_platforms_base.BasePlatformAdapter = FakeBasePlatformAdapter
    gateway_platforms_base.MessageEvent = FakeMessageEvent
    gateway_platforms_base.MessageType = FakeMessageType
    gateway_platforms_base.SendResult = FakeSendResult
    gateway_platforms_base.cache_audio_from_bytes = lambda *args, **kwargs: "/tmp/audio"
    gateway_platforms_base.cache_document_from_bytes = lambda *args, **kwargs: "/tmp/document"
    gateway_platforms_base.cache_image_from_bytes = lambda *args, **kwargs: "/tmp/image"
    gateway_platforms_base.cache_video_from_bytes = lambda *args, **kwargs: "/tmp/video"
    gateway_session.SessionSource = FakeSessionSource

    monkeypatch.setitem(sys.modules, "gateway", gateway)
    monkeypatch.setitem(sys.modules, "gateway.config", gateway_config)
    monkeypatch.setitem(sys.modules, "gateway.platforms", gateway_platforms)
    monkeypatch.setitem(sys.modules, "gateway.platforms.base", gateway_platforms_base)
    monkeypatch.setitem(sys.modules, "gateway.session", gateway_session)

    platform_root = Path(__file__).resolve().parents[1]
    monkeypatch.syspath_prepend(str(platform_root))
    sys.modules.pop("adapter", None)
    sys.modules.pop("adapter_config", None)
    sys.modules.pop("attachments", None)
    sys.modules.pop("discovery", None)
    return importlib.import_module("adapter")


class Config:
    extra = {
        "base_url": "http://127.0.0.1:8765",
        "token": "secret-token",
    }


class LoopbackNoTokenConfig:
    extra = {
        "base_url": "http://127.0.0.1:8765",
    }


class RemoteNoTokenConfig:
    extra = {
        "base_url": "http://10.0.0.5:8765",
    }


def test_plugin_manifest_allows_loopback_without_iris_token():
    manifest = (Path(__file__).resolve().parents[1] / "plugin.yaml").read_text(encoding="utf-8")

    assert "IRIS_BASE_URL" in manifest
    assert "IRIS_TOKEN" not in manifest


class FakeInboundRequest:
    headers = {"Authorization": "Bearer secret-token"}


class FakeQueryRequest(FakeInboundRequest):
    def __init__(self, query: dict[str, str] | None = None):
        self.query = query or {}


class FakeJsonRequest(FakeInboundRequest):
    def __init__(self, payload: dict[str, Any]):
        self._payload = payload

    async def json(self):
        return self._payload


class FakeLoopbackRequest:
    headers: dict[str, str] = {}
    remote = "127.0.0.1"
    transport = None


@dataclass
class FakeWebResponse:
    status: int
    text: str


class FakeWeb:
    @staticmethod
    def json_response(body, status=200):
        return FakeWebResponse(status=status, text=json.dumps(body))


@dataclass
class FakeSession:
    session_id: str
    session_key: str = "source-key-1"


class FakeSessionStore:
    def __init__(self, session_id: str = "hermes-session-1"):
        self.session_id = session_id
        self.created_sources: list[Any] = []
        self.switched: list[tuple[str, str]] = []

    def get_or_create_session(self, source):
        self.created_sources.append(source)
        return FakeSession(self.session_id)

    def switch_session(self, session_key: str, target_session_id: str):
        self.switched.append((session_key, target_session_id))
        return FakeSession(target_session_id, session_key)


def call_inbound_message(adapter_module, monkeypatch: pytest.MonkeyPatch, adapter, payload: dict[str, Any]):
    if not adapter_module.AIOHTTP_AVAILABLE:
        monkeypatch.setattr(adapter_module, "web", FakeWeb)

    async def fake_payload_and_files(_request):
        return payload, {}

    async def fake_handle_message(_event):
        return None

    monkeypatch.setattr(adapter_module, "inbound_payload_and_files", fake_payload_and_files)
    adapter.handle_message = fake_handle_message
    response = asyncio.run(adapter._inbound_message(FakeInboundRequest()))
    return response.status, json.loads(response.text)


def test_validate_config_allows_loopback_without_token(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    monkeypatch.setattr(adapter_module, "HTTP_CLIENT_AVAILABLE", True)
    monkeypatch.delenv("IRIS_BASE_URL", raising=False)
    monkeypatch.delenv("IRIS_TOKEN", raising=False)

    assert adapter_module.validate_config(LoopbackNoTokenConfig()) is True


def test_validate_config_rejects_non_loopback_without_token(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    monkeypatch.setattr(adapter_module, "HTTP_CLIENT_AVAILABLE", True)
    monkeypatch.delenv("IRIS_BASE_URL", raising=False)
    monkeypatch.delenv("IRIS_TOKEN", raising=False)

    assert adapter_module.validate_config(RemoteNoTokenConfig()) is False


def test_check_requirements_uses_iris_base_url_and_loopback_token_policy(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    monkeypatch.setattr(adapter_module, "HTTP_CLIENT_AVAILABLE", True)
    monkeypatch.setenv("IRIS_BASE_URL", "http://127.0.0.1:8765")
    monkeypatch.delenv("IRIS_TOKEN", raising=False)

    assert adapter_module.check_requirements() is True

    monkeypatch.setenv("IRIS_BASE_URL", "http://10.0.0.5:8765")
    assert adapter_module.check_requirements() is False

    monkeypatch.setenv("IRIS_TOKEN", "secret-token")
    assert adapter_module.check_requirements() is True


def test_connect_probes_v1_health_and_allows_loopback_without_token(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    monkeypatch.setattr(adapter_module, "AIOHTTP_AVAILABLE", True)
    adapter = adapter_module.IrisPlatformAdapter(LoopbackNoTokenConfig())
    requests: list[tuple[str, str]] = []

    async def fake_request(method: str, path: str, body: dict[str, Any] | None = None):
        del body
        requests.append((method, path))
        return {"ok": True}

    async def fake_start_inbound_server():
        return None

    adapter._request = fake_request
    adapter._start_inbound_server = fake_start_inbound_server

    connected = asyncio.run(adapter.connect())

    assert connected is True
    assert adapter.connected is True
    assert requests == [("GET", "/v1/health")]


def test_inbound_auth_allows_loopback_when_token_is_unset(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(LoopbackNoTokenConfig())

    assert adapter._authorized(FakeLoopbackRequest()) is True


def test_inbound_message_reserves_and_returns_session_id(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(Config())
    store = FakeSessionStore("hermes-session-new")
    adapter._session_store = store

    status, body = call_inbound_message(
        adapter_module,
        monkeypatch,
        adapter,
        {
            "profile": "default",
            "chatId": "core-chat-1",
            "chatName": "Core chat",
            "messageId": "client-message-1",
            "text": "hello",
        },
    )

    assert status == 202
    assert body["accepted"] is True
    assert body["chatId"] == "core-chat-1"
    assert body["messageId"] == "client-message-1"
    assert body["sessionId"] == "hermes-session-new"
    assert store.created_sources[0].chat_id == "core-chat-1"


def test_inbound_message_returns_bound_legacy_session_id(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(Config())
    store = FakeSessionStore("temporary-session")
    adapter._session_store = store

    status, body = call_inbound_message(
        adapter_module,
        monkeypatch,
        adapter,
        {
            "profile": "default",
            "chatId": "core-chat-1",
            "sessionId": "legacy-session-1",
            "messageId": "client-message-1",
            "text": "hello",
        },
    )

    assert status == 202
    assert body["sessionId"] == "legacy-session-1"
    assert store.switched == [("source-key-1", "legacy-session-1")]


def test_inbound_message_accepts_without_session_store_and_warns(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(Config())

    status, body = call_inbound_message(
        adapter_module,
        monkeypatch,
        adapter,
        {
            "profile": "default",
            "chatId": "core-chat-1",
            "messageId": "client-message-1",
            "text": "hello",
        },
    )

    assert status == 202
    assert body["accepted"] is True
    assert "sessionId" not in body
    assert "session store is unavailable" in body["warning"]


def test_send_stream_preview_posts_delivery_payload(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(Config())
    requests: list[tuple[str, str, dict[str, Any] | None]] = []

    async def fake_request(method: str, path: str, body: dict[str, Any] | None = None):
        requests.append((method, path, body))
        return {"ok": True}

    adapter._request = fake_request

    result = asyncio.run(
        adapter.send(
            "chat-1",
            "partial response ▉",
            reply_to="user-1",
            metadata={"streamMessageId": "stream-1", "source": "hermes-gateway-stream"},
        )
    )

    assert result.success is True
    assert result.message_id == "stream-1"
    assert requests == [
        (
            "POST",
            "/v1/runtime-deliveries/hermes",
            {
                "runtimeId": "runtime_local_hermes",
                "profile": "default",
                "chatId": "chat-1",
                "messageId": "stream-1",
                "replyTo": "user-1",
                "source": "hermes-gateway-stream",
                "content": "partial response",
                "metadata": {
                    "replyTo": "user-1",
                    "streamMessageId": "stream-1",
                    "streaming": True,
                    "finalize": False,
                    "chunkProtocol": "v2-delta",
                    "chunkOperation": "append",
                    "deliveredAt": requests[0][2]["metadata"]["deliveredAt"],
                },
            },
        )
    ]


def test_send_cron_delivery_includes_session_context(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    session_context = types.ModuleType("gateway.session_context")
    values = {
        "HERMES_SESSION_KEY": "cron_abc123def456_20260512_102933",
        "HERMES_CRON_AUTO_DELIVER_PLATFORM": "iris",
        "HERMES_CRON_AUTO_DELIVER_CHAT_ID": "automation-chat_123",
        "HERMES_CRON_AUTO_DELIVER_THREAD_ID": "",
    }
    session_context.get_session_env = lambda name, default="": values.get(name, default)
    monkeypatch.setitem(sys.modules, "gateway.session_context", session_context)
    adapter = adapter_module.IrisPlatformAdapter(Config())
    requests: list[tuple[str, str, dict[str, Any] | None]] = []

    async def fake_request(method: str, path: str, body: dict[str, Any] | None = None):
        requests.append((method, path, body))
        return {"ok": True}

    adapter._request = fake_request

    result = asyncio.run(adapter.send("automation-chat_123", "Cronjob Response: Cook Rice\n(job_id: abc123def456)"))

    assert result.success is True
    metadata = requests[0][2]["metadata"]
    assert requests[0][2]["source"] == "hermes-cron"
    assert metadata["externalSessionId"] == "cron_abc123def456_20260512_102933"
    assert metadata["hermesSessionId"] == "cron_abc123def456_20260512_102933"
    assert metadata["cronDeliveryPlatform"] == "iris"
    assert metadata["cronDeliveryChatId"] == "automation-chat_123"


def test_send_returns_retryable_failure_from_delivery_error(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(Config())

    async def fake_request(_method: str, _path: str, _body: dict[str, Any] | None = None):
        return {"ok": False, "error": "Core unavailable", "retryable": True}

    adapter._request = fake_request

    result = asyncio.run(adapter.send("chat-1", "hello"))

    assert result.success is False
    assert result.error == "Core unavailable"
    assert result.retryable is True


def test_edit_message_requires_stream_message_id(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(Config())

    result = asyncio.run(adapter.edit_message("chat-1", "", "content"))

    assert result.success is False
    assert result.error == "Iris stream message id is required"


def test_edit_message_posts_delta_protocol_chunks(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(Config())
    requests: list[dict[str, Any]] = []

    async def fake_request(_method: str, _path: str, body: dict[str, Any] | None = None):
        requests.append(body or {})
        return {"ok": True}

    adapter._request = fake_request

    first = asyncio.run(
        adapter.edit_message(
            "chat-1",
            "stream-1",
            "Hello",
            metadata={"clientRequestId": "client-1"},
        )
    )
    second = asyncio.run(adapter.edit_message("chat-1", "stream-1", "Hello world", finalize=True))

    assert first.success is True
    assert second.success is True
    assert [request["content"] for request in requests] == ["Hello", " world"]
    assert requests[0]["metadata"]["chunkProtocol"] == "v2-delta"
    assert requests[0]["metadata"]["chunkOperation"] == "append"
    assert requests[1]["metadata"]["finalize"] is True
    assert requests[1]["metadata"]["clientRequestId"] == "client-1"


def test_edit_message_marks_non_monotonic_content_as_replace(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(Config())
    requests: list[dict[str, Any]] = []

    async def fake_request(_method: str, _path: str, body: dict[str, Any] | None = None):
        requests.append(body or {})
        return {"ok": True}

    adapter._request = fake_request

    asyncio.run(adapter.edit_message("chat-1", "stream-1", "Hello world", metadata={"clientRequestId": "client-1"}))
    result = asyncio.run(adapter.edit_message("chat-1", "stream-1", "Goodbye", finalize=True))

    assert result.success is True
    assert requests[1]["content"] == "Goodbye"
    assert requests[1]["metadata"]["chunkOperation"] == "replace"
    assert requests[1]["metadata"]["clientRequestId"] == "client-1"


def test_stream_state_is_pruned_and_finalize_cleans_active_request(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(Config())

    async def fake_request(_method: str, _path: str, _body: dict[str, Any] | None = None):
        return {"ok": True}

    adapter._request = fake_request
    asyncio.run(adapter.edit_message("chat-1", "stream-1", "Hello", metadata={"clientRequestId": "client-1"}))
    asyncio.run(adapter.edit_message("chat-1", "stream-1", "Hello", finalize=True))

    assert "stream-1" not in adapter._stream_last_sent_content
    assert "client-1" not in adapter._active_streams_by_client_request_id
    assert "chat-1" not in adapter._active_client_request_ids_by_chat

    adapter._stream_last_sent_content["stale-stream"] = "partial"
    adapter._stream_last_sent_lengths["stale-stream"] = 7
    adapter._stream_client_request_ids["stale-stream"] = "stale-client"
    adapter._active_streams_by_client_request_id["stale-client"] = ("chat-1", "stale-stream")
    adapter._stream_state_updated_at["stale-stream"] = 0
    adapter._stream_terminal_sent.add("stale-terminal")
    adapter._stream_terminal_sent_at["stale-terminal"] = 0
    adapter._active_client_request_ids_by_chat["stale-chat"] = "stale-client"
    adapter._active_client_request_id_updated_at["stale-chat"] = 0

    adapter._prune_stream_state()

    assert "stale-stream" not in adapter._stream_last_sent_content
    assert "stale-client" not in adapter._active_streams_by_client_request_id
    assert "stale-terminal" not in adapter._stream_terminal_sent
    assert "stale-chat" not in adapter._active_client_request_ids_by_chat


def test_inbound_task_failure_emits_terminal_stream_error(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(Config())
    requests: list[dict[str, Any]] = []

    async def fake_payload_and_files(_request):
        return {
            "profile": "default",
            "chatId": "core-chat-1",
            "messageId": "client-message-1",
            "text": "hello",
        }, {}

    async def fake_request(_method: str, _path: str, body: dict[str, Any] | None = None):
        requests.append(body or {})
        return {"ok": True}

    async def fake_handle_message(_event):
        adapter._stream_client_request_ids["stream-1"] = "client-message-1"
        adapter._active_streams_by_client_request_id["client-message-1"] = ("core-chat-1", "stream-1")
        adapter._touch_stream_state("stream-1")
        raise RuntimeError("model crashed")

    async def run():
        if not adapter_module.AIOHTTP_AVAILABLE:
            monkeypatch.setattr(adapter_module, "web", FakeWeb)
        monkeypatch.setattr(adapter_module, "inbound_payload_and_files", fake_payload_and_files)
        adapter._request = fake_request
        adapter.handle_message = fake_handle_message
        response = await adapter._inbound_message(FakeInboundRequest())
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        return response

    response = asyncio.run(run())

    assert response.status == 202
    assert requests[-1]["source"] == "hermes-error"
    assert requests[-1]["metadata"]["clientRequestId"] == "client-message-1"
    assert requests[-1]["metadata"]["streamMessageId"] == "stream-1"
    assert requests[-1]["metadata"]["finalize"] is True


def test_inbound_models_clamps_limit_and_returns_catalog(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(Config())
    if not adapter_module.AIOHTTP_AVAILABLE:
        monkeypatch.setattr(adapter_module, "web", FakeWeb)

    gateway_run = types.ModuleType("gateway.run")
    hermes_cli = types.ModuleType("hermes_cli")
    hermes_cli_config = types.ModuleType("hermes_cli.config")
    hermes_cli_model_switch = types.ModuleType("hermes_cli.model_switch")
    hermes_cli_providers = types.ModuleType("hermes_cli.providers")
    observed: dict[str, Any] = {}

    def fake_list_authenticated_providers(**kwargs):
        observed.update(kwargs)
        return [
            {
                "slug": "openrouter",
                "name": "OpenRouter",
                "models": ["gpt-5.5"],
                "totalModels": 1,
                "isCurrent": True,
                "source": "configured",
            }
        ]

    gateway_run._load_gateway_config = lambda: {"model": {"provider": "openrouter", "model": "gpt-5.5"}}
    hermes_cli_config.get_compatible_custom_providers = lambda _cfg: []
    hermes_cli_model_switch.list_authenticated_providers = fake_list_authenticated_providers
    hermes_cli_providers.get_label = lambda provider: provider.title()
    monkeypatch.setitem(sys.modules, "gateway.run", gateway_run)
    monkeypatch.setitem(sys.modules, "hermes_cli", hermes_cli)
    monkeypatch.setitem(sys.modules, "hermes_cli.config", hermes_cli_config)
    monkeypatch.setitem(sys.modules, "hermes_cli.model_switch", hermes_cli_model_switch)
    monkeypatch.setitem(sys.modules, "hermes_cli.providers", hermes_cli_providers)

    response = asyncio.run(adapter._inbound_models(FakeQueryRequest({"maxModels": "999"})))
    body = json.loads(response.text)

    assert response.status == 200
    assert body["ok"] is True
    assert body["current"]["model"] == "gpt-5.5"
    assert body["providers"][0]["slug"] == "openrouter"
    assert observed["max_models"] == 200


def test_inbound_slash_complete_uses_imported_clamp_limit(monkeypatch: pytest.MonkeyPatch):
    adapter_module = load_adapter_module(monkeypatch)
    adapter = adapter_module.IrisPlatformAdapter(Config())
    if not adapter_module.AIOHTTP_AVAILABLE:
        monkeypatch.setattr(adapter_module, "web", FakeWeb)

    commands = [
        {
            "text": f"/command-{index}",
            "label": f"command-{index}",
            "description": "",
            "category": "Commands",
        }
        for index in range(150)
    ]
    monkeypatch.setattr(adapter_module, "discover_slash_commands", lambda _profile: {"ok": True, "commands": commands})

    response = asyncio.run(adapter._inbound_slash_complete(FakeJsonRequest({"text": "/", "limit": "1"})))
    body = json.loads(response.text)

    assert response.status == 200
    assert body["ok"] is True
    assert len(body["items"]) == 1


def test_discovery_preserves_keyed_command_registry_names(monkeypatch: pytest.MonkeyPatch):
    load_adapter_module(monkeypatch)
    discovery = importlib.import_module("discovery")

    rows = discovery.command_registry_rows({
        "resume": {"description": "Resume the current task", "aliases": "continue go"},
    })
    normalized = discovery.normalize_slash_row(rows[0], source="hermes", category="Commands")

    assert normalized["name"] == "resume"
    assert normalized["text"] == "/resume"
    assert normalized["aliases"] == ["continue", "go"]


def test_discovery_filters_disabled_and_config_gated_commands(monkeypatch: pytest.MonkeyPatch):
    load_adapter_module(monkeypatch)
    discovery = importlib.import_module("discovery")

    assert discovery.command_available({"name": "ok"}, {}) is True
    assert discovery.command_available({"name": "off", "enabled": False}, {}) is False
    assert discovery.command_available({"name": "cli", "cli_only": True}, {}) is False
    assert discovery.command_available({"name": "needs-key", "config_key": "openai"}, {}) is False
    assert discovery.command_available({"name": "needs-key", "config_key": "openai"}, {"openai": "set"}) is True


def test_attachment_normalization_accepts_paths_and_uploaded_audio(monkeypatch: pytest.MonkeyPatch):
    load_adapter_module(monkeypatch)
    attachments = importlib.import_module("attachments")

    path_rows = attachments.normalized_inbound_attachments([
        {"path": "/tmp/photo.png", "name": "photo.png", "kind": "image"},
    ])
    upload_rows = attachments.normalized_inbound_attachments(
        [{"field": "clip", "name": "clip.webm", "kind": "audio"}],
        {"clip": {"filename": "clip.webm", "mimeType": "video/webm", "bytes": b"audio-bytes"}},
    )

    assert path_rows == [
        {"path": "/tmp/photo.png", "name": "photo.png", "kind": "image", "mimeType": "image/png"}
    ]
    assert upload_rows == [
        {"path": "/tmp/audio", "name": "clip.webm", "kind": "audio", "mimeType": "audio/webm"}
    ]
    assert attachments.message_type_for_attachments(upload_rows) == "voice"
