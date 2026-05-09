"""Bidirectional Iris platform adapter for Hermes."""

from __future__ import annotations

import json
import logging
import os
import re
import time
import asyncio
import urllib.error
import urllib.parse
import urllib.request
import uuid
import mimetypes
from pathlib import Path
from typing import Any, Dict, Optional

try:
    from aiohttp import web
    AIOHTTP_AVAILABLE = True
except ImportError:
    web = None  # type: ignore[assignment]
    AIOHTTP_AVAILABLE = False

from gateway.config import Platform
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
    cache_audio_from_bytes,
    cache_document_from_bytes,
    cache_image_from_bytes,
    cache_video_from_bytes,
)
from gateway.session import SessionSource

logger = logging.getLogger(__name__)

DEFAULT_INBOUND_HOST = "127.0.0.1"
DEFAULT_INBOUND_PORT = 8766
API_TO_AGENTUI_PORT_OFFSET = 124
MAX_INBOUND_BYTES = 250 * 1024 * 1024


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
        self.base_url = normalize_base_url(env_value("IRIS_BASE_URL", "AGENTUI_BASE_URL") or extra.get("base_url"))
        self.token = str(env_value("IRIS_TOKEN", "AGENTUI_TOKEN") or extra.get("token") or "").strip()
        self.inbound_host = str(
            env_value("IRIS_INBOUND_HOST", "AGENTUI_INBOUND_HOST")
            or extra.get("inbound_host")
            or DEFAULT_INBOUND_HOST
        ).strip()
        self.inbound_port = safe_int(
            env_value("IRIS_INBOUND_PORT", "AGENTUI_INBOUND_PORT") or extra.get("inbound_port"),
            default_inbound_port(),
        )
        self.default_chat_id = str(
            env_value("IRIS_DEFAULT_CHAT_ID", "AGENTUI_DEFAULT_CHAT_ID")
            or extra.get("default_chat_id")
            or "desktop"
        ).strip()
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
        if not self.base_url or not self.token:
            self._set_fatal_error(
                "config_missing",
                "IRIS_BASE_URL and IRIS_TOKEN must be set. AGENTUI_BASE_URL and AGENTUI_TOKEN are still accepted for compatibility.",
                retryable=False,
            )
            return False
        result = self._request("GET", "/v1/inbox/health")
        if not result.get("ok"):
            self._set_fatal_error(
                "health_failed",
                str(result.get("error") or "Iris inbox health check failed"),
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
        if reply_to:
            merged_metadata["replyTo"] = reply_to

        source = str(merged_metadata.pop("source", "") or "").strip()
        if not source:
            source = "hermes-cron" if content.lstrip().startswith("Cronjob Response:") else "hermes-gateway"

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
        result = self._request("POST", "/v1/runtime-deliveries/hermes", body)
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
    ) -> SendResult:
        target = (chat_id or self.default_chat_id).strip()
        stream_message_id = str(message_id or "").strip()
        if not target:
            return SendResult(success=False, error="Iris chat id is required")
        if not stream_message_id:
            return SendResult(success=False, error="Iris stream message id is required")

        body = {
            "runtimeId": "runtime_local_hermes",
            "profile": self.profile,
            "chatId": target,
            "messageId": f"{stream_message_id}:edit:{time.time_ns()}",
            "source": "hermes-gateway-stream",
            "content": strip_stream_cursor(content),
            "metadata": {
                "streamMessageId": stream_message_id,
                "streaming": not finalize,
                "finalize": bool(finalize),
                "deliveredAt": int(time.time()),
            },
        }
        result = self._request("POST", "/v1/runtime-deliveries/hermes", body)
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

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id or self.default_chat_id, "type": "iris"}

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        return None

    async def _start_inbound_server(self) -> None:
        if self._runner is not None:
            return
        app = web.Application(client_max_size=MAX_INBOUND_BYTES)  # type: ignore[union-attr]
        app.router.add_get("/health", self._inbound_health)
        app.router.add_get("/iris/models", self._inbound_models)
        app.router.add_get("/iris/slash-commands", self._inbound_slash_commands)
        app.router.add_post("/iris/slash-complete", self._inbound_slash_complete)
        app.router.add_post("/iris/messages", self._inbound_message)
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

        text = str(payload.get("text") or payload.get("content") or "").strip()
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
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        source = SessionSource(
            platform=Platform("iris"),
            chat_id=chat_id,
            chat_name=safe_text(payload.get("chatName") or payload.get("chat_name"), chat_id, 160),
            chat_type=safe_text(payload.get("chatType") or payload.get("chat_type"), "dm", 40) or "dm",
            user_id=safe_text(payload.get("userId") or payload.get("user_id"), "agentui-user", 160),
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
        bind_warning = bind_source_to_existing_session(self, source, bound_session_id)
        event = MessageEvent(
            text=text,
            message_type=message_type_for_attachments(attachments),
            source=source,
            raw_message=payload,
            message_id=message_id,
            media_urls=[attachment["path"] for attachment in attachments],
            media_types=[attachment["mimeType"] for attachment in attachments],
        )
        asyncio.create_task(self.handle_message(event))
        return web.json_response(  # type: ignore[union-attr]
            {
                "ok": True,
                "accepted": True,
                "platform": "iris",
                "profile": self.profile,
                "chatId": chat_id,
                "messageId": message_id,
                **({"sessionId": bound_session_id} if bound_session_id else {}),
                **({"warning": bind_warning} if bind_warning else {}),
            },
            status=202,
        )

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
        header = str(request.headers.get("Authorization") or "")
        prefix = "Bearer "
        return bool(self.token and header.startswith(prefix) and header[len(prefix):].strip() == self.token)

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.token}",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                text = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8", errors="replace")
            return {"ok": False, "status": exc.code, "error": api_error(text) or f"HTTP {exc.code}"}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "retryable": True}

        try:
            parsed = json.loads(text) if text else {}
        except json.JSONDecodeError as exc:
            return {"ok": False, "error": f"Invalid Iris JSON: {exc}"}
        if not isinstance(parsed, dict):
            return {"ok": False, "error": "Iris returned a non-object JSON response"}
        return parsed if parsed.get("ok") is False else {**parsed, "ok": True}


def check_requirements() -> bool:
    return bool(AIOHTTP_AVAILABLE and env_value("IRIS_BASE_URL", "AGENTUI_BASE_URL") and env_value("IRIS_TOKEN", "AGENTUI_TOKEN"))


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return bool(
        AIOHTTP_AVAILABLE
        and
        normalize_base_url(env_value("IRIS_BASE_URL", "AGENTUI_BASE_URL") or extra.get("base_url"))
        and str(env_value("IRIS_TOKEN", "AGENTUI_TOKEN") or extra.get("token") or "").strip()
    )


def is_connected(config) -> bool:
    return validate_config(config)


def register(ctx) -> None:
    sync_env_alias("IRIS_ALLOWED_USERS", "AGENTUI_ALLOWED_USERS")
    sync_env_alias("IRIS_ALLOW_ALL_USERS", "AGENTUI_ALLOW_ALL_USERS")
    ctx.register_platform(
        name="iris",
        label="Iris",
        adapter_factory=lambda cfg: IrisPlatformAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["IRIS_BASE_URL", "IRIS_TOKEN"],
        install_hint="Set IRIS_BASE_URL and IRIS_TOKEN, then restart the Hermes gateway. AGENTUI_BASE_URL and AGENTUI_TOKEN remain compatible.",
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


def env_value(*names: str) -> str:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return ""


def sync_env_alias(preferred: str, legacy: str) -> None:
    if os.getenv(preferred) and not os.getenv(legacy):
        os.environ[legacy] = os.getenv(preferred, "")


def normalize_base_url(value: object) -> str:
    raw = str(value or "").strip().rstrip("/")
    if not raw:
        return ""
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return raw


def safe_int(value: object, default: int) -> int:
    try:
        parsed = int(str(value or "").strip())
    except (TypeError, ValueError):
        return default
    return parsed if 0 < parsed < 65536 else default


def clamp_int(value: object, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(str(value or "").strip())
    except (TypeError, ValueError):
        parsed = default
    return min(max(parsed, minimum), maximum)


def normalize_model_provider(row: Dict[str, Any]) -> Dict[str, Any]:
    models_value = row.get("models")
    models = [str(item) for item in models_value if str(item).strip()] if isinstance(models_value, list) else []
    slug = str(row.get("slug") or row.get("provider") or row.get("id") or "").strip()
    return {
        "slug": slug,
        "name": str(row.get("name") or row.get("label") or slug or "Provider").strip(),
        "isCurrent": bool(row.get("isCurrent", row.get("is_current", False))),
        "isUserDefined": bool(row.get("isUserDefined", row.get("is_user_defined", False))),
        "models": models,
        "totalModels": clamp_int(row.get("totalModels") or row.get("total_models"), len(models), 0, 100_000),
        "source": str(row.get("source") or "").strip(),
    }


def discover_slash_commands(profile: str) -> Dict[str, Any]:
    warnings: list[str] = []
    commands: list[Dict[str, Any]] = []
    config = load_gateway_config(warnings)

    try:
        commands.extend(discover_builtin_commands(config))
    except Exception as exc:
        logger.exception("[Iris] built-in slash command discovery failed")
        warnings.append(f"Built-in command discovery failed: {exc}")

    try:
        commands.extend(discover_quick_commands(config))
    except Exception as exc:
        logger.exception("[Iris] quick command discovery failed")
        warnings.append(f"Quick command discovery failed: {exc}")

    try:
        commands.extend(discover_plugin_commands(config))
    except Exception as exc:
        logger.exception("[Iris] plugin slash command discovery failed")
        warnings.append(f"Plugin command discovery failed: {exc}")

    try:
        commands.extend(discover_skill_commands(config))
    except Exception as exc:
        logger.exception("[Iris] skill slash command discovery failed")
        warnings.append(f"Skill command discovery failed: {exc}")

    normalized = dedupe_command_rows(commands)
    ok = bool(normalized or len(warnings) < 4)
    return {
        "ok": ok,
        "profile": profile,
        "generatedAt": int(time.time()),
        "commands": normalized,
        **({"warning": "; ".join(warnings)} if warnings else {}),
        **({"error": "; ".join(warnings) or "Slash command discovery failed."} if not ok else {}),
    }


def load_gateway_config(warnings: list[str]) -> Dict[str, Any]:
    try:
        from gateway.run import _load_gateway_config

        loaded = _load_gateway_config() or {}
        return loaded if isinstance(loaded, dict) else {}
    except Exception as exc:
        warnings.append(f"Gateway config unavailable: {exc}")
        return {}


def discover_builtin_commands(config: Dict[str, Any]) -> list[Dict[str, Any]]:
    from hermes_cli.commands import COMMAND_REGISTRY

    rows = command_registry_rows(COMMAND_REGISTRY)
    return [
        normalize_slash_row(row, source="hermes", category=command_category(row, "Commands"))
        for row in rows
        if command_available(row, config)
    ]


def discover_quick_commands(config: Dict[str, Any]) -> list[Dict[str, Any]]:
    quick_commands = config.get("quick_commands") or config.get("quickCommands")
    rows: list[Dict[str, Any]] = []
    if isinstance(quick_commands, dict):
        for name, value in quick_commands.items():
            description = ""
            text = ""
            if isinstance(value, dict):
                description = str(value.get("description") or value.get("prompt") or "").strip()
                text = str(value.get("command") or value.get("text") or name).strip()
            else:
                description = str(value or "").strip()
                text = str(name or "").strip()
            rows.append(
                normalize_slash_row(
                    {
                        "name": name,
                        "text": text,
                        "description": description,
                    },
                    source="quick-command",
                    category="User commands",
                )
            )
    elif isinstance(quick_commands, list):
        for item in quick_commands:
            rows.append(normalize_slash_row(item, source="quick-command", category="User commands"))
    return rows


def discover_plugin_commands(config: Dict[str, Any]) -> list[Dict[str, Any]]:
    try:
        from hermes_cli.plugins import get_plugin_commands
    except Exception:
        return []

    try:
        raw = get_plugin_commands(config)
    except TypeError:
        raw = get_plugin_commands()
    return [
        normalize_slash_row(row, source="plugin", category="Plugins")
        for row in command_registry_rows(raw)
        if command_available(row, config)
    ]


def discover_skill_commands(config: Dict[str, Any]) -> list[Dict[str, Any]]:
    try:
        from agent.skill_commands import scan_skill_commands
    except Exception:
        return []

    try:
        raw = scan_skill_commands(config)
    except TypeError:
        try:
            raw = scan_skill_commands()
        except TypeError:
            raw = []
    return [
        normalize_slash_row(row, source="skill", category="Skills")
        for row in command_registry_rows(raw)
    ]


def command_registry_rows(value: Any) -> list[Any]:
    if isinstance(value, dict):
        return [
            {**object_dict(command), "name": name}
            if not isinstance(command, dict) or not command.get("name")
            else command
            for name, command in value.items()
        ]
    if isinstance(value, (list, tuple, set)):
        return list(value)
    return [value] if value else []


def object_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    data: Dict[str, Any] = {}
    for key in (
        "id",
        "name",
        "text",
        "label",
        "description",
        "help",
        "category",
        "aliases",
        "args_hint",
        "argsHint",
        "subcommands",
        "sub_commands",
        "requires_argument",
        "requiresArgument",
        "cli_only",
        "config_key",
        "enabled",
    ):
        if hasattr(value, key):
            data[key] = getattr(value, key)
    return data


def normalize_slash_row(value: Any, *, source: str, category: str) -> Dict[str, Any]:
    row = object_dict(value)
    name = str(row.get("name") or row.get("command") or row.get("slug") or row.get("id") or "").strip().lstrip("/")
    text = str(row.get("text") or row.get("label") or name).strip()
    if text and not text.startswith("/"):
        text = f"/{text}"
    if not name:
        name = text.lstrip("/")
    args_hint = str(row.get("argsHint") or row.get("args_hint") or "").strip()
    clean_source = source if source in {"hermes", "skill", "quick-command", "plugin"} else "hermes"
    return {
        "id": str(row.get("id") or f"{clean_source}:{name}").strip(),
        "name": name,
        "text": text or f"/{name}",
        "label": str(row.get("label") or text or f"/{name}").strip(),
        "description": str(row.get("description") or row.get("help") or skill_description_fallback(name, clean_source)).strip(),
        "category": str(row.get("category") or category).strip(),
        "source": clean_source,
        "aliases": string_values(row.get("aliases")),
        "argsHint": args_hint,
        "subcommands": string_values(row.get("subcommands") or row.get("sub_commands")),
        "requiresArgument": bool(row.get("requiresArgument", row.get("requires_argument", args_hint.startswith("<")))),
    }


def command_available(value: Any, config: Dict[str, Any]) -> bool:
    row = object_dict(value)
    if bool(row.get("cli_only")):
        return False
    enabled = row.get("enabled")
    if enabled is False:
        return False
    config_key = str(row.get("config_key") or row.get("requires_config") or "").strip()
    if config_key and not config.get(config_key):
        return False
    return True


def command_category(value: Any, fallback: str) -> str:
    row = object_dict(value)
    return str(row.get("category") or fallback).strip() or fallback


def skill_description_fallback(name: str, source: str) -> str:
    if source == "skill":
        return f"Invoke the {name} skill"
    return ""


def string_values(value: Any) -> list[str]:
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip().lstrip("/") for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [item.strip().lstrip("/") for item in re.split(r"[, ]+", value) if item.strip()]
    return []


def dedupe_command_rows(commands: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    by_text: dict[str, Dict[str, Any]] = {}
    for command in commands:
        text = str(command.get("text") or "").strip()
        name = str(command.get("name") or "").strip()
        if not text or not name:
            continue
        key = text.lower()
        if key not in by_text:
            by_text[key] = command
    return sorted(by_text.values(), key=lambda row: str(row.get("text") or ""))


def filter_slash_command_rows(commands: list[Any], query: str) -> list[Dict[str, Any]]:
    needle = query.strip().lower()
    rows = [command for command in commands if isinstance(command, dict)]
    if not needle:
        return rows[:30]
    scored = [
        (score_slash_command_row(command, needle), command)
        for command in rows
    ]
    return [
        command
        for score, command in sorted(scored, key=lambda item: (-item[0], str(item[1].get("text") or "")))
        if score > 0
    ][:30]


def score_slash_command_row(command: Dict[str, Any], needle: str) -> int:
    name = str(command.get("name") or "").lower()
    text = str(command.get("text") or "").lower()
    aliases = [str(alias).lower() for alias in command.get("aliases", []) if str(alias).strip()]
    haystack = " ".join(
        str(command.get(key) or "")
        for key in ("description", "category", "source")
    ).lower()
    if name == needle or text == f"/{needle}":
        return 1000
    if name.startswith(needle):
        return 900 - len(name)
    if text.startswith(f"/{needle}"):
        return 850 - len(text)
    if any(alias == needle for alias in aliases):
        return 820
    if any(alias.startswith(needle) for alias in aliases):
        return 760
    if needle in name:
        return 560
    if any(needle in alias for alias in aliases):
        return 500
    if needle in haystack:
        return 120
    return 0


def default_inbound_port() -> int:
    api_port = safe_int(os.getenv("API_SERVER_PORT"), 0)
    if api_port:
        return api_port + API_TO_AGENTUI_PORT_OFFSET
    return DEFAULT_INBOUND_PORT


def current_profile_name() -> str:
    home = Path(os.getenv("HERMES_HOME") or Path.home() / ".hermes").expanduser()
    if home.parent.name == "profiles" and home.name:
        return home.name
    return "default"


def safe_text(value: object, default: str, limit: int) -> str:
    text = str(value or default or "").strip()
    if not text:
        return default
    return text[:limit]


async def inbound_payload_and_files(request) -> tuple[dict[str, object], dict[str, dict[str, object]]]:
    content_type = str(getattr(request, "content_type", "") or "").lower()
    if content_type.startswith("multipart/"):
        reader = await request.multipart()
        payload: dict[str, object] | None = None
        uploaded_files: dict[str, dict[str, object]] = {}
        async for part in reader:
            if part.name == "payload":
                payload_text = await part.text()
                parsed = json.loads(payload_text)
                if isinstance(parsed, dict):
                    payload = parsed
                continue
            if not part.name:
                continue
            uploaded_files[part.name] = {
                "filename": part.filename or "",
                "mimeType": str(part.headers.get("Content-Type") or ""),
                "bytes": await part.read(decode=False),
            }
        return payload or {}, uploaded_files
    return await request.json(), {}


def normalized_inbound_attachments(
    value: object,
    uploaded_files: dict[str, dict[str, object]] | None = None,
) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    attachments: list[dict[str, str]] = []
    uploaded_files = uploaded_files or {}
    for item in value:
        if not isinstance(item, dict):
            continue
        field = str(item.get("field") or "").strip()
        uploaded_file = uploaded_files.get(field) if field else None
        path = ""
        name = str(item.get("name") or "").strip()
        kind = str(item.get("kind") or "").strip().lower()
        mime_type = normalize_inbound_mime_type(
            kind,
            str(item.get("mimeType") or item.get("mediaType") or "").strip().lower(),
            name,
        )
        if uploaded_file is not None:
            file_bytes = uploaded_file.get("bytes")
            if isinstance(file_bytes, bytearray):
                file_bytes = bytes(file_bytes)
            if not isinstance(file_bytes, bytes) or len(file_bytes) == 0:
                raise ValueError(f"Attachment file part '{field}' is empty or missing")
            name = name or str(uploaded_file.get("filename") or "attachment").strip()
            mime_type = normalize_inbound_mime_type(
                kind,
                mime_type or str(uploaded_file.get("mimeType") or ""),
                name,
            )
            path = cache_inbound_attachment(file_bytes, name, kind, mime_type)
        else:
            continue
        attachments.append({
            "path": path,
            "name": name or Path(path).name or "attachment",
            "kind": kind,
            "mimeType": mime_type or "application/octet-stream",
        })
    return attachments


def cache_inbound_attachment(file_bytes: bytes, name: str, kind: str, mime_type: str) -> str:
    ext = attachment_extension(name, mime_type, kind)
    if kind == "audio" or mime_type.startswith("audio/"):
        return cache_audio_from_bytes(file_bytes, ext=ext or ".webm")
    if kind == "image" or mime_type.startswith("image/"):
        return cache_image_from_bytes(file_bytes, ext=ext or ".png")
    if kind == "video" or mime_type.startswith("video/"):
        return cache_video_from_bytes(file_bytes, ext=ext or ".mp4")
    filename = name or f"attachment{ext or '.bin'}"
    return cache_document_from_bytes(file_bytes, filename)


def attachment_extension(name: str, mime_type: str, kind: str) -> str:
    suffix = Path(name or "").suffix.lower()
    if suffix:
        return suffix
    guessed = mimetypes.guess_extension(mime_type or "")
    if guessed:
        return guessed
    if kind == "audio":
        return ".webm"
    if kind == "image":
        return ".png"
    if kind == "video":
        return ".mp4"
    return ".bin"


def normalize_inbound_mime_type(kind: str, mime_type: str, name: str) -> str:
    normalized = (mime_type or "").strip().lower()
    if kind == "audio" and (not normalized or normalized == "video/webm"):
        return "audio/webm"
    if normalized:
        return normalized
    guessed = mimetypes.guess_type(name)[0]
    if guessed:
        return guessed
    return mime_type_for_kind(kind)


def mime_type_for_kind(kind: str) -> str:
    if kind == "audio":
        return "audio/webm"
    if kind == "image":
        return "image/png"
    if kind == "video":
        return "video/mp4"
    if kind in {"document", "code"}:
        return "text/plain"
    return "application/octet-stream"


def message_type_for_attachments(attachments: list[dict[str, str]]) -> MessageType:
    if not attachments:
        return MessageType.TEXT
    if any(attachment["kind"] == "audio" or attachment["mimeType"].startswith("audio/") for attachment in attachments):
        return MessageType.VOICE
    if any(attachment["kind"] == "image" or attachment["mimeType"].startswith("image/") for attachment in attachments):
        return MessageType.PHOTO
    if any(attachment["kind"] == "video" or attachment["mimeType"].startswith("video/") for attachment in attachments):
        return MessageType.VIDEO
    return MessageType.DOCUMENT


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


def strip_stream_cursor(content: str) -> str:
    return content.removesuffix(" ▉")


def api_error(text: str) -> str:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text.strip()
    if isinstance(parsed, dict):
        return str(parsed.get("error") or parsed.get("detail") or "").strip()
    return text.strip()
