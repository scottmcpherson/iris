"""FastAPI application and CLI entrypoint."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import secrets
import threading
import time
import urllib.parse
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .attachment_helpers import safe_attachment_name
from .attachment_routes import register_attachment_routes
from .attachment_types import (
    attachment_kind,
    attachment_mime_type,
)
from .core_store import (
    DEFAULT_RUNTIME_ID,
    CoreStore,
    chat_id_for_session,
    clamp_int,
    client_attachment_payload,
    draft_session,
    now,
    random_id,
    stable_hash,
)
from .message_coalescer import (
    coalesce_core_messages,
    has_stream_message_id,
    merge_client_attachments,
    prepare_assistant_delivery_event,
)
from .models import (
    AgentCreateRequest,
    AgentMemoryResetRequest,
    AgentMemorySaveRequest,
    AgentRenameRequest,
    AgentSkillSaveRequest,
    CoreAutomationCreateRequest,
    CoreAutomationUpdateRequest,
    CoreSessionCreateRequest,
    CoreSessionUpdateRequest,
    CoreMessageCreateRequest,
    SessionReadStateUpdateRequest,
    DeviceCursorUpdateRequest,
    DevicePairRequest,
    ErrorResponse,
    HealthResponse,
    InboxHealthResponse,
    InboxMessageCreateRequest,
    InboxMessageResponse,
    InboxMessagesResponse,
    ProjectSessionLinkRequest,
    ProjectCreateRequest,
    ProjectUpdateRequest,
    ProfileSummary,
    RuntimeDeliveryHermesRequest,
    StatusResponse,
)
from .runtime_registry import RuntimeRegistry
from .runtime_adapters.hermes_store import checked_at, normalize_hermes_home
from .security import ManagementError, device_token_hash, host_is_loopback, make_auth_dependency


DEFAULT_CORS_ORIGINS = (
    "tauri://localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
)
DEFAULT_RUNTIME_THREAD_LIMIT = 16
DEFAULT_RUNTIME_CALL_TIMEOUT_SECONDS = 30

logger = logging.getLogger(__name__)


class LiveDeliveryBus:
    def __init__(self, *, max_events: int = 500, ttl_seconds: int = 900) -> None:
        self.max_events = max_events
        self.ttl_seconds = ttl_seconds
        self._events: deque[dict[str, Any]] = deque(maxlen=max_events)
        self._cursor = 0
        self._lock = threading.RLock()

    def publish(self, event: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            event_id = str(event.get("id") or "")
            if event_id:
                existing = next((row for row in self._events if row["id"] == event_id), None)
                if existing:
                    return existing
            self._cursor += 1
            payload = {
                "cursor": self._cursor,
                "id": event_id or random_id("evt"),
                "sessionId": str(event.get("sessionId") or ""),
                "agentId": str(event.get("agentId") or ""),
                "runtimeId": str(event.get("runtimeId") or ""),
                "type": str(event.get("type") or "message.assistant.completed"),
                "role": str(event.get("role") or ""),
                "content": str(event.get("content") or ""),
                "parentEventId": str(event.get("parentEventId") or ""),
                "externalMessageId": str(event.get("externalMessageId") or ""),
                "idempotencyKey": str(event.get("idempotencyKey") or ""),
                "createdAt": int(event.get("createdAt") or now()),
                "metadata": event.get("metadata") if isinstance(event.get("metadata"), dict) else {},
            }
            self._events.append(payload)
            self.prune()
            return payload

    def list_events(
        self,
        *,
        after: int = 0,
        limit: int = 200,
        session_id: str = "",
        agent_id: str = "",
    ) -> list[dict[str, Any]]:
        with self._lock:
            self.prune()
            rows = [
                event
                for event in self._events
                if event["cursor"] > after
                and (not session_id or event["sessionId"] == session_id)
                and (not agent_id or event["agentId"] == agent_id)
            ]
            return rows[:limit]

    def latest_cursor(self, *, session_id: str = "", agent_id: str = "") -> int:
        with self._lock:
            self.prune()
            for event in reversed(self._events):
                if session_id and event["sessionId"] != session_id:
                    continue
                if agent_id and event["agentId"] != agent_id:
                    continue
                return int(event["cursor"])
            return self._cursor

    def prune(self) -> None:
        with self._lock:
            cutoff = int(time.time()) - self.ttl_seconds
            while self._events and int(self._events[0].get("createdAt") or 0) < cutoff:
                self._events.popleft()


@dataclass(frozen=True)
class Settings:
    hermes_home: str | None = None
    host: str = "127.0.0.1"
    port: int = 8765
    token: str | None = None
    inbox_token: str | None = None
    runtime_delivery_token: str | None = None
    core_store_path: str | None = None
    cors_origins: tuple[str, ...] = ()

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            hermes_home=os.environ.get("HERMES_HOME") or None,
            host=os.environ.get("IRIS_CORE_HOST") or os.environ.get("HERMES_MGMT_HOST") or "127.0.0.1",
            port=parse_port(os.environ.get("IRIS_CORE_PORT") or os.environ.get("HERMES_MGMT_PORT"), 8765),
            token=os.environ.get("IRIS_CORE_TOKEN") or os.environ.get("HERMES_MGMT_TOKEN") or None,
            inbox_token=os.environ.get("IRIS_INBOX_TOKEN") or os.environ.get("AGENTUI_INBOX_TOKEN") or None,
            runtime_delivery_token=(
                os.environ.get("IRIS_RUNTIME_DELIVERY_TOKEN")
                or os.environ.get("AGENTUI_RUNTIME_DELIVERY_TOKEN")
                or None
            ),
            core_store_path=os.environ.get("IRIS_CORE_STORE") or os.environ.get("AGENTUI_CORE_STORE") or None,
            cors_origins=parse_cors_origins(
                os.environ.get("IRIS_CORE_CORS_ORIGINS") or os.environ.get("HERMES_MGMT_CORS_ORIGINS")
            ) or DEFAULT_CORS_ORIGINS,
        )


def parse_port(value: str | None, default: int) -> int:
    if not value:
        return default
    try:
        port = int(value)
    except ValueError as exc:
        raise SystemExit(f"Invalid port: {value}") from exc
    if port < 1 or port > 65535:
        raise SystemExit(f"Port must be between 1 and 65535: {port}")
    return port


def parse_cors_origins(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(origin.strip() for origin in value.split(",") if origin.strip())


async def run_runtime_call(app: FastAPI, func, *args, timeout: int = DEFAULT_RUNTIME_CALL_TIMEOUT_SECONDS, **kwargs):
    semaphore: asyncio.Semaphore = app.state.runtime_call_semaphore
    async with semaphore:
        try:
            return await asyncio.wait_for(asyncio.to_thread(func, *args, **kwargs), timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise ManagementError("Runtime request timed out.", status_code=504) from exc


def agentui_platform_token(hermes_home: os.PathLike[str] | str) -> str:
    return (
        os.environ.get("IRIS_TOKEN", "").strip()
        or os.environ.get("AGENTUI_TOKEN", "").strip()
        or os.environ.get("IRIS_INBOX_TOKEN", "").strip()
        or os.environ.get("AGENTUI_INBOX_TOKEN", "").strip()
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "IRIS_TOKEN")
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "AGENTUI_TOKEN")
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "IRIS_INBOX_TOKEN")
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "AGENTUI_INBOX_TOKEN")
    )


def hermes_api_token(hermes_home: os.PathLike[str] | str) -> str:
    return (
        os.environ.get("HERMES_API_TOKEN", "").strip()
        or os.environ.get("HERMES_REMOTE_TOKEN", "").strip()
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "HERMES_API_TOKEN")
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "HERMES_REMOTE_TOKEN")
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "API_SERVER_KEY")
    )


def env_file_value(path: str, key: str) -> str:
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return ""
    prefix = f"{key}="
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or not stripped.startswith(prefix):
            continue
        return stripped[len(prefix):].strip().strip("\"'")
    return ""


def model_switch_command(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    model = str(value.get("model") or "").strip()
    if not model:
        return ""
    provider = str(value.get("provider") or "").strip()
    return f"/model {model}{f' --provider {provider}' if provider else ''}"


def normalize_attachment_refs(refs: list[Any]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for ref in refs:
        if hasattr(ref, "model_dump"):
            ref = ref.model_dump()
        if isinstance(ref, dict):
            normalized.append(ref)
    return normalized


GENERATED_FILE_MARKER_RE = re.compile(
    r"^\s*(?:Generated\s+file:\s*)?(?:[^\w\s/\\.:~-]+\s*)?(MEDIA|Media|Image|File):\s*(.+?)\s*$"
)


def generated_file_refs_from_delivery(content: str, metadata: dict[str, Any]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for item in metadata.get("generatedFiles") if isinstance(metadata.get("generatedFiles"), list) else []:
        if isinstance(item, dict):
            refs.extend(generated_file_ref_from_mapping(item, source="metadata.generatedFiles"))
    for item in metadata.get("attachments") if isinstance(metadata.get("attachments"), list) else []:
        if isinstance(item, dict):
            refs.extend(generated_file_ref_from_mapping(item, source="metadata.attachments"))
    refs.extend(generated_file_refs_from_text(content))
    return dedupe_generated_file_refs(refs)


def generated_file_refs_from_text(content: str) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for line in str(content or "").splitlines():
        marker = generated_file_marker_from_line(line)
        if not marker:
            continue
        refs.append(marker)
    return dedupe_generated_file_refs(refs)


def generated_file_ref_from_mapping(item: dict[str, Any], *, source: str) -> list[dict[str, Any]]:
    path_value = str(item.get("path") or item.get("localPath") or "").strip()
    path = generated_local_path(path_value)
    if not path:
        return []
    return [
        {
            "path": str(path),
            "name": safe_attachment_name(str(item.get("name") or path.name)),
            "mimeType": str(item.get("mimeType") or ""),
            "kind": str(item.get("kind") or ""),
            "source": source,
        }
    ]


def generated_file_marker_from_line(line: str) -> dict[str, Any] | None:
    match = GENERATED_FILE_MARKER_RE.match(line)
    if not match:
        return None
    path = generated_local_path(match.group(2).strip())
    if not path:
        return None
    marker_kind = match.group(1).lower()
    return {
        "path": str(path),
        "name": safe_attachment_name(path.name),
        "kind": "image" if marker_kind == "image" else "",
        "mimeType": "",
        "source": "content-marker",
        "marker": line,
    }


def generated_local_path(value: str) -> Path | None:
    raw = str(value or "").strip().strip("'\"")
    if not raw:
        return None
    if raw.startswith("file://"):
        parsed = urllib.parse.urlparse(raw)
        if parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
            return None
        raw = urllib.parse.unquote(parsed.path)
    path = Path(raw).expanduser()
    if not path.is_absolute():
        return None
    return path.resolve(strict=False)


def dedupe_generated_file_refs(refs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for ref in refs:
        path = str(ref.get("path") or "")
        if not path or path in seen:
            continue
        seen.add(path)
        deduped.append(ref)
    return deduped


def strip_generated_file_markers(content: str, attachments: list[dict[str, Any]]) -> str:
    if not attachments:
        return content
    imported_paths = {
        str((attachment.get("metadata") if isinstance(attachment.get("metadata"), dict) else {}).get("originalPath") or "")
        for attachment in attachments
    }
    imported_paths = {path for path in imported_paths if path}
    if not imported_paths:
        return content
    return strip_generated_file_markers_for_paths(content, imported_paths)


def strip_generated_file_markers_for_paths(content: str, imported_paths: set[str]) -> str:
    if not imported_paths:
        return content
    lines: list[str] = []
    for line in str(content or "").splitlines():
        marker = generated_file_marker_from_line(line)
        if marker and str(marker.get("path") or "") in imported_paths:
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def ingest_generated_file_attachments(
    app: FastAPI,
    *,
    runtime_id: str,
    profile: str,
    chat_id: str,
    session_id: str,
    message_id: str,
    content: str,
    metadata: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    refs = generated_file_refs_from_delivery(content, metadata)
    if not refs:
        return content, metadata

    imported: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    for ref in refs:
        source_path = Path(str(ref.get("path") or ""))
        try:
            with source_path.open("rb") as file:
                head = file.read(2048)
            name = safe_attachment_name(str(ref.get("name") or source_path.name))
            mime_type = attachment_mime_type(
                filename=name,
                content_type=str(ref.get("mimeType") or ""),
                head=head,
            )
            attachment = app.state.core_store.create_attachment_from_path(
                source_path=source_path,
                runtime_id=runtime_id,
                profile=profile,
                session_id=session_id,
                message_id=message_id,
                name=name,
                mime_type=mime_type,
                kind=attachment_kind(mime_type, name, str(ref.get("kind") or "")),
                metadata={
                    "createdBy": "assistant",
                    "source": str(ref.get("source") or "runtime-delivery"),
                    "originalPath": str(source_path),
                    "deliveryMessageId": message_id,
                },
            )
            imported.append(attachment)
        except (OSError, ValueError) as exc:
            warnings.append({
                "path": str(source_path),
                "source": str(ref.get("source") or "runtime-delivery"),
                "warning": str(exc),
            })

    if not imported and not warnings:
        return content, metadata

    if imported:
        app.state.core_store.link_message_attachments(
            runtime_id=runtime_id,
            profile=profile,
            chat_id=chat_id,
            message_id=message_id,
            attachments=imported,
        )

    client_attachments = [client_attachment_payload(attachment) for attachment in imported]
    next_metadata = {
        **metadata,
        "generatedFiles": refs,
        **({"attachments": merge_client_attachments(metadata.get("attachments"), client_attachments)} if client_attachments else {}),
        **({"generatedFileImports": generated_file_import_payloads(imported)} if imported else {}),
        **({"generatedFileImportWarnings": warnings} if warnings else {}),
    }
    return strip_generated_file_markers(content, imported), next_metadata


def generated_file_import_payloads(attachments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    for attachment in attachments:
        metadata = attachment.get("metadata") if isinstance(attachment.get("metadata"), dict) else {}
        payloads.append({
            "attachmentId": str(attachment.get("id") or ""),
            "name": str(attachment.get("name") or ""),
            "originalPath": str(metadata.get("originalPath") or ""),
            "sha256": str(attachment.get("sha256") or ""),
        })
    return payloads


def generated_file_paths_from_metadata(metadata: dict[str, Any]) -> set[str]:
    paths: set[str] = set()
    for item in metadata.get("generatedFiles") if isinstance(metadata.get("generatedFiles"), list) else []:
        if not isinstance(item, dict):
            continue
        path = generated_local_path(str(item.get("path") or ""))
        if path:
            paths.add(str(path))
    for item in metadata.get("generatedFileImports") if isinstance(metadata.get("generatedFileImports"), list) else []:
        if not isinstance(item, dict):
            continue
        path = generated_local_path(str(item.get("originalPath") or ""))
        if path:
            paths.add(str(path))
    return paths


def persist_assistant_attachment_metadata(
    app: FastAPI,
    *,
    runtime_id: str,
    profile: str,
    chat_id: str,
    message_id: str,
    stream_message_id: str,
    content: str,
    original_content: str,
    metadata: dict[str, Any],
) -> None:
    has_attachments = bool(metadata.get("attachments"))
    reply_to = str(metadata.get("replyTo") or metadata.get("reply_to") or "")
    if not has_attachments and not reply_to:
        return
    overlay: dict[str, Any]
    if has_attachments:
        overlay = metadata
    else:
        overlay = {"replyTo": reply_to}
    message_ids = [message_id]
    if stream_message_id and stream_message_id not in message_ids:
        message_ids.append(stream_message_id)
    contents = [content]
    if original_content != content:
        contents.append(original_content)
    for index, message_key in enumerate(message_ids):
        for content_index, content_value in enumerate(contents):
            key = message_key if index == 0 and content_index == 0 else f"{message_key}:overlay:{content_index}"
            app.state.core_store.upsert_client_message_metadata(
                runtime_id=runtime_id,
                profile=profile,
                chat_id=chat_id,
                message_id=key,
                content=content_value,
                metadata=overlay,
            )


def import_generated_file_history_attachments(
    app: FastAPI,
    *,
    session: dict[str, Any],
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    chat_id = str(session.get("externalChatId") or "")
    runtime_id = str(session.get("runtimeId") or DEFAULT_RUNTIME_ID)
    profile = str(session.get("runtimeProfile") or "default")
    session_id = str(session.get("id") or "")
    if not chat_id or not runtime_id or not profile or not session_id:
        return messages

    enriched: list[dict[str, Any]] = []
    for message in messages:
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        if message.get("role") != "assistant":
            enriched.append(message)
            continue
        content = str(message.get("content") or "")
        marker_refs = generated_file_refs_from_text(content)
        if not marker_refs:
            enriched.append(message)
            continue
        if metadata.get("attachments"):
            imported_paths = generated_file_paths_from_metadata(metadata)
            if not imported_paths:
                imported_paths = {str(ref.get("path") or "") for ref in marker_refs if ref.get("path")}
            enriched.append({
                **message,
                "content": strip_generated_file_markers_for_paths(content, imported_paths),
                "metadata": metadata,
            })
            continue
        message_id = str(message.get("id") or random_id("history_msg"))
        cleaned_content, next_metadata = ingest_generated_file_attachments(
            app,
            runtime_id=runtime_id,
            profile=profile,
            chat_id=chat_id,
            session_id=session_id,
            message_id=message_id,
            content=content,
            metadata={**metadata, "source": str(metadata.get("source") or "hermes-history")},
        )
        persist_assistant_attachment_metadata(
            app,
            runtime_id=runtime_id,
            profile=profile,
            chat_id=chat_id,
            message_id=message_id,
            stream_message_id=str(next_metadata.get("streamMessageId") or next_metadata.get("stream_message_id") or ""),
            content=cleaned_content,
            original_content=content,
            metadata=next_metadata,
        )
        enriched.append({
            **message,
            "content": cleaned_content if next_metadata.get("attachments") else content,
            "metadata": next_metadata,
        })
    return enriched


def create_app(settings: Settings | None = None) -> FastAPI:
    app_settings = settings or Settings.from_env()
    hermes_root = normalize_hermes_home(app_settings.hermes_home)
    auto_migrate_core = os.environ.get("IRIS_CORE_DISABLE_SOURCE_OF_TRUTH_MIGRATION") != "1"
    core_store_path = app_settings.core_store_path
    if core_store_path is None and app_settings.hermes_home:
        core_store_path = str(Path(app_settings.hermes_home).expanduser().parent / ".iris" / "core.sqlite3")
    core_store = CoreStore(core_store_path, auto_migrate=auto_migrate_core)
    app = FastAPI(
        title="Iris Core",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        default_response_class=JSONResponse,
        responses={400: {"model": ErrorResponse}, 401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
    )
    app.state.hermes_root = hermes_root
    app.state.core_store = core_store
    app.state.settings = app_settings
    platform_token = agentui_platform_token(hermes_root)
    app.state.management_token = app_settings.token or ""
    app.state.inbox_token = app_settings.inbox_token or app_settings.token or platform_token or ""
    app.state.runtime_delivery_token = (
        app_settings.runtime_delivery_token
        or app_settings.inbox_token
        or app_settings.token
        or platform_token
        or ""
    )
    app.state.runtime_registry = RuntimeRegistry(
        core_store=core_store,
        hermes_home=str(hermes_root),
        management_url=f"http://{app_settings.host}:{app_settings.port}",
        agentui_token=platform_token,
        hermes_api_token=hermes_api_token(hermes_root),
    )
    app.state.runtime_registry.ensure_default_runtime()
    app.state.live_delivery_bus = LiveDeliveryBus()
    app.state.runtime_call_semaphore = asyncio.Semaphore(
        clamp_int(
            os.environ.get("IRIS_RUNTIME_THREAD_LIMIT"),
            default=DEFAULT_RUNTIME_THREAD_LIMIT,
            minimum=1,
            maximum=128,
        )
    )
    app.state.active_sessions = {}
    app.state.active_sessions_by_chat = {}
    app.state.accepted_client_messages = {}
    app.state.inbox_acknowledged_at = {}
    if app_settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(app_settings.cors_origins),
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
        )

    @app.exception_handler(ManagementError)
    async def management_error_handler(_request, exc: ManagementError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"ok": False, "error": exc.error})

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(_request, exc: StarletteHTTPException) -> JSONResponse:
        error = str(exc.detail or "Request failed.")
        return JSONResponse(status_code=exc.status_code, content={"ok": False, "error": error})

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"ok": False, "error": str(exc)})

    @app.exception_handler(Exception)
    async def unexpected_error_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled Iris Core error on %s %s", request.method, request.url.path, exc_info=exc)
        return JSONResponse(status_code=500, content={"ok": False, "error": "Internal server error."})

    require_auth = make_auth_dependency()
    require_inbox_auth = make_auth_dependency("inbox_token")
    require_runtime_delivery_auth = make_auth_dependency("runtime_delivery_token")

    @app.get("/health", response_model=HealthResponse)
    async def health(_auth: None = Depends(require_auth)) -> HealthResponse:
        return HealthResponse(
            checkedAt=checked_at(),
            hermesHome=str(hermes_root),
            profilesRootExists=(hermes_root / "profiles").is_dir(),
        )

    @app.get("/v1/health")
    async def core_health(_auth: None = Depends(require_auth)) -> dict[str, Any]:
        return {
            "ok": True,
            "checkedAt": checked_at(),
            "service": "iris-core",
            "hermesHome": str(hermes_root),
            "profilesRootExists": (hermes_root / "profiles").is_dir(),
            "core": core_store.health(),
        }

    register_attachment_routes(app, require_auth)

    @app.get("/v1/devices")
    async def core_devices(_auth: None = Depends(require_auth)) -> dict[str, Any]:
        return {"ok": True, "devices": core_store.list_devices()}

    @app.get("/v1/devices/me")
    async def core_current_device(request: Request, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        device = getattr(request.state, "agentui_device", None)
        return {
            "ok": True,
            "device": device if isinstance(device, dict) else None,
            "auth": core_auth_payload(request.app),
        }

    @app.post("/v1/devices/pair")
    async def core_pair_device(pairing: DevicePairRequest, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        raw_token = f"agui_{secrets.token_urlsafe(32)}"
        device = core_store.create_device(
            name=pairing.name,
            kind=pairing.kind,
            token_hash=device_token_hash(raw_token),
            metadata=pairing.metadata,
        )
        return {
            "ok": True,
            "device": device,
            "token": raw_token,
            "tokenShownOnce": True,
        }

    @app.delete("/v1/devices/{device_id}")
    async def core_revoke_device(device_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        if device_id == "management-token":
            raise ManagementError("The management token cannot be revoked through the device API.", status_code=400)
        device = core_store.revoke_device(device_id)
        if not device:
            raise ManagementError("Device was not found.", status_code=404)
        return {"ok": True, "device": device}

    @app.post("/v1/devices/me/cursors")
    async def core_update_device_cursor(
        cursor: DeviceCursorUpdateRequest,
        request: Request,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        device = getattr(request.state, "agentui_device", None)
        device_id = str(device.get("id") or "") if isinstance(device, dict) else ""
        if not device_id.startswith("dev_"):
            raise ManagementError("A paired device token is required for device cursors.", status_code=401)
        return {
            "ok": True,
            "cursor": core_store.upsert_device_cursor(device_id, cursor.streamName, cursor.lastCursor),
        }

    @app.get("/v1/inbox/health", response_model=InboxHealthResponse)
    async def inbox_health(
        request: Request,
        _auth: None = Depends(require_inbox_auth),
    ) -> InboxHealthResponse:
        del request
        return InboxHealthResponse(checkedAt=checked_at(), path="", storage="memory")

    @app.post("/v1/inbox/messages", response_model=InboxMessageResponse)
    async def inbox_create_message(
        message: InboxMessageCreateRequest,
        request: Request,
        _auth: None = Depends(require_inbox_auth),
    ) -> InboxMessageResponse:
        payload = inbox_message_from_payload(dump_model(message))
        event = mirror_inbox_message_to_core(request.app, payload)
        payload["cursor"] = int(event.get("cursor") or 0) if event else 0
        return InboxMessageResponse(message=payload)

    @app.get("/v1/inbox/messages", response_model=InboxMessagesResponse)
    async def inbox_messages(
        request: Request,
        after: int = Query(0),
        limit: int = Query(50),
        profile: str | None = Query(None),
        _auth: None = Depends(require_inbox_auth),
    ) -> InboxMessagesResponse:
        after = clamp_int(after, default=0, minimum=0, maximum=9_223_372_036_854_775_807)
        limit = clamp_int(limit, default=50, minimum=1, maximum=200)
        events = request.app.state.live_delivery_bus.list_events(after=after, limit=limit)
        messages = [
            inbox_message_from_event(request.app, event)
            for event in events
            if not profile or str(event.get("metadata", {}).get("profile") or "") == profile
        ]
        cursor = messages[-1]["cursor"] if messages else request.app.state.live_delivery_bus.latest_cursor()
        return InboxMessagesResponse(messages=messages, cursor=cursor)

    @app.post("/v1/inbox/messages/{message_id}/ack", response_model=InboxMessageResponse)
    async def inbox_ack_message(
        message_id: str,
        request: Request,
        _auth: None = Depends(require_inbox_auth),
    ) -> InboxMessageResponse:
        acknowledged_at = now()
        request.app.state.inbox_acknowledged_at[str(message_id)] = acknowledged_at
        message = inbox_message_for_id(request.app, message_id)
        if not message:
            raise ManagementError("Inbox message was not found.", status_code=404)
        message["acknowledgedAt"] = acknowledged_at
        return InboxMessageResponse(message=message)

    @app.get("/v1/status", response_model=StatusResponse)
    async def status(_auth: None = Depends(require_auth)) -> StatusResponse:
        profiles = [profile_summary_from_agent(agent) for agent in app.state.runtime_registry.agents()]
        active = next((profile.name for profile in profiles if profile.active), "default")
        return StatusResponse(
            checkedAt=checked_at(),
            hermesHome=str(hermes_root),
            activeProfile=active,
            profileCount=len(profiles),
            core=core_status_payload(request_app=app),
        )

    @app.get("/v1/runtimes")
    async def runtimes(_auth: None = Depends(require_auth)) -> dict[str, Any]:
        return {"ok": True, "runtimes": app.state.runtime_registry.runtimes()}

    @app.get("/v1/runtimes/{runtime_id}")
    async def runtime_detail(runtime_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        runtime = app.state.runtime_registry.runtime(runtime_id)
        if not runtime:
            raise ManagementError("Runtime was not found.", status_code=404)
        return {"ok": True, "runtime": runtime}

    @app.post("/v1/runtimes/{runtime_id}/probe")
    async def runtime_probe(runtime_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        runtime = app.state.runtime_registry.runtime(runtime_id)
        if not runtime:
            raise ManagementError("Runtime was not found.", status_code=404)
        profile = "default"
        agent = next((row for row in app.state.runtime_registry.agents() if row["runtimeId"] == runtime_id and row["isDefault"]), None)
        if agent:
            profile = agent["runtimeProfile"]
        probe = await run_runtime_call(app, app.state.runtime_registry.probe, runtime_id, profile=profile)
        return {"ok": True, "runtime": runtime, "probe": probe}

    @app.get("/v1/agents")
    async def agents(_auth: None = Depends(require_auth)) -> dict[str, Any]:
        return {"ok": True, "agents": app.state.runtime_registry.agents()}

    @app.get("/v1/agents/{agent_id}")
    async def agent_detail(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        return {"ok": True, "agent": agent}

    @app.post("/v1/agents")
    async def core_create_agent(
        request: AgentCreateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        runtime_id = request.runtimeId or DEFAULT_RUNTIME_ID
        adapter = app.state.runtime_registry.adapter_for_runtime(runtime_id)
        agent = await run_runtime_call(app, adapter.create_agent, request.name, request.metadata)
        return {"ok": True, "agent": agent}

    @app.post("/v1/agents/{agent_id}/clone")
    async def core_clone_agent(
        agent_id: str,
        request: AgentCreateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        cloned = await run_runtime_call(app, adapter.clone_agent, agent, request.name)
        return {"ok": True, "agent": cloned}

    @app.patch("/v1/agents/{agent_id}")
    async def core_rename_agent(
        agent_id: str,
        request: AgentRenameRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        renamed = await run_runtime_call(app, adapter.rename_agent, agent, request.name)
        return {"ok": True, "agent": renamed}

    @app.delete("/v1/agents/{agent_id}")
    async def core_delete_agent(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        next_agent = await run_runtime_call(app, adapter.delete_agent, agent)
        return {"ok": True, "agent": next_agent}

    @app.post("/v1/agents/{agent_id}/activate")
    async def core_activate_agent(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        activated = await run_runtime_call(app, adapter.activate_agent, agent)
        return {"ok": True, "agent": activated}

    @app.get("/v1/agents/{agent_id}/memory")
    async def core_agent_memory(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return await run_runtime_call(app, adapter.agent_memory, agent)

    @app.put("/v1/agents/{agent_id}/memory/{file}")
    async def core_save_agent_memory(
        agent_id: str,
        file: str,
        request: AgentMemorySaveRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        memory = await run_runtime_call(app, 
            adapter.save_agent_memory,
            agent,
            file,
            request.content,
            request.expectedUpdatedAt,
        )
        return {"ok": True, "profile": memory["profile"], "memory": memory}

    @app.delete("/v1/agents/{agent_id}/memory/{file}")
    async def core_reset_agent_memory(
        agent_id: str,
        file: str,
        request: AgentMemoryResetRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        if request.confirm != "RESET MEMORY":
            raise ManagementError("Type RESET MEMORY to confirm destructive memory reset.", status_code=400)
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        memory = await run_runtime_call(app, adapter.reset_agent_memory, agent, file)
        return {"ok": True, "profile": memory["profile"], "memory": memory}

    @app.get("/v1/agents/{agent_id}/skills")
    async def core_agent_skills(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return await run_runtime_call(app, adapter.list_agent_skills, agent)

    @app.get("/v1/agents/{agent_id}/skills/{skill_id}")
    async def core_agent_skill_detail(
        agent_id: str,
        skill_id: str,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return await run_runtime_call(app, adapter.get_agent_skill, agent, skill_id)

    @app.post("/v1/agents/{agent_id}/skills")
    async def core_create_agent_skill(
        agent_id: str,
        request: AgentSkillSaveRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return await run_runtime_call(app, adapter.create_agent_skill, agent, dump_model(request))

    @app.put("/v1/agents/{agent_id}/skills/{skill_id}")
    async def core_save_agent_skill(
        agent_id: str,
        skill_id: str,
        request: AgentSkillSaveRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return await run_runtime_call(app, adapter.save_agent_skill, agent, skill_id, dump_model(request))

    @app.get("/v1/projects")
    async def core_projects(
        includeArchived: bool = Query(False),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        return {
            "ok": True,
            "projects": app.state.core_store.list_projects(include_archived=includeArchived),
        }

    @app.post("/v1/projects")
    async def core_create_project(
        request: ProjectCreateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        if not app.state.runtime_registry.agent(request.defaultAgentId):
            raise ManagementError("Default agent was not found.", status_code=404)
        try:
            project = app.state.core_store.create_project(
                name=request.name,
                default_agent_id=request.defaultAgentId,
                system_prompt=request.systemPrompt,
                metadata=request.metadata,
            )
        except ValueError as exc:
            raise ManagementError(str(exc), status_code=400) from exc
        return {"ok": True, "project": project}

    @app.get("/v1/projects/{project_id}")
    async def core_project(project_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        project = app.state.core_store.get_project(project_id)
        if not project:
            raise ManagementError("Project was not found.", status_code=404)
        return {"ok": True, "project": project}

    @app.patch("/v1/projects/{project_id}")
    async def core_update_project(
        project_id: str,
        request: ProjectUpdateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        if request.defaultAgentId is not None and not app.state.runtime_registry.agent(request.defaultAgentId):
            raise ManagementError("Default agent was not found.", status_code=404)
        try:
            project = app.state.core_store.update_project(
                project_id,
                name=request.name,
                default_agent_id=request.defaultAgentId,
                system_prompt=request.systemPrompt,
                metadata=request.metadata,
            )
        except ValueError as exc:
            raise ManagementError(str(exc), status_code=400) from exc
        if not project:
            raise ManagementError("Project was not found.", status_code=404)
        return {"ok": True, "project": project}

    @app.delete("/v1/projects/{project_id}")
    async def core_archive_project(project_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        project = app.state.core_store.archive_project(project_id)
        if not project:
            raise ManagementError("Project was not found.", status_code=404)
        return {"ok": True, "project": project}

    @app.get("/v1/projects/{project_id}/sessions")
    async def core_project_sessions(
        project_id: str,
        limit: int = Query(80),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        project = app.state.core_store.get_project(project_id)
        if not project:
            raise ManagementError("Project was not found.", status_code=404)
        limit = clamp_int(limit, default=80, minimum=1, maximum=200)
        sessions = with_read_states(app, project_sessions(app, project)[:limit])
        return {"ok": True, "sessions": sessions}

    @app.post("/v1/projects/{project_id}/sessions")
    async def core_link_project_session(
        project_id: str,
        request: ProjectSessionLinkRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        project = app.state.core_store.get_project(project_id)
        if not project:
            raise ManagementError("Project was not found.", status_code=404)
        session = resolve_core_session(app, request.sessionId)
        if not session:
            raise ManagementError("Session was not found.", status_code=404)
        link = app.state.core_store.link_project_session(project_id, session)
        return {"ok": True, "link": link, "session": with_project_metadata(session, project)}

    @app.delete("/v1/projects/{project_id}/sessions/{session_id}")
    async def core_unlink_project_session(
        project_id: str,
        session_id: str,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        if not app.state.core_store.get_project(project_id):
            raise ManagementError("Project was not found.", status_code=404)
        app.state.core_store.unlink_project_session(project_id, session_id)
        return {"ok": True, "projectId": project_id, "sessionId": session_id}

    @app.get("/v1/sessions")
    async def core_sessions(
        agentId: str | None = Query(None),
        limit: int = Query(80),
        cursor: int = Query(0),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        del cursor
        limit = clamp_int(limit, default=80, minimum=1, maximum=200)
        agent = app.state.runtime_registry.agent(agentId) if agentId else None
        if agentId and not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        agents = [agent] if agent else app.state.runtime_registry.agents()
        sessions: list[dict[str, Any]] = []
        for item in [row for row in agents if row]:
            adapter = app.state.runtime_registry.adapter_for_runtime(item["runtimeId"])
            sessions.extend(await run_runtime_call(app, adapter.list_sessions, item, limit))
        sessions.sort(key=lambda row: int(row.get("updatedAt") or 0), reverse=True)
        sessions = with_read_states(app, sessions)
        return {
            "ok": True,
            "sessions": sessions[:limit],
        }

    @app.post("/v1/sessions")
    async def core_create_session(
        request: CoreSessionCreateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        project = app.state.core_store.get_project(request.projectId) if request.projectId else None
        if request.projectId and not project:
            raise ManagementError("Project was not found.", status_code=404)
        agent_id = request.agentId or (project["defaultAgentId"] if project else "")
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        external_chat_id = (request.externalChatId or "").strip() or f"core-{secrets.token_urlsafe(18)}"
        external_session_id = (request.externalSessionId or "").strip()
        metadata = dict(request.metadata)
        if project:
            metadata["projectId"] = project["id"]
        session = draft_session(
            agent,
            title=request.title,
            external_chat_id=external_chat_id,
            external_session_id=external_session_id,
            metadata=metadata,
        )
        remember_active_session(app, session)
        if project:
            app.state.core_store.link_project_session(project["id"], session)
            session = with_project_metadata(session, project)
        session = with_read_state(app, session)
        return {"ok": True, "session": session}

    @app.get("/v1/sessions/{session_id}")
    async def core_session_detail(
        session_id: str,
        externalSessionId: str | None = Query(None),
        externalChatId: str | None = Query(None),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        session = resolve_core_session(
            app,
            session_id,
            external_session_id=externalSessionId or "",
            external_chat_id=externalChatId or "",
            prefer_runtime=True,
        )
        if not session:
            raise ManagementError("Session was not found.", status_code=404)
        remember_active_session(app, session)
        return {"ok": True, "session": with_read_state(app, session)}

    @app.patch("/v1/sessions/{session_id}")
    async def core_update_session(
        session_id: str,
        request: CoreSessionUpdateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        session = resolve_core_session(app, session_id)
        if not session:
            raise ManagementError("Session was not found.", status_code=404)
        if request.title is None:
            return {"ok": True, "session": with_read_state(app, session)}
        title = request.title.strip()
        if not title:
            raise ManagementError("Session title is required.", status_code=400)
        adapter = app.state.runtime_registry.adapter_for_runtime(session["runtimeId"])
        updated = await run_runtime_call(app, 
            adapter.rename_session,
            session_agent(app, session),
            session,
            title,
        )
        remember_active_session(app, updated)
        return {"ok": True, "session": with_read_state(app, updated)}

    @app.delete("/v1/sessions/{session_id}")
    async def core_delete_session(
        session_id: str,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        session = resolve_core_session(app, session_id)
        if not session:
            raise ManagementError("Session was not found.", status_code=404)
        agent = session_agent(app, session)
        adapter = app.state.runtime_registry.adapter_for_runtime(session["runtimeId"])
        deleted = await run_runtime_call(app, adapter.delete_session, agent, session)
        app.state.core_store.delete_session_overlays(
            session_id=session_id,
            runtime_id=str(session.get("runtimeId") or agent["runtimeId"]),
            profile=str(session.get("runtimeProfile") or agent["runtimeProfile"]),
            chat_id=str(session.get("externalChatId") or ""),
        )
        forget_active_session(app, session_id, deleted)
        return {"ok": True, "sessionId": session_id}

    @app.get("/v1/sessions/{session_id}/read-state")
    async def core_session_read_state(
        session_id: str,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        session = resolve_core_session(app, session_id)
        if not session:
            raise ManagementError("Session was not found.", status_code=404)
        return {
            "ok": True,
            "readState": read_state_or_default(app, session_id),
        }

    @app.patch("/v1/sessions/{session_id}/read-state")
    async def core_update_session_read_state(
        session_id: str,
        request: SessionReadStateUpdateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        session = resolve_core_session(app, session_id)
        if not session:
            raise ManagementError("Session was not found.", status_code=404)
        try:
            read_state = app.state.core_store.upsert_session_read_state(
                session_id,
                request.state,
                metadata=request.metadata,
            )
        except ValueError as exc:
            raise ManagementError(str(exc), status_code=400) from exc
        return {"ok": True, "readState": read_state}

    @app.get("/v1/sessions/{session_id}/messages")
    async def core_session_messages(
        session_id: str,
        externalSessionId: str | None = Query(None),
        externalChatId: str | None = Query(None),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        session = resolve_core_session(
            app,
            session_id,
            external_session_id=externalSessionId or "",
            external_chat_id=externalChatId or "",
        )
        if not session:
            raise ManagementError("Session was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(session["runtimeId"])
        try:
            messages, warning = await run_runtime_call(app, 
                adapter.get_session_messages,
                session_agent(app, session),
                session.get("externalSessionId") or "",
                chat_id=session.get("externalChatId") or "",
                session_id=session_id,
            )
        except ManagementError as exc:
            return {"ok": True, "sessionId": session_id, "messages": [], "warning": exc.error}
        messages = import_generated_file_history_attachments(
            app,
            session=session,
            messages=messages,
        )
        return {"ok": True, "sessionId": session_id, "messages": messages, "source": "hermes-management", "warning": warning}

    @app.post("/v1/sessions/{session_id}/messages")
    async def core_send_message(
        session_id: str,
        request: CoreMessageCreateRequest,
        http_request: Request,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        session = resolve_core_session(app, session_id)
        if not session:
            raise ManagementError("Session was not found.", status_code=404)
        agent = app.state.runtime_registry.agent(session["agentId"])
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        text = request.text.strip()
        attachment_refs = normalize_attachment_refs(request.attachments)
        if not text and not attachment_refs:
            raise ManagementError("Message text is required.", status_code=400)
        idempotency_key = http_request.headers.get("Idempotency-Key") or request.clientMessageId
        message_id = request.clientMessageId or random_id("msg")
        accepted_key = (session_id, idempotency_key or message_id)
        accepted_message = app.state.accepted_client_messages.get(accepted_key)
        if accepted_message:
            return {**accepted_message, "duplicate": True}
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        chat_id = session["externalChatId"] or chat_id_for_session(session_id)
        if not session["externalChatId"]:
            session = {**session, "externalChatId": chat_id}
            remember_active_session(app, session)
        try:
            resolved_attachments = app.state.core_store.resolve_message_attachments(
                runtime_id=agent["runtimeId"],
                profile=agent["runtimeProfile"],
                session_id=session_id,
                chat_id=chat_id,
                message_id=message_id,
                refs=attachment_refs,
            )
        except ValueError as exc:
            raise ManagementError(str(exc), status_code=400) from exc
        client_attachments = [client_attachment_payload(attachment) for attachment in resolved_attachments]
        project = linked_project_for_message(app, session, request.metadata)
        runtime_metadata = {
            key: value
            for key, value in request.metadata.items()
            if key not in {"modelSwitch", "chatId"}
        }
        if project:
            runtime_metadata.update(project_runtime_metadata(project))
        runtime_metadata.update({
                    "agentuiSessionId": session_id,
                    "clientMessageId": message_id,
                    "chatId": chat_id,
                    "profile": agent["runtimeProfile"],
                    "idempotencyKey": idempotency_key,
                })
        switch_command = model_switch_command(request.metadata.get("modelSwitch"))
        if switch_command:
            switch_result = await run_runtime_call(app, 
                adapter.send_message,
                profile=agent["runtimeProfile"],
                chat_id=chat_id,
                chat_name=session["title"],
                message_id=f"{message_id}-model",
                text=switch_command,
                session_id=session.get("externalSessionId") or "",
                metadata={
                    **runtime_metadata,
                    "hidden": True,
                    "kind": "model-switch",
                    "replyTo": message_id,
                },
            )
            if not switch_result.get("ok"):
                error_event = publish_core_event(
                    app,
                    session_id=session_id,
                    agent_id=agent["id"],
                    runtime_id=agent["runtimeId"],
                    event_type="message.error",
                    role="assistant",
                    content=str(switch_result.get("error") or "Hermes gateway did not accept the model switch."),
                    parent_event_id=message_id,
                    metadata={
                        "sendResult": switch_result,
                        "chatId": chat_id,
                        "profile": agent["runtimeProfile"],
                        "source": "agentui-core-send",
                    },
                )
                return {
                    "ok": False,
                    "sessionId": session_id,
                    "messageId": message_id,
                    "accepted": False,
                    "eventCursor": error_event["cursor"],
                    "error": switch_result.get("error") or "Hermes gateway did not accept the model switch.",
                }
        result = await run_runtime_call(app, 
            adapter.send_message,
            profile=agent["runtimeProfile"],
            chat_id=chat_id,
            chat_name=session["title"],
            message_id=message_id,
            text=text,
            session_id=session.get("externalSessionId") or "",
            metadata=runtime_metadata,
            attachments=resolved_attachments,
        )
        if not result.get("ok"):
            error_event = publish_core_event(
                app,
                session_id=session_id,
                agent_id=agent["id"],
                runtime_id=agent["runtimeId"],
                event_type="message.error",
                role="assistant",
                content=str(result.get("error") or "Hermes gateway did not accept the message."),
                parent_event_id=message_id,
                metadata={
                    "sendResult": result,
                    "chatId": chat_id,
                    "profile": agent["runtimeProfile"],
                    "source": "agentui-core-send",
                },
            )
            return {
                "ok": False,
                "sessionId": session_id,
                "messageId": message_id,
                "accepted": False,
                "eventCursor": error_event["cursor"],
                "error": result.get("error") or "Hermes gateway did not accept the message.",
            }
        accepted_chat_id = str(result.get("chatId") or chat_id)
        runtime_session_id = str(result.get("sessionId") or "")
        session_updates: dict[str, Any] = {}
        if accepted_chat_id != session.get("externalChatId"):
            session_updates["externalChatId"] = accepted_chat_id
        if runtime_session_id and runtime_session_id != session.get("externalSessionId"):
            session_updates["externalSessionId"] = runtime_session_id
        if session_updates:
            session = {**session, **session_updates}
            remember_active_session(app, session)
        if project:
            app.state.core_store.link_project_session(project["id"], session)
        app.state.core_store.upsert_client_message_metadata(
            runtime_id=agent["runtimeId"],
            profile=agent["runtimeProfile"],
            chat_id=accepted_chat_id,
            message_id=message_id,
            content=text,
            metadata={
                **{
                    key: value
                    for key, value in runtime_metadata.items()
                    if key != "attachments"
                },
                "clientContent": text,
                **({"attachments": client_attachments} if client_attachments else {}),
            },
        )
        event_cursor = app.state.live_delivery_bus.latest_cursor(agent_id=agent["id"])
        response_session = with_read_state(app, session)
        accepted_response = {
            "ok": True,
            "sessionId": session["id"],
            "canonicalSessionId": session["id"],
            "messageId": message_id,
            "accepted": True,
            "eventCursor": event_cursor,
            "session": response_session,
            "runtime": result,
        }
        app.state.accepted_client_messages[accepted_key] = accepted_response
        return accepted_response

    @app.post("/v1/sessions/{session_id}/cancel")
    async def core_cancel_message(session_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        session = resolve_core_session(app, session_id)
        if not session:
            raise ManagementError("Session was not found.", status_code=404)
        agent = app.state.runtime_registry.agent(session["agentId"])
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        result = await run_runtime_call(app, 
            adapter.send_message,
            profile=agent["runtimeProfile"],
            chat_id=session["externalChatId"] or chat_id_for_session(session_id),
            chat_name=session["title"],
            message_id=random_id("msg"),
            text="/stop",
            session_id=session.get("externalSessionId") or "",
            metadata={"kind": "cancel", "agentuiSessionId": session_id},
        )
        return {"ok": bool(result.get("ok")), "sessionId": session_id, "runtime": result}

    @app.get("/v1/events")
    async def core_events(
        after: int = Query(0),
        limit: int = Query(200),
        agentId: str | None = Query(None),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        if agentId and not app.state.runtime_registry.agent(agentId):
            raise ManagementError("Agent was not found.", status_code=404)
        after = clamp_int(after, default=0, minimum=0, maximum=9_223_372_036_854_775_807)
        limit = clamp_int(limit, default=200, minimum=1, maximum=500)
        events = app.state.live_delivery_bus.list_events(after=after, limit=limit, agent_id=agentId or "")
        return {
            "ok": True,
            "events": events,
            "cursor": events[-1]["cursor"] if events else app.state.live_delivery_bus.latest_cursor(agent_id=agentId or ""),
        }

    @app.get("/v1/sessions/{session_id}/events")
    async def core_session_events(
        session_id: str,
        after: int = Query(0),
        limit: int = Query(200),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        if not resolve_core_session(app, session_id):
            raise ManagementError("Session was not found.", status_code=404)
        after = clamp_int(after, default=0, minimum=0, maximum=9_223_372_036_854_775_807)
        limit = clamp_int(limit, default=200, minimum=1, maximum=500)
        events = app.state.live_delivery_bus.list_events(after=after, limit=limit, session_id=session_id)
        return {
            "ok": True,
            "events": events,
            "cursor": events[-1]["cursor"] if events else app.state.live_delivery_bus.latest_cursor(session_id=session_id),
        }

    @app.get("/v1/events/stream")
    async def core_event_stream(
        request: Request,
        after: int = Query(0),
        limit: int = Query(200),
        agentId: str | None = Query(None),
        live: bool = Query(True),
        _auth: None = Depends(require_auth),
    ) -> StreamingResponse:
        if agentId and not app.state.runtime_registry.agent(agentId):
            raise ManagementError("Agent was not found.", status_code=404)
        after = clamp_int(after, default=0, minimum=0, maximum=9_223_372_036_854_775_807)
        limit = clamp_int(limit, default=200, minimum=1, maximum=500)

        async def event_generator():
            cursor = after
            heartbeat_at = now()
            while True:
                events = app.state.live_delivery_bus.list_events(after=cursor, limit=limit, agent_id=agentId or "")
                for event in events:
                    cursor = max(cursor, int(event["cursor"]))
                    yield sse_event(event)
                if not live:
                    break
                if await request.is_disconnected():
                    break
                if not events and now() - heartbeat_at >= 15:
                    heartbeat_at = now()
                    yield ": keep-alive\n\n"
                await asyncio.sleep(0.5)

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/v1/runtime-deliveries/hermes")
    async def runtime_delivery_hermes(
        delivery: RuntimeDeliveryHermesRequest,
        _auth: None = Depends(require_runtime_delivery_auth),
    ) -> dict[str, Any]:
        agent = agent_for_runtime_profile(app, delivery.runtimeId, delivery.profile)
        if not agent:
            raise ManagementError("Delivery profile is not mapped to an Iris agent.", status_code=404)
        session = resolve_core_session(
            app,
            "",
            runtime_id=delivery.runtimeId,
            runtime_profile=delivery.profile,
            external_chat_id=delivery.chatId,
        )
        if not session:
            session = draft_session(
                agent,
                title=f"{delivery.profile} delivery",
                external_chat_id=delivery.chatId,
                metadata={"createdBy": "runtime-delivery"},
            )
            remember_active_session(app, session)
        delivery_runtime_session_id = str(
            delivery.metadata.get("externalSessionId")
            or delivery.metadata.get("hermesSessionId")
            or delivery.metadata.get("sessionId")
            or ""
        )
        if delivery_runtime_session_id and delivery_runtime_session_id != session.get("externalSessionId"):
            session = {**session, "externalSessionId": delivery_runtime_session_id}
            remember_active_session(app, session)
            project = app.state.core_store.project_for_session(session["id"])
            if project:
                app.state.core_store.link_project_session(project["id"], session)
        session_id = session["id"]
        stream_message_id = str(
            delivery.metadata.get("streamMessageId")
            or delivery.metadata.get("stream_message_id")
            or delivery.messageId
        )
        is_streaming = bool(delivery.metadata.get("streaming"))
        is_final = bool(delivery.metadata.get("finalize") or delivery.metadata.get("final"))
        event_type = "message.assistant.completed" if is_final or not is_streaming else "message.assistant.delta"
        event_metadata = {
            "profile": delivery.profile,
            "chatId": delivery.chatId,
            "source": delivery.source,
            **delivery.metadata,
        }
        event_metadata = mark_hidden_model_switch_reply(event_metadata, delivery.replyTo or "")
        if has_stream_message_id(delivery.metadata):
            event_metadata["streamMessageId"] = stream_message_id
        original_content = delivery.content
        event_content, event_metadata = ingest_generated_file_attachments(
            app,
            runtime_id=delivery.runtimeId,
            profile=delivery.profile,
            chat_id=delivery.chatId,
            session_id=session_id,
            message_id=delivery.messageId,
            content=delivery.content,
            metadata=event_metadata,
        )
        persist_assistant_attachment_metadata(
            app,
            runtime_id=delivery.runtimeId,
            profile=delivery.profile,
            chat_id=delivery.chatId,
            message_id=delivery.messageId,
            stream_message_id=stream_message_id if has_stream_message_id(event_metadata) else "",
            content=event_content,
            original_content=original_content,
            metadata=event_metadata,
        )
        event = publish_core_event(
            app,
            session_id=session_id,
            agent_id=agent["id"],
            runtime_id=delivery.runtimeId,
            event_type=event_type,
            role="assistant",
            content=event_content,
            parent_event_id=delivery.replyTo or str(event_metadata.get("replyTo") or ""),
            external_message_id=delivery.messageId,
            metadata=event_metadata,
            event_id=f"evt_delivery_{delivery.messageId}",
        )
        return {
            "ok": True,
            "sessionId": session_id,
            "event": event,
            "suppressed": False,
        }

    @app.get("/v1/automations")
    async def core_automations(
        agentId: str | None = Query(None),
        limit: int = Query(200),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        if agentId and not app.state.runtime_registry.agent(agentId):
            raise ManagementError("Agent was not found.", status_code=404)
        automations = await run_runtime_call(app, list_runtime_automations, app, agentId)
        limit = clamp_int(limit, default=200, minimum=1, maximum=500)
        return {
            "ok": True,
            "automations": automations[:limit],
        }

    @app.post("/v1/automations")
    async def core_create_automation(
        request: CoreAutomationCreateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(request.agentId)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        payload = automation_create_payload(app, agent, dump_model(request))
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        result = await run_runtime_call(app, adapter.create_automation, payload)
        if not result.get("ok"):
            return {
                "ok": False,
                "error": result.get("error") or "Could not create Hermes job.",
                "runtime": result,
            }
        job = automation_job_payload(result)
        automation = automation_record_from_job(
            agent,
            job,
            request_payload=dump_model(request),
            deliver=payload.get("deliver", ""),
        )
        return {"ok": True, "automation": automation, "runtime": result}

    @app.patch("/v1/automations/{automation_id}")
    async def core_update_automation(
        automation_id: str,
        request: CoreAutomationUpdateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        automation = resolve_runtime_automation(app, automation_id)
        if not automation:
            raise ManagementError("Automation was not found.", status_code=404)
        agent = app.state.runtime_registry.agent(automation["agentId"])
        if not agent:
            raise ManagementError("Automation agent was not found.", status_code=404)
        fields_set = getattr(request, "model_fields_set", None)
        if fields_set is None:
            fields_set = getattr(request, "__fields_set__", set())
        updates = {
            key: value
            for key, value in dump_model(request).items()
            if key in fields_set and value not in ("", {})
        }
        result: dict[str, Any] = {"ok": True}
        if automation["externalJobId"]:
            adapter = app.state.runtime_registry.adapter_for_runtime(automation["runtimeId"])
            result = await run_runtime_call(app, 
                adapter.update_automation,
                automation["externalJobId"],
                automation_update_payload(updates),
            )
            if not result.get("ok"):
                return {"ok": False, "error": result.get("error") or "Could not update Hermes job.", "runtime": result}
        updated_job = automation_job_payload(result)
        updated = automation_record_from_job(agent, updated_job, request_payload={**automation, **updates}) if updated_job else automation
        return {"ok": True, "automation": updated, "runtime": result}

    @app.delete("/v1/automations/{automation_id}")
    async def core_delete_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        automation = resolve_runtime_automation(app, automation_id)
        if not automation:
            raise ManagementError("Automation was not found.", status_code=404)
        result: dict[str, Any] = {"ok": True}
        if automation["externalJobId"]:
            adapter = app.state.runtime_registry.adapter_for_runtime(automation["runtimeId"])
            result = await run_runtime_call(app, adapter.delete_automation, automation["externalJobId"])
            if not result.get("ok") and "not found" not in str(result.get("error") or "").lower():
                return {"ok": False, "error": result.get("error") or "Could not delete Hermes job.", "runtime": result}
        return {"ok": True, "automationId": automation_id, "runtime": result}

    @app.post("/v1/automations/{automation_id}/pause")
    async def core_pause_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return await run_runtime_call(app, control_core_automation, app, automation_id, "pause", "paused")

    @app.post("/v1/automations/{automation_id}/resume")
    async def core_resume_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return await run_runtime_call(app, control_core_automation, app, automation_id, "resume", "active")

    @app.post("/v1/automations/{automation_id}/run")
    async def core_run_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return await run_runtime_call(app, control_core_automation, app, automation_id, "run", None)

    @app.get("/v1/agents/{agent_id}/models")
    async def core_agent_models(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return await run_runtime_call(app, adapter.models, agent["runtimeProfile"])

    @app.get("/v1/agents/{agent_id}/slash-commands")
    async def core_agent_slash_commands(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return await run_runtime_call(app, adapter.slash_commands, agent["runtimeProfile"])

    @app.post("/v1/agents/{agent_id}/slash-complete")
    async def core_agent_slash_complete(
        agent_id: str,
        request: Request,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        body = await request.json()
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return await run_runtime_call(app, 
            adapter.slash_complete,
            agent["runtimeProfile"],
            text=str(body.get("text") or ""),
            limit=int(body.get("limit") or 30),
        )

    return app


def core_status_payload(*, request_app: FastAPI) -> dict[str, Any]:
    core_store: CoreStore = request_app.state.core_store
    runtimes = request_app.state.runtime_registry.runtimes()
    agents = request_app.state.runtime_registry.agents()
    return {
        **core_store.health(),
        "runtimeCount": len(runtimes),
        "agentCount": len(agents),
        **core_auth_payload(request_app),
    }


def profile_summary_from_agent(agent: dict[str, Any]) -> ProfileSummary:
    metadata = agent.get("metadata") if isinstance(agent.get("metadata"), dict) else {}
    return ProfileSummary(
        name=str(agent.get("runtimeProfile") or agent.get("displayName") or "default"),
        path=str(metadata.get("path") or ""),
        active=bool(agent.get("isDefault")),
        exists=metadata.get("exists") is not False,
        provider=str(metadata.get("provider") or "not configured"),
        model=str(metadata.get("model") or "not configured"),
        memoryBytes=int(metadata.get("memoryBytes") if isinstance(metadata.get("memoryBytes"), int) else 0),
        memoryUpdatedAt=metadata.get("memoryUpdatedAt") if isinstance(metadata.get("memoryUpdatedAt"), int) else None,
        skillCount=int(metadata.get("skillCount") if isinstance(metadata.get("skillCount"), int) else 0),
        gatewayRunning=bool(metadata.get("gatewayRunning")),
    )


def core_auth_payload(request_app: FastAPI) -> dict[str, Any]:
    settings: Settings = request_app.state.settings
    devices = request_app.state.core_store.list_devices()
    active_devices = [device for device in devices if device.get("revokedAt") is None]
    remote_auth_required = not host_is_loopback(settings.host)
    return {
        "authMode": "bearer" if request_app.state.management_token or remote_auth_required else "none",
        "remoteAuthRequired": remote_auth_required,
        "deviceCount": len(devices),
        "activeDeviceCount": len(active_devices),
    }


def inbox_message_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    content = str(payload.get("content") or "").strip()
    if not content:
        raise ManagementError("Message content is required.", status_code=400)
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    return {
        "cursor": 0,
        "id": str(payload.get("id") or random_id("inbox")),
        "source": str(payload.get("source") or "hermes-cron"),
        "platform": str(payload.get("platform") or "agentui"),
        "profile": str(payload.get("profile") or metadata.get("profile") or "default"),
        "chatId": str(payload.get("chatId") or payload.get("chat_id") or "agentui"),
        "content": content,
        "metadata": metadata,
        "createdAt": int(payload.get("createdAt") or payload.get("created_at") or now()),
        "acknowledgedAt": None,
    }


def mirror_inbox_message_to_core(app: FastAPI, message: dict[str, Any]) -> dict[str, Any] | None:
    runtime_id = str(message.get("metadata", {}).get("runtimeId") or DEFAULT_RUNTIME_ID)
    profile = str(message.get("profile") or "default")
    chat_id = str(message.get("chatId") or "agentui")
    agent = agent_for_runtime_profile(app, runtime_id, profile)
    if not agent:
        return None
    session = resolve_core_session(
        app,
        "",
        runtime_id=runtime_id,
        runtime_profile=profile,
        external_chat_id=chat_id,
    )
    if not session:
        session = draft_session(
            agent,
            title=f"{profile} delivery",
            external_chat_id=chat_id,
            metadata={"createdBy": "legacy-inbox-delivery"},
        )
        remember_active_session(app, session)
    session_id = session["id"]
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    stream_message_id = str(metadata.get("streamMessageId") or metadata.get("stream_message_id") or "")
    is_streaming = bool(metadata.get("streaming"))
    is_final = bool(metadata.get("finalize") or metadata.get("final"))
    event_type = "message.assistant.completed" if is_final or not is_streaming else "message.assistant.delta"
    event_metadata = {
        "profile": profile,
        "chatId": chat_id,
        "source": str(message.get("source") or "legacy-inbox"),
        "platform": str(message.get("platform") or "agentui"),
        **metadata,
    }
    event_metadata = mark_hidden_model_switch_reply(event_metadata, str(metadata.get("replyTo") or ""))
    if stream_message_id:
        event_metadata["streamMessageId"] = stream_message_id
    original_content = str(message.get("content") or "")
    event_content, event_metadata = ingest_generated_file_attachments(
        app,
        runtime_id=runtime_id,
        profile=profile,
        chat_id=chat_id,
        session_id=session_id,
        message_id=str(message.get("id") or ""),
        content=original_content,
        metadata=event_metadata,
    )
    persist_assistant_attachment_metadata(
        app,
        runtime_id=runtime_id,
        profile=profile,
        chat_id=chat_id,
        message_id=str(message.get("id") or ""),
        stream_message_id=stream_message_id,
        content=event_content,
        original_content=original_content,
        metadata=event_metadata,
    )
    return publish_core_event(
        app,
        session_id=session_id,
        agent_id=agent["id"],
        runtime_id=runtime_id,
        event_type=event_type,
        role="assistant",
        content=event_content,
        parent_event_id=str(metadata.get("replyTo") or event_metadata.get("replyTo") or ""),
        external_message_id=str(message.get("id") or ""),
        metadata=event_metadata,
        event_id=f"evt_inbox_{message.get('id')}",
    )


def inbox_message_from_event(app: FastAPI, event: dict[str, Any]) -> dict[str, Any]:
    metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
    message_id = str(event.get("externalMessageId") or event.get("id") or "")
    if message_id.startswith("evt_inbox_"):
        message_id = message_id.removeprefix("evt_inbox_")
    return {
        "cursor": int(event.get("cursor") or 0),
        "id": message_id,
        "source": str(metadata.get("source") or "agentui-core-events"),
        "platform": "agentui",
        "profile": str(metadata.get("profile") or "default"),
        "chatId": str(metadata.get("chatId") or event.get("sessionId") or "agentui"),
        "content": str(event.get("content") or ""),
        "metadata": metadata,
        "createdAt": int(event.get("createdAt") or now()),
        "acknowledgedAt": app.state.inbox_acknowledged_at.get(message_id),
    }


def inbox_message_for_id(app: FastAPI, message_id: str) -> dict[str, Any] | None:
    target = str(message_id)
    for event in app.state.live_delivery_bus.list_events(after=0, limit=500):
        message = inbox_message_from_event(app, event)
        if message["id"] == target:
            return message
    return None


def remember_active_session(app: FastAPI, session: dict[str, Any]) -> None:
    app.state.active_sessions[session["id"]] = session
    chat_id = str(session.get("externalChatId") or "")
    if chat_id:
        app.state.active_sessions_by_chat[
            (session["runtimeId"], session["runtimeProfile"], chat_id)
        ] = session["id"]


def forget_active_session(app: FastAPI, session_id: str, session: dict[str, Any] | None = None) -> None:
    cached = app.state.active_sessions.pop(session_id, None)
    row = session or cached or {}
    chat_id = str(row.get("externalChatId") or "")
    if chat_id:
        app.state.active_sessions_by_chat.pop(
            (row.get("runtimeId") or DEFAULT_RUNTIME_ID, row.get("runtimeProfile") or "default", chat_id),
            None,
        )


def project_runtime_metadata(project: dict[str, Any]) -> dict[str, Any]:
    return {
        "projectId": project["id"],
        "projectName": project["name"],
        "projectSystemPrompt": project.get("systemPrompt") or "",
    }


def with_project_metadata(session: dict[str, Any], project: dict[str, Any]) -> dict[str, Any]:
    metadata = session.get("metadata") if isinstance(session.get("metadata"), dict) else {}
    return {
        **session,
        "metadata": {
            **metadata,
            "project": {
                "id": project["id"],
                "name": project["name"],
                "defaultAgentId": project["defaultAgentId"],
            },
            "projectId": project["id"],
        },
    }


def read_state_or_default(app: FastAPI, session_id: str) -> dict[str, Any]:
    return app.state.core_store.session_read_state(session_id) or default_read_state(session_id)


def default_read_state(session_id: str) -> dict[str, Any]:
    return {
        "sessionId": session_id,
        "state": "read",
        "createdAt": None,
        "updatedAt": None,
        "metadata": {},
    }


def with_read_state(app: FastAPI, session: dict[str, Any]) -> dict[str, Any]:
    session_id = str(session.get("id") or "")
    if not session_id:
        return session
    return {
        **session,
        "readState": read_state_or_default(app, session_id),
    }


def with_read_states(app: FastAPI, sessions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    states = app.state.core_store.session_read_states([
        str(session.get("id") or "")
        for session in sessions
    ])
    return [
        {
            **session,
            "readState": states.get(str(session.get("id") or "")) or default_read_state(
                str(session.get("id") or ""),
            ),
        }
        for session in sessions
    ]


def should_mark_session_unread(event: dict[str, Any]) -> bool:
    metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
    return (
        bool(event.get("sessionId")) and
        str(event.get("role") or "") == "assistant" and
        str(event.get("type") or "") == "message.assistant.completed" and
        not bool(metadata.get("hidden"))
    )


def linked_project_for_message(
    app: FastAPI,
    session: dict[str, Any],
    request_metadata: dict[str, Any],
) -> dict[str, Any] | None:
    requested_project_id = str(request_metadata.get("projectId") or "").strip()
    if requested_project_id:
        project = app.state.core_store.get_project(requested_project_id)
        if not project:
            raise ManagementError("Project was not found.", status_code=404)
        return project
    return app.state.core_store.project_for_session(str(session.get("id") or ""))


def project_sessions(app: FastAPI, project: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for link in app.state.core_store.list_project_session_links(project["id"]):
        session = resolve_project_session(app, link)
        if not session:
            continue
        key = (
            str(session.get("runtimeId") or link["runtimeId"]),
            str(session.get("runtimeProfile") or link["runtimeProfile"]),
            str(session.get("externalSessionId") or ""),
            str(session.get("externalChatId") or link["externalChatId"]),
        )
        if key in seen:
            continue
        seen.add(key)
        rows.append(with_project_metadata(session, project))
    rows.sort(key=lambda row: int(row.get("updatedAt") or 0), reverse=True)
    return rows


def resolve_project_session(app: FastAPI, link: dict[str, Any]) -> dict[str, Any] | None:
    if link.get("externalSessionId") or link.get("externalChatId"):
        session = resolve_core_session(
            app,
            link["sessionId"],
            runtime_id=link["runtimeId"],
            runtime_profile=link["runtimeProfile"],
            external_session_id=link["externalSessionId"],
            external_chat_id=link["externalChatId"],
            prefer_runtime=True,
        )
        if session:
            remember_active_session(app, session)
            return session
    return resolve_core_session(
        app,
        link["sessionId"],
        runtime_id=link["runtimeId"],
        runtime_profile=link["runtimeProfile"],
        external_session_id=link["externalSessionId"],
        external_chat_id=link["externalChatId"],
    )


def agent_for_runtime_profile(app: FastAPI, runtime_id: str, profile: str) -> dict[str, Any] | None:
    return next(
        (
            agent
            for agent in app.state.runtime_registry.agents()
            if agent["runtimeId"] == runtime_id and agent["runtimeProfile"] == profile
        ),
        None,
    )


def session_agent(app: FastAPI, session: dict[str, Any]) -> dict[str, Any]:
    agent = app.state.runtime_registry.agent(str(session.get("agentId") or ""))
    if not agent:
        raise ManagementError("Session agent was not found.", status_code=404)
    return agent


def resolve_core_session(
    app: FastAPI,
    session_id: str,
    *,
    runtime_id: str = "",
    runtime_profile: str = "",
    external_session_id: str = "",
    external_chat_id: str = "",
    prefer_runtime: bool = False,
) -> dict[str, Any] | None:
    if not prefer_runtime:
        active = active_core_session(
            app,
            session_id,
            runtime_id=runtime_id,
            runtime_profile=runtime_profile,
            external_chat_id=external_chat_id,
        )
        if active:
            return active

    agents = app.state.runtime_registry.agents()
    for agent in agents:
        if runtime_id and agent["runtimeId"] != runtime_id:
            continue
        if runtime_profile and agent["runtimeProfile"] != runtime_profile:
            continue
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        session = adapter.get_session(
            agent,
            external_session_id,
            chat_id=external_chat_id,
            session_id=session_id,
        )
        if session:
            return session
    if prefer_runtime:
        return active_core_session(
            app,
            session_id,
            runtime_id=runtime_id,
            runtime_profile=runtime_profile,
            external_chat_id=external_chat_id,
        )
    return None


def active_core_session(
    app: FastAPI,
    session_id: str,
    *,
    runtime_id: str = "",
    runtime_profile: str = "",
    external_chat_id: str = "",
) -> dict[str, Any] | None:
    active = app.state.active_sessions.get(session_id) if session_id else None
    if active:
        return active
    if external_chat_id:
        mapped_id = app.state.active_sessions_by_chat.get(
            (runtime_id or DEFAULT_RUNTIME_ID, runtime_profile or "default", external_chat_id)
        )
        if mapped_id and mapped_id in app.state.active_sessions:
            return app.state.active_sessions[mapped_id]
    return None


def publish_core_event(
    app: FastAPI,
    *,
    session_id: str,
    agent_id: str,
    runtime_id: str,
    event_type: str,
    role: str,
    content: str,
    parent_event_id: str = "",
    external_message_id: str = "",
    idempotency_key: str = "",
    metadata: dict[str, Any] | None = None,
    event_id: str = "",
) -> dict[str, Any]:
    event = app.state.live_delivery_bus.publish(
        {
            "id": event_id,
            "sessionId": session_id,
            "agentId": agent_id,
            "runtimeId": runtime_id,
            "type": event_type,
            "role": role,
            "content": content,
            "parentEventId": parent_event_id,
            "externalMessageId": external_message_id,
            "idempotencyKey": idempotency_key,
            "metadata": metadata or {},
        }
    )
    if should_mark_session_unread(event):
        app.state.core_store.upsert_session_read_state(
            session_id,
            "unread",
            metadata={"eventCursor": event["cursor"], "eventType": event["type"]},
        )
    return event


def list_runtime_automations(app: FastAPI, agent_id: str | None = None) -> list[dict[str, Any]]:
    registry: RuntimeRegistry = app.state.runtime_registry
    agents = [registry.agent(agent_id)] if agent_id else registry.agents()
    automations: list[dict[str, Any]] = []
    for agent in [row for row in agents if row]:
        adapter = registry.adapter_for_runtime(agent["runtimeId"])
        result = adapter.list_automations(agent["runtimeProfile"])
        if not result.get("ok"):
            continue
        for job in automation_jobs_from_result(result):
            if job_id(job):
                automations.append(automation_record_from_job(agent, job))
    return sorted(automations, key=lambda row: (row["nextRunAt"] or row["updatedAt"], -row["createdAt"], row["id"]))


def resolve_runtime_automation(app: FastAPI, automation_id: str) -> dict[str, Any] | None:
    return next(
        (
            automation
            for automation in list_runtime_automations(app)
            if automation["id"] == automation_id or automation["externalJobId"] == automation_id
        ),
        None,
    )


def automation_record_from_job(
    agent: dict[str, Any],
    job: dict[str, Any],
    *,
    request_payload: dict[str, Any] | None = None,
    deliver: str = "",
) -> dict[str, Any]:
    timestamp = now()
    external_job_id = job_id(job)
    request_payload = request_payload or {}
    metadata = request_payload.get("metadata") if isinstance(request_payload.get("metadata"), dict) else {}
    deliver = deliver or str(job.get("deliver") or job.get("delivery") or "")
    return {
        "id": f"auto_{stable_hash(agent['runtimeId'], external_job_id, length=22)}",
        "agentId": agent["id"],
        "runtimeId": agent["runtimeId"],
        "externalJobId": external_job_id,
        "name": str(job.get("name") or request_payload.get("name") or "Hermes job"),
        "schedule": job_schedule(job) or str(request_payload.get("schedule") or ""),
        "prompt": str(job.get("prompt") or request_payload.get("prompt") or ""),
        "deliverToSessionId": str(request_payload.get("deliverToSessionId") or ""),
        "status": job_status(job) or "active",
        "createdAt": job_timestamp(job, "createdAt", "created_at", "created") or timestamp,
        "updatedAt": job_timestamp(job, "updatedAt", "updated_at", "updated") or timestamp,
        "lastRunAt": job_timestamp(job, "lastRunAt", "last_run_at", "lastRun", "last_run"),
        "nextRunAt": job_timestamp(job, "nextRunAt", "next_run_at", "nextRun", "next_run"),
        "metadata": {
            **metadata,
            "source": "hermes-jobs",
            "deliver": deliver,
            "repeat": job_repeat(job),
            "runtimeJob": job,
        },
    }


def automation_create_payload(app: FastAPI, agent: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    schedule = str(request.get("schedule") or "").strip()
    prompt = str(request.get("prompt") or "").strip()
    if not schedule:
        raise ManagementError("Automation schedule is required.", status_code=400)
    if not prompt:
        raise ManagementError("Automation prompt is required.", status_code=400)
    deliver = str(request.get("deliver") or "").strip()
    session_id = str(request.get("deliverToSessionId") or "").strip()
    if session_id:
        session = resolve_core_session(app, session_id)
        if not session or session["agentId"] != agent["id"]:
            raise ManagementError("Delivery session was not found for this agent.", status_code=404)
        deliver = deliver or f"iris:{session['externalChatId'] or chat_id_for_session(session_id)}"
    payload: dict[str, Any] = {
        "name": str(request.get("name") or "Iris reminder"),
        "schedule": schedule,
        "prompt": prompt,
    }
    if deliver:
        payload["deliver"] = deliver
    repeat = request.get("repeat")
    if repeat not in (None, ""):
        payload["repeat"] = max(1, int(repeat))
    return payload


def automation_update_payload(updates: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for request_key, runtime_key in (
        ("name", "name"),
        ("schedule", "schedule"),
        ("prompt", "prompt"),
        ("deliver", "deliver"),
        ("repeat", "repeat"),
    ):
        if request_key == "repeat" and request_key in updates:
            value = updates.get(request_key)
            payload[runtime_key] = None if value is None else max(1, int(value))
            continue
        value = updates.get(request_key)
        if value not in (None, ""):
            payload[runtime_key] = value
    return payload


def control_core_automation(app: FastAPI, automation_id: str, action: str, status: str | None) -> dict[str, Any]:
    automation = resolve_runtime_automation(app, automation_id)
    if not automation:
        raise ManagementError("Automation was not found.", status_code=404)
    if not automation["externalJobId"]:
        raise ManagementError("Automation is not linked to a Hermes job.", status_code=400)
    adapter = app.state.runtime_registry.adapter_for_runtime(automation["runtimeId"])
    result = adapter.control_automation(automation["externalJobId"], action)
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error") or f"Could not {action} Hermes job.", "runtime": result}
    updates: dict[str, Any] = {}
    if status:
        updates["status"] = status
    if action == "run":
        updates["lastRunAt"] = now()
    updated = {**automation, **updates} if updates else automation
    return {"ok": True, "automation": updated, "runtime": result}


def automation_jobs_from_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    raw_jobs = (
        result.get("jobs")
        if isinstance(result.get("jobs"), list)
        else result.get("items")
        if isinstance(result.get("items"), list)
        else result.get("data")
        if isinstance(result.get("data"), list)
        else []
    )
    return [row for row in raw_jobs if isinstance(row, dict)]


def automation_job_payload(result: dict[str, Any]) -> dict[str, Any]:
    for key in ("job", "automation", "item", "data"):
        value = result.get(key)
        if isinstance(value, dict):
            return value
    return result


def job_id(job: dict[str, Any]) -> str:
    return str(job.get("id") or job.get("jobId") or job.get("job_id") or "")


def job_schedule(job: dict[str, Any]) -> str:
    schedule = job.get("schedule") if isinstance(job.get("schedule"), dict) else {}
    return str(job.get("schedule_display") or schedule.get("display") or job.get("schedule") or job.get("cron") or job.get("when") or "")


def job_repeat(job: dict[str, Any]) -> int | None:
    repeat = job.get("repeat") if isinstance(job.get("repeat"), dict) else {}
    value = repeat.get("times") if isinstance(repeat, dict) else None
    value = value if value not in (None, "") else job.get("repeat")
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def job_status(job: dict[str, Any]) -> str:
    raw = str(job.get("status") or job.get("state") or ("paused" if job.get("enabled") is False else "active")).lower()
    if "pause" in raw:
        return "paused"
    if "complete" in raw or "done" in raw:
        return "completed"
    if "error" in raw or "fail" in raw:
        return "error"
    if any(word in raw for word in ("active", "run", "enabled", "scheduled", "pending")):
        return "active"
    return "unknown"


def job_timestamp(job: dict[str, Any], *keys: str) -> int | None:
    schedule = job.get("schedule") if isinstance(job.get("schedule"), dict) else {}
    candidates: list[Any] = [job.get(key) for key in keys]
    if "next_run_at" in keys:
        candidates.append(schedule.get("run_at"))
    for value in candidates:
        if value in (None, ""):
            continue
        try:
            return int(float(value))
        except (TypeError, ValueError):
            pass
        if isinstance(value, str):
            try:
                from datetime import datetime

                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                return int(parsed.timestamp())
            except ValueError:
                continue
    return None


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def is_model_switch_reply(reply_to: str, metadata: dict[str, Any]) -> bool:
    return reply_to.endswith("-model") or str(metadata.get("kind") or "") == "model-switch"


def mark_hidden_model_switch_reply(metadata: dict[str, Any], reply_to: str) -> dict[str, Any]:
    if not is_model_switch_reply(reply_to, metadata):
        return metadata
    return {**metadata, "hidden": True, "kind": "model-switch", "replyTo": reply_to}


def sse_event(event: dict[str, Any]) -> str:
    return (
        f"event: {event['type']}\n"
        f"id: {event['cursor']}\n"
        f"data: {json_dumps(event)}\n\n"
    )


def dump_model(model):
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Iris Core server.")
    parser.add_argument(
        "command",
        nargs="?",
        choices=("serve", "migrate-source-of-truth"),
        default="serve",
        help="Command to run. Defaults to serve.",
    )
    parser.add_argument("--host", default=None, help="Bind host. Defaults to HERMES_MGMT_HOST or 127.0.0.1.")
    parser.add_argument("--port", type=int, default=None, help="Bind port. Defaults to HERMES_MGMT_PORT or 8765.")
    parser.add_argument("--hermes-home", default=None, help="Hermes home path. Defaults to HERMES_HOME or ~/.hermes.")
    parser.add_argument("--backup", action="store_true", help="Create a migration backup before dropping duplicate tables.")
    return parser


def settings_from_args(args: argparse.Namespace) -> Settings:
    env_settings = Settings.from_env()
    hermes_home = args.hermes_home or env_settings.hermes_home
    host = args.host or env_settings.host
    port = args.port if args.port is not None else env_settings.port
    if port < 1 or port > 65535:
        raise SystemExit(f"Port must be between 1 and 65535: {port}")
    return Settings(
        hermes_home=str(normalize_hermes_home(hermes_home)),
        host=host,
        port=port,
        token=env_settings.token,
        inbox_token=env_settings.inbox_token,
        runtime_delivery_token=env_settings.runtime_delivery_token,
        core_store_path=env_settings.core_store_path,
        cors_origins=env_settings.cors_origins,
    )


def cli() -> None:
    parser = build_parser()
    args = parser.parse_args()
    settings = settings_from_args(args)
    if args.command == "migrate-source-of-truth":
        store = CoreStore(settings.core_store_path, auto_migrate=False)
        result = store.migrate_source_of_truth_schema(backup=bool(args.backup))
        print(json.dumps(result, indent=2, sort_keys=True))
        return
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port)


app = create_app(Settings(core_store_path="/private/tmp/iris-core-import.sqlite3"))


if __name__ == "__main__":
    cli()
