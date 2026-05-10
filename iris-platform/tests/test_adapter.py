from __future__ import annotations

import importlib
import asyncio
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
                    "deliveredAt": requests[0][2]["metadata"]["deliveredAt"],
                },
            },
        )
    ]


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
