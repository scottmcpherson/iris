"""Bidirectional Iris platform adapter for Hermes."""

from __future__ import annotations

import logging
import time
import asyncio
import ipaddress
import urllib.parse
import uuid
from typing import Any, Dict, Optional

try:
    from aiohttp import web
    AIOHTTP_AVAILABLE = True
except ImportError:
    web = None  # type: ignore[assignment]
    AIOHTTP_AVAILABLE = False

try:
    from adapter_config import (
        DEFAULT_INBOUND_HOST,
        current_profile_name,
        default_inbound_port,
        env_value,
        clamp_int,
        normalize_base_url,
        safe_int,
        safe_text,
    )
    from attachments import (
        inbound_payload_and_files,
        message_type_for_attachments,
        normalized_inbound_attachments,
    )
    from discovery import (
        discover_slash_commands,
        filter_slash_command_rows,
        normalize_model_provider,
    )
    from http_client import AIOHTTP_AVAILABLE as HTTP_CLIENT_AVAILABLE, IrisCoreHttpClient
    from routes import register_inbound_routes
except ImportError:
    from .adapter_config import (
        DEFAULT_INBOUND_HOST,
        current_profile_name,
        default_inbound_port,
        env_value,
        clamp_int,
        normalize_base_url,
        safe_int,
        safe_text,
    )
    from .attachments import (
        inbound_payload_and_files,
        message_type_for_attachments,
        normalized_inbound_attachments,
    )
    from .discovery import (
        discover_slash_commands,
        filter_slash_command_rows,
        normalize_model_provider,
    )
    from .http_client import AIOHTTP_AVAILABLE as HTTP_CLIENT_AVAILABLE, IrisCoreHttpClient
    from .routes import register_inbound_routes

from gateway.config import Platform
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    SendResult,
)
from gateway.session import SessionSource

logger = logging.getLogger(__name__)

MAX_INBOUND_BYTES = 250 * 1024 * 1024
STREAM_STATE_TTL_SECONDS = 60 * 60
STREAM_STATE_MAX_ENTRIES = 512


def current_cron_delivery_metadata() -> Dict[str, str]:
    try:
        from gateway.session_context import get_session_env
    except Exception:
        return {}
    metadata: Dict[str, str] = {}
    session_id = str(get_session_env("HERMES_SESSION_KEY", "") or "").strip()
    if session_id.startswith("cron_"):
        metadata["externalSessionId"] = session_id
        metadata["hermesSessionId"] = session_id
        metadata["cronSessionId"] = session_id
    platform = str(get_session_env("HERMES_CRON_AUTO_DELIVER_PLATFORM", "") or "").strip()
    chat_id = str(get_session_env("HERMES_CRON_AUTO_DELIVER_CHAT_ID", "") or "").strip()
    thread_id = str(get_session_env("HERMES_CRON_AUTO_DELIVER_THREAD_ID", "") or "").strip()
    if platform:
        metadata["cronDeliveryPlatform"] = platform
    if chat_id:
        metadata["cronDeliveryChatId"] = chat_id
    if thread_id:
        metadata["cronDeliveryThreadId"] = thread_id
    return metadata


class IrisPlatformAdapter(BasePlatformAdapter):
    SUPPORTS_MESSAGE_EDITING = True
    REQUIRES_EDIT_FINALIZE = True
    # Compatibility for current Hermes GatewayStreamConsumer, which reads this
    # class attribute and does not treat 0 as "no limit" yet. The documented
    # plugin contract below still registers max_message_length=0.
    MAX_MESSAGE_LENGTH = 1_000_000

    def __init__(self, config, **_kwargs):
        super().__init__(config=config, platform=Platform("iris"))
        extra = getattr(config, "extra", {}) or {}
        self.profile = current_profile_name()
        self.base_url = normalize_base_url(env_value("IRIS_BASE_URL") or extra.get("base_url"))
        self.token = str(env_value("IRIS_TOKEN") or extra.get("token") or "").strip()
        self.inbound_host = str(
            env_value("IRIS_INBOUND_HOST")
            or extra.get("inbound_host")
            or DEFAULT_INBOUND_HOST
        ).strip()
        self.inbound_port = safe_int(
            env_value("IRIS_INBOUND_PORT") or extra.get("inbound_port"),
            default_inbound_port(),
        )
        self.default_chat_id = str(
            env_value("IRIS_DEFAULT_CHAT_ID")
            or extra.get("default_chat_id")
            or "desktop"
        ).strip()
        self._stream_last_sent_lengths: dict[str, int] = {}
        self._stream_last_sent_content: dict[str, str] = {}
        self._stream_client_request_ids: dict[str, str] = {}
        self._stream_terminal_sent: set[str] = set()
        self._stream_state_updated_at: dict[str, float] = {}
        self._stream_terminal_sent_at: dict[str, float] = {}
        self._active_client_request_ids_by_chat: dict[str, str] = {}
        self._active_client_request_id_updated_at: dict[str, float] = {}
        self._active_streams_by_client_request_id: dict[str, tuple[str, str]] = {}
        self._runner = None
        self._site = None

    @property
    def name(self) -> str:
        return "Iris"

    async def connect(self) -> bool:
        if not AIOHTTP_AVAILABLE:
            self._set_fatal_error(
                "dependency_missing",
                "aiohttp is required for Iris inbound routing",
                retryable=False,
            )
            return False
        config_error = iris_config_error(self.base_url, self.token)
        if config_error:
            self._set_fatal_error(
                "config_missing",
                config_error,
                retryable=False,
            )
            return False
        result = await self._request("GET", "/v1/health")
        if not result.get("ok"):
            self._set_fatal_error(
                "health_failed",
                str(result.get("error") or "Iris health check failed"),
                retryable=True,
            )
            return False
        try:
            await self._start_inbound_server()
        except Exception as exc:
            self._set_fatal_error(
                "inbound_failed",
                f"Iris inbound listener failed: {exc}",
                retryable=True,
            )
            return False
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        await self._stop_inbound_server()
        self._mark_disconnected()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        target = (chat_id or self.default_chat_id).strip()
        if not target:
            return SendResult(success=False, error="Iris chat id is required")

        merged_metadata = dict(metadata or {})
        client_request_id = self._client_request_id_from_metadata(merged_metadata)
        if client_request_id:
            merged_metadata["clientRequestId"] = client_request_id
            self._active_client_request_ids_by_chat[target] = client_request_id
            self._active_client_request_id_updated_at[target] = time.time()
        if reply_to:
            merged_metadata["replyTo"] = reply_to

        source = str(merged_metadata.pop("source", "") or "").strip()
        if not source:
            source = "hermes-cron" if content.lstrip().startswith("Cronjob Response:") else "hermes-gateway"
        if source == "hermes-cron":
            for key, value in current_cron_delivery_metadata().items():
                merged_metadata.setdefault(key, value)

        is_stream_preview = source == "hermes-gateway-stream" or content.endswith(" ▉")
        visible_content = strip_stream_cursor(content) if is_stream_preview else content
        message_id = str(merged_metadata.pop("streamMessageId", "") or "").strip()
        if is_stream_preview and not message_id:
            message_id = f"iris-stream-{uuid.uuid4()}"
        if is_stream_preview:
            source = "hermes-gateway-stream"
            merged_metadata["streamMessageId"] = message_id
            merged_metadata["streaming"] = True
            merged_metadata["finalize"] = False
            merged_metadata["chunkProtocol"] = "v2-delta"
            merged_metadata["chunkOperation"] = "append"
            if client_request_id:
                self._stream_client_request_ids[message_id] = client_request_id
                self._active_streams_by_client_request_id[client_request_id] = (target, message_id)
                self._touch_stream_state(message_id)
            if reply_to:
                merged_metadata["replyTo"] = reply_to

        delivery_message_id = message_id or f"iris-delivery-{uuid.uuid4()}"
        body = {
            "runtimeId": "runtime_local_hermes",
            "profile": safe_text(merged_metadata.pop("profile", self.profile), self.profile, 80),
            "chatId": target,
            "messageId": delivery_message_id,
            "replyTo": reply_to,
            "source": source,
            "content": visible_content,
            "metadata": {
                **merged_metadata,
                "deliveredAt": int(time.time()),
            },
        }
        result = await self._request("POST", "/v1/runtime-deliveries/hermes", body)
        if not result.get("ok"):
            return SendResult(
                success=False,
                error=str(result.get("error") or "Iris delivery failed"),
                retryable=bool(result.get("retryable", True)),
                raw_response=result,
            )
        return SendResult(
            success=True,
            message_id=delivery_message_id,
            raw_response=result,
        )

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        target = (chat_id or self.default_chat_id).strip()
        stream_message_id = str(message_id or "").strip()
        if not target:
            return SendResult(success=False, error="Iris chat id is required")
        if not stream_message_id:
            return SendResult(success=False, error="Iris stream message id is required")
        self._prune_stream_state()
        if stream_message_id in self._stream_terminal_sent:
            return SendResult(success=True, message_id=stream_message_id, raw_response={"ok": True, "duplicateTerminal": True})

        clean_content = strip_stream_cursor(content)
        last_sent_length = self._stream_last_sent_lengths.get(stream_message_id, 0)
        last_sent_content = self._stream_last_sent_content.get(stream_message_id, "")
        chunk_operation = "append"
        if last_sent_content and clean_content.startswith(last_sent_content):
            delta = clean_content[last_sent_length:]
        elif not last_sent_content:
            delta = clean_content
        else:
            logger.warning(
                "[Iris] stream %s received non-monotonic content; sending replace chunk",
                stream_message_id,
            )
            delta = clean_content
            chunk_operation = "replace"
        self._stream_last_sent_lengths[stream_message_id] = len(clean_content)
        self._stream_last_sent_content[stream_message_id] = clean_content
        self._touch_stream_state(stream_message_id)
        delivery_metadata = dict(metadata or {})
        client_request_id = (
            self._client_request_id_from_metadata(delivery_metadata)
            or self._stream_client_request_ids.get(stream_message_id, "")
            or self._active_client_request_ids_by_chat.get(target, "")
        )
        if client_request_id:
            self._stream_client_request_ids[stream_message_id] = client_request_id
            self._active_streams_by_client_request_id[client_request_id] = (target, stream_message_id)
            self._active_client_request_ids_by_chat[target] = client_request_id
            self._active_client_request_id_updated_at[target] = time.time()
        body = {
            "runtimeId": "runtime_local_hermes",
            "profile": self.profile,
            "chatId": target,
            "messageId": f"{stream_message_id}:edit:{time.time_ns()}",
            "source": "hermes-gateway-stream",
            "content": delta,
            "metadata": {
                **delivery_metadata,
                "streamMessageId": stream_message_id,
                "chunkProtocol": "v2-delta",
                "chunkOperation": chunk_operation,
                "streaming": not finalize,
                "finalize": bool(finalize),
                **({"clientRequestId": client_request_id} if client_request_id else {}),
                "deliveredAt": int(time.time()),
            },
        }
        try:
            result = await self._request("POST", "/v1/runtime-deliveries/hermes", body)
        except Exception as exc:
            await self._emit_stream_error_delivery(target, stream_message_id, client_request_id, exc)
            raise
        if finalize:
            self._stream_terminal_sent.add(stream_message_id)
            self._stream_terminal_sent_at[stream_message_id] = time.time()
            self._clear_stream_state(stream_message_id)
            if client_request_id:
                self._active_streams_by_client_request_id.pop(client_request_id, None)
                if self._active_client_request_ids_by_chat.get(target) == client_request_id:
                    self._active_client_request_ids_by_chat.pop(target, None)
                    self._active_client_request_id_updated_at.pop(target, None)
        if not result.get("ok"):
            return SendResult(
                success=False,
                error=str(result.get("error") or "Iris stream edit failed"),
                retryable=bool(result.get("retryable", True)),
                raw_response=result,
            )
        return SendResult(
            success=True,
            message_id=stream_message_id,
            raw_response=result,
        )

    def _client_request_id_from_metadata(self, metadata: Dict[str, Any]) -> str:
        return str(
            metadata.get("clientRequestId")
            or metadata.get("client_request_id")
            or metadata.get("clientMessageId")
            or metadata.get("client_message_id")
            or ""
        ).strip()

    def _touch_stream_state(self, stream_message_id: str) -> None:
        self._stream_state_updated_at[stream_message_id] = time.time()

    def _clear_stream_state(self, stream_message_id: str) -> None:
        self._stream_last_sent_lengths.pop(stream_message_id, None)
        self._stream_last_sent_content.pop(stream_message_id, None)
        client_request_id = self._stream_client_request_ids.pop(stream_message_id, "")
        self._stream_state_updated_at.pop(stream_message_id, None)
        if client_request_id:
            active = self._active_streams_by_client_request_id.get(client_request_id)
            if active and active[1] == stream_message_id:
                self._active_streams_by_client_request_id.pop(client_request_id, None)

    def _prune_stream_state(self) -> None:
        now = time.time()
        stale_stream_ids = [
            stream_id
            for stream_id, updated_at in self._stream_state_updated_at.items()
            if now - updated_at > STREAM_STATE_TTL_SECONDS
        ]
        for stream_id in stale_stream_ids:
            self._clear_stream_state(stream_id)

        stale_terminal_ids = [
            stream_id
            for stream_id, updated_at in self._stream_terminal_sent_at.items()
            if now - updated_at > STREAM_STATE_TTL_SECONDS
        ]
        for stream_id in stale_terminal_ids:
            self._stream_terminal_sent.discard(stream_id)
            self._stream_terminal_sent_at.pop(stream_id, None)

        stale_chats = [
            chat_id
            for chat_id, updated_at in self._active_client_request_id_updated_at.items()
            if now - updated_at > STREAM_STATE_TTL_SECONDS
        ]
        for chat_id in stale_chats:
            self._active_client_request_ids_by_chat.pop(chat_id, None)
            self._active_client_request_id_updated_at.pop(chat_id, None)

        while len(self._stream_state_updated_at) > STREAM_STATE_MAX_ENTRIES:
            oldest_stream_id = min(self._stream_state_updated_at, key=self._stream_state_updated_at.get)
            self._clear_stream_state(oldest_stream_id)
        while len(self._stream_terminal_sent_at) > STREAM_STATE_MAX_ENTRIES:
            oldest_stream_id = min(self._stream_terminal_sent_at, key=self._stream_terminal_sent_at.get)
            self._stream_terminal_sent.discard(oldest_stream_id)
            self._stream_terminal_sent_at.pop(oldest_stream_id, None)
        while len(self._active_client_request_id_updated_at) > STREAM_STATE_MAX_ENTRIES:
            oldest_chat_id = min(
                self._active_client_request_id_updated_at,
                key=self._active_client_request_id_updated_at.get,
            )
            self._active_client_request_ids_by_chat.pop(oldest_chat_id, None)
            self._active_client_request_id_updated_at.pop(oldest_chat_id, None)

    async def _emit_stream_error_delivery(
        self,
        chat_id: str,
        stream_message_id: str,
        client_request_id: str,
        error: Exception,
    ) -> None:
        if stream_message_id in self._stream_terminal_sent:
            return
        self._stream_terminal_sent.add(stream_message_id)
        self._stream_terminal_sent_at[stream_message_id] = time.time()
        body = {
            "runtimeId": "runtime_local_hermes",
            "profile": self.profile,
            "chatId": chat_id,
            "messageId": f"{stream_message_id}:error:{time.time_ns()}",
            "source": "hermes-error",
            "content": "",
            "metadata": {
                "streamMessageId": stream_message_id,
                "chunkProtocol": "v2-delta",
                "chunkOperation": "append",
                "streaming": False,
                "finalize": True,
                "error": str(error),
                **({"clientRequestId": client_request_id} if client_request_id else {}),
                "deliveredAt": int(time.time()),
            },
        }
        try:
            await self._request("POST", "/v1/runtime-deliveries/hermes", body)
        except Exception:
            logger.exception("[Iris] failed to emit terminal stream error for %s", stream_message_id)
        finally:
            self._clear_stream_state(stream_message_id)
            if client_request_id:
                self._active_streams_by_client_request_id.pop(client_request_id, None)
                if self._active_client_request_ids_by_chat.get(chat_id) == client_request_id:
                    self._active_client_request_ids_by_chat.pop(chat_id, None)
                    self._active_client_request_id_updated_at.pop(chat_id, None)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id or self.default_chat_id, "type": "iris"}

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        return None

    async def _start_inbound_server(self) -> None:
        if self._runner is not None:
            return
        app = web.Application(client_max_size=MAX_INBOUND_BYTES)  # type: ignore[union-attr]
        register_inbound_routes(app, self)
        self._runner = web.AppRunner(app)  # type: ignore[union-attr]
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self.inbound_host, self.inbound_port)  # type: ignore[union-attr]
        await self._site.start()
        logger.info(
            "[Iris] inbound listener ready on http://%s:%s/iris/messages",
            self.inbound_host,
            self.inbound_port,
        )

    async def _stop_inbound_server(self) -> None:
        if self._runner is None:
            return
        runner = self._runner
        self._runner = None
        self._site = None
        await runner.cleanup()

    async def _inbound_health(self, _request):
        return web.json_response(  # type: ignore[union-attr]
            {
                "ok": True,
                "platform": "iris",
                "profile": self.profile,
                "inbound": True,
                "defaultChatId": self.default_chat_id,
                "inboundPort": self.inbound_port,
            }
        )

    async def _inbound_message(self, request):
        if not self._authorized(request):
            return web.json_response({"ok": False, "error": "Unauthorized"}, status=401)  # type: ignore[union-attr]
        try:
            payload, uploaded_files = await inbound_payload_and_files(request)
        except Exception:
            return web.json_response({"ok": False, "error": "Invalid message body"}, status=400)  # type: ignore[union-attr]
        if not isinstance(payload, dict):
            return web.json_response({"ok": False, "error": "Expected a JSON object"}, status=400)  # type: ignore[union-attr]

        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        text = str(payload.get("text") or payload.get("content") or "").strip()
        project_prompt = project_channel_prompt(metadata)
        try:
            attachments = normalized_inbound_attachments(payload.get("attachments"), uploaded_files)
        except ValueError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)  # type: ignore[union-attr]
        if not text and not attachments:
            return web.json_response({"ok": False, "error": "Message text or attachment is required"}, status=400)  # type: ignore[union-attr]
        chat_id = safe_text(payload.get("chatId") or payload.get("chat_id"), self.default_chat_id, 160)
        if not chat_id:
            return web.json_response({"ok": False, "error": "chatId is required"}, status=400)  # type: ignore[union-attr]
        requested_profile = safe_text(payload.get("profile"), self.profile, 80)
        if requested_profile != self.profile:
            return web.json_response(  # type: ignore[union-attr]
                {
                    "ok": False,
                    "error": (
                        f"Iris message targeted profile '{requested_profile}', "
                        f"but this adapter is for '{self.profile}'."
                    ),
                    "profile": self.profile,
                },
                status=409,
            )

        message_id = safe_text(payload.get("messageId") or payload.get("message_id"), str(uuid.uuid4()), 160)
        client_request_id = (
            self._client_request_id_from_metadata(metadata)
            or safe_text(payload.get("clientRequestId") or payload.get("client_request_id"), "", 160)
            or message_id
        )
        if client_request_id:
            metadata = {**metadata, "clientRequestId": client_request_id}
            self._active_client_request_ids_by_chat[chat_id] = client_request_id
            self._active_client_request_id_updated_at[chat_id] = time.time()
        source = SessionSource(
            platform=Platform("iris"),
            chat_id=chat_id,
            chat_name=safe_text(payload.get("chatName") or payload.get("chat_name"), chat_id, 160),
            chat_type=safe_text(payload.get("chatType") or payload.get("chat_type"), "dm", 40) or "dm",
            user_id=safe_text(payload.get("userId") or payload.get("user_id"), "iris-user", 160),
            user_name=safe_text(payload.get("userName") or payload.get("user_name"), "Iris User", 160),
        )
        bound_session_id = safe_text(
            payload.get("sessionId")
            or payload.get("session_id")
            or metadata.get("hermesSessionId")
            or metadata.get("externalSessionId"),
            "",
            160,
        )
        resolved_session_id = bound_session_id
        bind_warning = bind_source_to_existing_session(self, source, bound_session_id)
        if not resolved_session_id:
            resolved_session_id, reserve_warning = reserve_source_session(self, source)
            bind_warning = "; ".join(
                warning for warning in [bind_warning, reserve_warning] if warning
            )
        event = MessageEvent(
            text=text,
            message_type=message_type_for_attachments(attachments),
            source=source,
            raw_message=payload,
            message_id=message_id,
            media_urls=[attachment["path"] for attachment in attachments],
            media_types=[attachment["mimeType"] for attachment in attachments],
            channel_prompt=project_prompt or None,
        )
        task = asyncio.create_task(self.handle_message(event))
        task.add_done_callback(
            lambda done: asyncio.create_task(
                self._handle_inbound_message_done(done, chat_id, client_request_id)
            )
        )
        return web.json_response(  # type: ignore[union-attr]
            {
                "ok": True,
                "accepted": True,
                "platform": "iris",
                "profile": self.profile,
                "chatId": chat_id,
                "messageId": message_id,
                **({"sessionId": resolved_session_id} if resolved_session_id else {}),
                **({"warning": bind_warning} if bind_warning else {}),
            },
            status=202,
        )

    async def _handle_inbound_message_done(self, task, chat_id: str, client_request_id: str) -> None:
        try:
            task.result()
        except asyncio.CancelledError as exc:
            await self._emit_active_stream_error(chat_id, client_request_id, exc)
        except Exception as exc:
            await self._emit_active_stream_error(chat_id, client_request_id, exc)
        else:
            active = self._active_streams_by_client_request_id.get(client_request_id)
            if active:
                await self._emit_stream_error_delivery(
                    active[0] or chat_id,
                    active[1],
                    client_request_id,
                    RuntimeError("Hermes stream ended without a terminal delivery"),
                )

    async def _emit_active_stream_error(self, chat_id: str, client_request_id: str, error: Exception) -> None:
        active = self._active_streams_by_client_request_id.get(client_request_id)
        if not active:
            return
        await self._emit_stream_error_delivery(active[0] or chat_id, active[1], client_request_id, error)

    async def _inbound_models(self, request):
        if not self._authorized(request):
            return web.json_response({"ok": False, "error": "Unauthorized"}, status=401)  # type: ignore[union-attr]

        max_models = clamp_int(request.query.get("maxModels"), 100, 1, 200)
        try:
            from gateway.run import _load_gateway_config
            from hermes_cli.config import get_compatible_custom_providers
            from hermes_cli.model_switch import list_authenticated_providers
            from hermes_cli.providers import get_label

            cfg = _load_gateway_config() or {}
            model_cfg = cfg.get("model", {})
            current_model = ""
            current_provider = "openrouter"
            current_base_url = ""

            if isinstance(model_cfg, str):
                current_model = model_cfg
            elif isinstance(model_cfg, dict):
                current_model = str(model_cfg.get("default") or model_cfg.get("model") or "")
                current_provider = str(model_cfg.get("provider") or current_provider)
                current_base_url = str(model_cfg.get("base_url") or "")

            custom_providers = get_compatible_custom_providers(cfg)
            provider_rows = list_authenticated_providers(
                current_provider=current_provider,
                current_base_url=current_base_url,
                current_model=current_model,
                user_providers=cfg.get("providers"),
                custom_providers=custom_providers,
                max_models=max_models,
            )
            providers = [normalize_model_provider(row) for row in provider_rows if isinstance(row, dict)]

            return web.json_response(  # type: ignore[union-attr]
                {
                    "ok": True,
                    "profile": self.profile,
                    "current": {
                        "provider": current_provider,
                        "model": current_model,
                        "providerName": get_label(current_provider),
                    } if current_model else None,
                    "providers": providers,
                    "generatedAt": int(time.time()),
                }
            )
        except Exception as exc:
            logger.exception("[Iris] model catalog discovery failed")
            return web.json_response(  # type: ignore[union-attr]
                {
                    "ok": False,
                    "profile": self.profile,
                    "current": None,
                    "providers": [],
                    "generatedAt": int(time.time()),
                    "error": str(exc),
                },
                status=500,
            )

    async def _inbound_slash_commands(self, request):
        if not self._authorized(request):
            return web.json_response({"ok": False, "error": "Unauthorized"}, status=401)  # type: ignore[union-attr]

        result = discover_slash_commands(self.profile)
        status = 200 if result.get("ok") else 500
        return web.json_response(result, status=status)  # type: ignore[union-attr]

    async def _inbound_slash_complete(self, request):
        if not self._authorized(request):
            return web.json_response({"ok": False, "error": "Unauthorized"}, status=401)  # type: ignore[union-attr]
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "Invalid JSON body"}, status=400)  # type: ignore[union-attr]
        if not isinstance(payload, dict):
            return web.json_response({"ok": False, "error": "Expected a JSON object"}, status=400)  # type: ignore[union-attr]

        text = str(payload.get("text") or "")
        limit = clamp_int(payload.get("limit"), 30, 1, 100)
        catalog = discover_slash_commands(self.profile)
        commands = catalog.get("commands") if isinstance(catalog.get("commands"), list) else []
        items = [
            {
                "text": command["text"],
                "display": command["label"],
                "meta": command.get("description") or command.get("category") or "",
            }
            for command in filter_slash_command_rows(commands, text.lstrip("/"))[:limit]
            if isinstance(command, dict)
        ]
        return web.json_response(  # type: ignore[union-attr]
            {
                "ok": bool(catalog.get("ok", True)),
                "items": items,
                "replaceFrom": 1 if text.startswith("/") else 0,
                **({"error": catalog.get("error")} if catalog.get("error") else {}),
            }
        )

    def _authorized(self, request) -> bool:
        if not self.token:
            return request_remote_is_loopback(request)
        header = str(request.headers.get("Authorization") or "")
        prefix = "Bearer "
        return bool(header.startswith(prefix) and header[len(prefix):].strip() == self.token)

    async def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        client = IrisCoreHttpClient(base_url=self.base_url, token=self.token)
        return await client.request(method, path, body)


def url_is_loopback(url: str) -> bool:
    parsed = urllib.parse.urlparse(str(url or ""))
    host = (parsed.hostname or "").strip().lower()
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def request_remote_is_loopback(request) -> bool:
    candidates: list[str] = []
    remote = getattr(request, "remote", None)
    if remote:
        candidates.append(str(remote))
    transport = getattr(request, "transport", None)
    if transport is not None:
        peername = transport.get_extra_info("peername")
        if isinstance(peername, tuple) and peername:
            candidates.append(str(peername[0]))
        elif isinstance(peername, str):
            candidates.append(peername)
    return any(host_is_loopback(candidate) for candidate in candidates)


def host_is_loopback(host: str) -> bool:
    value = str(host or "").strip().lower()
    if value in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def iris_config_error(base_url: str, token: str) -> str:
    if not base_url:
        return "IRIS_BASE_URL must be set."
    if token:
        return ""
    if url_is_loopback(base_url):
        return ""
    return "Iris Desktop remote access uses SSH to a loopback Core. Set IRIS_BASE_URL to loopback on the Hermes host; non-loopback IRIS_BASE_URL is unsupported by Iris Desktop."


def check_requirements() -> bool:
    base_url = normalize_base_url(env_value("IRIS_BASE_URL"))
    token = str(env_value("IRIS_TOKEN") or "").strip()
    return bool(HTTP_CLIENT_AVAILABLE and base_url and not iris_config_error(base_url, token))


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    base_url = normalize_base_url(env_value("IRIS_BASE_URL") or extra.get("base_url"))
    token = str(env_value("IRIS_TOKEN") or extra.get("token") or "").strip()
    return bool(HTTP_CLIENT_AVAILABLE and base_url and not iris_config_error(base_url, token))


def is_connected(config) -> bool:
    return validate_config(config)


def register(ctx) -> None:
    ctx.register_platform(
        name="iris",
        label="Iris",
        adapter_factory=lambda cfg: IrisPlatformAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["IRIS_BASE_URL"],
        install_hint="Set IRIS_BASE_URL to a loopback Core URL on the Hermes host, then restart the Hermes gateway. For remote Iris Desktop access, use SSH to that host.",
        max_message_length=0,
        pii_safe=False,
        emoji="A",
        allow_update_command=False,
        allowed_users_env="IRIS_ALLOWED_USERS",
        allow_all_env="IRIS_ALLOW_ALL_USERS",
        platform_hint=(
            "You are delivering to Iris Desktop. Keep scheduled "
            "delivery output direct and readable."
        ),
    )


def bind_source_to_existing_session(adapter: IrisPlatformAdapter, source: SessionSource, session_id: str) -> str:
    target_session_id = str(session_id or "").strip()
    if not target_session_id:
        return ""
    store = getattr(adapter, "_session_store", None)
    if store is None:
        return "Hermes session store is unavailable; continuing with chat id routing only."
    try:
        current = store.get_or_create_session(source)
        if getattr(current, "session_id", "") == target_session_id:
            return ""
        switched = store.switch_session(current.session_key, target_session_id)
        if switched is None:
            return "Hermes session binding was not applied."
    except Exception as exc:
        logger.debug(
            "[Iris] failed to bind chat %s to Hermes session %s",
            source.chat_id,
            target_session_id,
            exc_info=True,
        )
        return f"Hermes session binding failed: {exc}"
    return ""


def reserve_source_session(adapter: IrisPlatformAdapter, source: SessionSource) -> tuple[str, str]:
    store = getattr(adapter, "_session_store", None)
    if store is None:
        return "", "Hermes session store is unavailable; continuing with chat id routing only."
    try:
        current = store.get_or_create_session(source)
        return str(getattr(current, "session_id", "") or ""), ""
    except Exception as exc:
        logger.debug(
            "[Iris] failed to reserve Hermes session for chat %s",
            source.chat_id,
            exc_info=True,
        )
        return "", f"Hermes session reservation failed: {exc}"


def strip_stream_cursor(content: str) -> str:
    return content.removesuffix(" ▉")


def project_channel_prompt(metadata: Dict[str, Any]) -> str:
    prompt = str(metadata.get("projectSystemPrompt") or "").strip()
    if not prompt:
        return ""
    project_name = str(metadata.get("projectName") or "Iris project").strip() or "Iris project"
    return (
        f"Project: {project_name}\n\n"
        f"{prompt}"
    )
