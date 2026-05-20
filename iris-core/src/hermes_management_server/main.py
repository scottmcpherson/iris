"""FastAPI application and CLI entrypoint."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import sys
import tempfile
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
from . import __version__


DEFAULT_CORS_ORIGINS = (
    "tauri://localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
)
ACTIVE_SESSION_RUNTIME_MISSING_GRACE_SECONDS = 5 * 60
DEFAULT_IRIS_INBOUND_PORT = 8766
DEFAULT_RUNTIME_THREAD_LIMIT = 16
DEFAULT_RUNTIME_CALL_TIMEOUT_SECONDS = 30

logger = logging.getLogger(__name__)


class LiveDeliveryBus:
    def __init__(self, *, max_events: int = 500, ttl_seconds: int = 900, core_store: CoreStore | None = None) -> None:
        self.max_events = max_events
        self.ttl_seconds = ttl_seconds
        self.core_store = core_store
        self._events: deque[dict[str, Any]] = deque(maxlen=max_events)
        self._cursor = 0
        self._lock = threading.RLock()

    def publish(self, event: dict[str, Any]) -> dict[str, Any]:
        if self.core_store:
            return self._publish_sqlite(event)
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

    def _event_payload(self, event: dict[str, Any], *, cursor: int) -> dict[str, Any]:
        return {
            "cursor": cursor,
            "id": str(event.get("id") or ""),
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

    def _publish_sqlite(self, event: dict[str, Any]) -> dict[str, Any]:
        event_id = str(event.get("id") or random_id("evt"))
        with self._lock, self.core_store.connect() as connection:
            existing = connection.execute(
                "select * from core_events where id = ?",
                (event_id,),
            ).fetchone()
            if existing:
                return self._row_to_event(existing)
            created_at = int(event.get("createdAt") or now())
            metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
            cursor = int(connection.execute(
                """
                insert into core_events(
                  id, session_id, agent_id, runtime_id, type, role, content,
                  parent_event_id, external_message_id, idempotency_key, created_at, metadata_json
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                returning cursor
                """,
                (
                    event_id,
                    str(event.get("sessionId") or ""),
                    str(event.get("agentId") or ""),
                    str(event.get("runtimeId") or ""),
                    str(event.get("type") or "message.assistant.completed"),
                    str(event.get("role") or ""),
                    str(event.get("content") or ""),
                    str(event.get("parentEventId") or ""),
                    str(event.get("externalMessageId") or ""),
                    str(event.get("idempotencyKey") or ""),
                    created_at,
                    json_dumps(metadata),
                ),
            ).fetchone()["cursor"])
            return self._event_payload({**event, "id": event_id, "createdAt": created_at}, cursor=cursor)

    def list_events(
        self,
        *,
        after: int = 0,
        limit: int = 200,
        session_id: str = "",
        agent_id: str = "",
        automation_only: bool = False,
        descending: bool = False,
    ) -> list[dict[str, Any]]:
        if self.core_store:
            return self._list_events_sqlite(
                after=after,
                limit=limit,
                session_id=session_id,
                agent_id=agent_id,
                automation_only=automation_only,
                descending=descending,
            )
        with self._lock:
            self.prune()
            rows = [
                event
                for event in (reversed(self._events) if descending else self._events)
                if event["cursor"] > after
                and (not session_id or event["sessionId"] == session_id)
                and (not agent_id or event["agentId"] == agent_id)
                and (not automation_only or is_automation_activity_event(event))
            ]
            return rows[:limit]

    def _list_events_sqlite(
        self,
        *,
        after: int,
        limit: int,
        session_id: str,
        agent_id: str,
        automation_only: bool,
        descending: bool,
    ) -> list[dict[str, Any]]:
        clauses = ["cursor > ?"]
        values: list[Any] = [after]
        if session_id:
            clauses.append("session_id = ?")
            values.append(session_id)
        if agent_id:
            clauses.append("agent_id = ?")
            values.append(agent_id)
        if automation_only:
            clauses.append("(type like 'message.assistant%' or type = 'message.error')")
            clauses.append(
                "("
                "metadata_json like '%\"source\":\"hermes-cron\"%' "
                "or metadata_json like '%\"automationId\"%' "
                "or metadata_json like '%\"jobId\"%' "
                "or metadata_json like '%\"job_id\"%'"
                ")"
            )
        values.append(limit)
        direction = "desc" if descending else "asc"
        with self._lock, self.core_store.connect() as connection:
            rows = connection.execute(
                f"""
                select * from core_events
                where {' and '.join(clauses)}
                order by cursor {direction}
                limit ?
                """,
                tuple(values),
            ).fetchall()
            return [self._row_to_event(row) for row in rows]

    def latest_cursor(self, *, session_id: str = "", agent_id: str = "") -> int:
        if self.core_store:
            return self._latest_cursor_sqlite(session_id=session_id, agent_id=agent_id)
        with self._lock:
            self.prune()
            for event in reversed(self._events):
                if session_id and event["sessionId"] != session_id:
                    continue
                if agent_id and event["agentId"] != agent_id:
                    continue
                return int(event["cursor"])
            return self._cursor

    def _latest_cursor_sqlite(self, *, session_id: str = "", agent_id: str = "") -> int:
        clauses: list[str] = []
        values: list[Any] = []
        if session_id:
            clauses.append("session_id = ?")
            values.append(session_id)
        if agent_id:
            clauses.append("agent_id = ?")
            values.append(agent_id)
        where = f"where {' and '.join(clauses)}" if clauses else ""
        with self._lock, self.core_store.connect() as connection:
            row = connection.execute(
                f"select max(cursor) as cursor from core_events {where}",
                tuple(values),
            ).fetchone()
            return int(row["cursor"] or 0) if row else 0

    def prune(self) -> None:
        if self.core_store:
            return
        with self._lock:
            cutoff = int(time.time()) - self.ttl_seconds
            while self._events and int(self._events[0].get("createdAt") or 0) < cutoff:
                self._events.popleft()

    def _row_to_event(self, row: Any) -> dict[str, Any]:
        return {
            "cursor": int(row["cursor"]),
            "id": str(row["id"] or ""),
            "sessionId": str(row["session_id"] or ""),
            "agentId": str(row["agent_id"] or ""),
            "runtimeId": str(row["runtime_id"] or ""),
            "type": str(row["type"] or "message.assistant.completed"),
            "role": str(row["role"] or ""),
            "content": str(row["content"] or ""),
            "parentEventId": str(row["parent_event_id"] or ""),
            "externalMessageId": str(row["external_message_id"] or ""),
            "idempotencyKey": str(row["idempotency_key"] or ""),
            "createdAt": int(row["created_at"] or 0),
            "metadata": json.loads(row["metadata_json"] or "{}"),
        }


@dataclass(frozen=True)
class Settings:
    hermes_home: str | None = None
    host: str = "127.0.0.1"
    port: int = 8765
    token: str | None = None
    core_store_path: str | None = None
    cors_origins: tuple[str, ...] = ()

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            hermes_home=os.environ.get("HERMES_HOME") or None,
            host=os.environ.get("IRIS_CORE_HOST") or "127.0.0.1",
            port=parse_port(os.environ.get("IRIS_CORE_PORT"), 8765),
            token=os.environ.get("IRIS_TOKEN") or None,
            core_store_path=os.environ.get("IRIS_CORE_STORE") or None,
            cors_origins=parse_cors_origins(os.environ.get("IRIS_CORE_CORS_ORIGINS")) or DEFAULT_CORS_ORIGINS,
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


def iris_token(hermes_home: os.PathLike[str] | str) -> str:
    return (
        os.environ.get("IRIS_TOKEN", "").strip()
        or env_file_value(os.path.join(os.fspath(hermes_home), ".env"), "IRIS_TOKEN")
    )


def hermes_api_token(hermes_home: os.PathLike[str] | str) -> str:
    return (
        os.environ.get("HERMES_API_TOKEN", "").strip()
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
    resolved_iris_token = app_settings.token or iris_token(hermes_root)
    resolved_hermes_api_token = hermes_api_token(hermes_root)
    if not resolved_hermes_api_token:
        hermes_env_path = os.path.join(os.fspath(hermes_root), ".env")
        logger.warning(
            "HERMES_API_TOKEN not set and %s has no API_SERVER_KEY; automation routes will return 503 when Hermes requires Jobs API auth.",
            hermes_env_path,
        )
    app.state.management_token = resolved_iris_token
    app.state.runtime_delivery_token = resolved_iris_token
    app.state.runtime_registry = RuntimeRegistry(
        core_store=core_store,
        hermes_home=str(hermes_root),
        management_url=f"http://{app_settings.host}:{app_settings.port}",
        iris_token=resolved_iris_token,
        hermes_api_token=resolved_hermes_api_token,
    )
    app.state.runtime_registry.ensure_default_runtime()
    app.state.live_delivery_bus = LiveDeliveryBus(core_store=core_store)
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
    require_runtime_delivery_auth = make_auth_dependency("runtime_delivery_token")

    @app.get("/health", response_model=HealthResponse)
    async def health(_auth: None = Depends(require_auth)) -> HealthResponse:
        return HealthResponse(
            checkedAt=checked_at(),
            version=__version__,
            pid=os.getpid(),
            managed=managed_flag(),
            bindHost=app_settings.host,
            port=app_settings.port,
            hermesHome=str(hermes_root),
            profilesRootExists=(hermes_root / "profiles").is_dir(),
        )

    @app.get("/v1/health")
    async def core_health(_auth: None = Depends(require_auth)) -> dict[str, Any]:
        return {
            "ok": True,
            "checkedAt": checked_at(),
            "service": "iris-core",
            "version": __version__,
            "pid": os.getpid(),
            "managed": managed_flag(),
            "bindHost": app_settings.host,
            "port": app_settings.port,
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
        device = getattr(request.state, "iris_device", None)
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
        device = getattr(request.state, "iris_device", None)
        device_id = str(device.get("id") or "") if isinstance(device, dict) else ""
        if not device_id.startswith("dev_"):
            raise ManagementError("A paired device token is required for device cursors.", status_code=401)
        return {
            "ok": True,
            "cursor": core_store.upsert_device_cursor(device_id, cursor.streamName, cursor.lastCursor),
        }

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
        sessions = merge_active_sessions_for_agents(app, sessions, [row for row in agents if row])
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
        if not messages:
            messages = merge_core_event_messages(
                messages,
                core_event_messages_for_session(app, session_id),
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
                    "irisSessionId": session_id,
                    "clientMessageId": message_id,
                    "clientRequestId": message_id,
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
                        "source": "iris-core-send",
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
                    "source": "iris-core-send",
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
            metadata={"kind": "cancel", "irisSessionId": session_id},
        )
        return {"ok": bool(result.get("ok")), "sessionId": session_id, "runtime": result}

    @app.get("/v1/events")
    async def core_events(
        after: int = Query(0),
        limit: int = Query(200),
        agentId: str | None = Query(None),
        automationOnly: bool = Query(False),
        order: str = Query("asc"),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        if agentId and not app.state.runtime_registry.agent(agentId):
            raise ManagementError("Agent was not found.", status_code=404)
        after = clamp_int(after, default=0, minimum=0, maximum=9_223_372_036_854_775_807)
        limit = clamp_int(limit, default=200, minimum=1, maximum=500)
        descending = order.lower() == "desc"
        events = app.state.live_delivery_bus.list_events(
            after=after,
            limit=limit,
            agent_id=agentId or "",
            automation_only=automationOnly,
            descending=descending,
        )
        latest_cursor = app.state.live_delivery_bus.latest_cursor(agent_id=agentId or "")
        return {
            "ok": True,
            "events": events,
            "cursor": latest_cursor if descending else max((int(event["cursor"]) for event in events), default=latest_cursor),
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
        delivery_runtime_session_id = cron_delivery_external_session_id(app, agent, delivery)
        delivery_title = cron_delivery_title(delivery)
        session = resolve_core_session(
            app,
            "",
            runtime_id=delivery.runtimeId,
            runtime_profile=delivery.profile,
            external_chat_id=delivery.chatId,
        )
        if not session:
            project_link = app.state.core_store.project_session_link_for_external_chat(
                runtime_id=delivery.runtimeId,
                runtime_profile=delivery.profile,
                external_chat_id=delivery.chatId,
            )
            session = draft_session(
                agent,
                title=delivery_title or f"{delivery.profile} delivery",
                external_chat_id=delivery.chatId,
                external_session_id=delivery_runtime_session_id,
                metadata={"createdBy": "runtime-delivery"},
            )
            remember_active_session(app, session)
            if project_link:
                app.state.core_store.link_project_session(str(project_link["projectId"]), session)
        elif delivery_title and str(session.get("title") or "").endswith(" delivery"):
            session = {**session, "title": delivery_title}
            remember_active_session(app, session)
        if delivery_runtime_session_id and delivery_runtime_session_id != session.get("externalSessionId"):
            session = {**session, "externalSessionId": delivery_runtime_session_id}
            remember_active_session(app, session)
            project = app.state.core_store.project_for_session(session["id"])
            if project:
                app.state.core_store.link_project_session(project["id"], session)
        session_id = session["id"]
        project = app.state.core_store.project_for_session(session_id)
        stream_message_id = str(
            delivery.metadata.get("streamMessageId")
            or delivery.metadata.get("stream_message_id")
            or delivery.messageId
        )
        is_streaming = bool(delivery.metadata.get("streaming"))
        is_final = bool(delivery.metadata.get("finalize") or delivery.metadata.get("final"))
        is_error_delivery = delivery.source == "hermes-error" or bool(delivery.metadata.get("error"))
        event_type = (
            "message.assistant.error"
            if is_error_delivery
            else "message.assistant.completed" if is_final or not is_streaming else "message.assistant.delta"
        )
        event_metadata = {
            "profile": delivery.profile,
            "chatId": delivery.chatId,
            "source": delivery.source,
            "irisSessionId": session_id,
            **delivery.metadata,
        }
        if project:
            event_metadata.update(project_runtime_metadata(project))
        client_request_id = str(
            event_metadata.get("clientRequestId")
            or event_metadata.get("client_request_id")
            or ""
        ).strip()
        if client_request_id:
            event_metadata["clientRequestId"] = client_request_id
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
            content=str(delivery.metadata.get("error") or delivery.content) if is_error_delivery and not delivery.content else delivery.content,
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
        runtime_payload = {key: value for key, value in payload.items() if key != "_delivery"}
        result = await run_runtime_call(app, adapter.create_automation, runtime_payload)
        if not result.get("ok"):
            return {
                "ok": False,
                "error": result.get("error") or "Could not create Hermes job.",
                "runtime": result,
            }
        job = automation_job_payload(result)
        delivery = payload.get("_delivery") if isinstance(payload.get("_delivery"), dict) else {}
        delivery_session = delivery.get("session") if isinstance(delivery.get("session"), dict) else {}
        delivery_project = delivery.get("project") if isinstance(delivery.get("project"), dict) else None
        request_payload = {
            **dump_model(request),
            "deliverToSessionId": str(delivery_session.get("id") or request.deliverToSessionId or ""),
            "projectId": delivery_project["id"] if delivery_project else None,
        }
        automation = automation_record_from_job(
            agent,
            job,
            app=app,
            request_payload=request_payload,
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
            if "deliverToSessionId" in updates or "projectId" in updates:
                delivery_request = {**automation, **updates}
                delivery = automation_delivery_resolution(app, agent, delivery_request)
                delivery_session = delivery.get("session") if isinstance(delivery.get("session"), dict) else {}
                delivery_project = delivery.get("project") if isinstance(delivery.get("project"), dict) else None
                updates["deliver"] = delivery["deliver"]
                updates["deliverToSessionId"] = str(delivery_session.get("id") or updates.get("deliverToSessionId") or "")
                updates["projectId"] = delivery_project["id"] if delivery_project else None
            result = await run_runtime_call(app, 
                adapter.update_automation,
                automation["externalJobId"],
                automation_update_payload(updates),
            )
            if not result.get("ok"):
                return {"ok": False, "error": result.get("error") or "Could not update Hermes job.", "runtime": result}
        updated_job = automation_job_payload(result)
        updated = automation_record_from_job(agent, updated_job, app=app, request_payload={**automation, **updates}) if updated_job else automation
        return {"ok": True, "automation": updated, "runtime": result}

    @app.get("/v1/automations/{automation_id}")
    async def core_get_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        automation = resolve_runtime_automation(app, automation_id)
        if not automation:
            raise ManagementError("Automation was not found.", status_code=404)
        return {"ok": True, "automation": automation}

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

    @app.get("/v1/agents/{agent_id}/gateway/status")
    async def core_agent_gateway_status(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return await core_agent_gateway_action(app, agent_id, "status")

    @app.post("/v1/agents/{agent_id}/gateway/start")
    async def core_agent_gateway_start(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return await core_agent_gateway_action(app, agent_id, "start")

    @app.post("/v1/agents/{agent_id}/gateway/stop")
    async def core_agent_gateway_stop(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return await core_agent_gateway_action(app, agent_id, "stop")

    @app.post("/v1/agents/{agent_id}/gateway/restart")
    async def core_agent_gateway_restart(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return await core_agent_gateway_action(app, agent_id, "restart")

    @app.post("/v1/system/install-hermes-plugin")
    async def core_install_iris_hermes_plugin(_auth: None = Depends(require_auth)) -> dict[str, Any]:
        return await run_runtime_call(app, install_iris_hermes_plugin_for_app, app)

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


async def core_agent_gateway_action(app: FastAPI, agent_id: str, action: str) -> dict[str, Any]:
    agent = app.state.runtime_registry.agent(agent_id)
    if not agent:
        raise ManagementError("Agent was not found.", status_code=404)
    profile = str(agent["runtimeProfile"])
    runtime_id = str(agent["runtimeId"])
    registry = app.state.runtime_registry
    timeout = 30 if action in {"start", "restart"} else DEFAULT_RUNTIME_CALL_TIMEOUT_SECONDS
    command = await run_runtime_call(
        app,
        registry.gateway_status if action == "status" else registry.gateway_control,
        runtime_id,
        profile,
        *(() if action == "status" else (action,)),
        timeout=timeout,
    )
    probe: dict[str, Any] | None = None
    try:
        probe = await run_runtime_call(app, registry.probe, runtime_id, profile=profile)
    except Exception as exc:
        probe = {
            "gateway": {"ok": False, "error": str(exc)},
            "management": {"ok": False, "error": str(exc)},
            "irisAdapter": {"ok": False, "error": str(exc), "profile": profile},
        }
    return {
        "ok": bool(command.get("ok")),
        "agentId": agent_id,
        "runtimeId": runtime_id,
        "profile": profile,
        "action": action,
        "command": command,
        "probe": probe,
        **({} if command.get("ok") else {"error": command.get("error") or f"Hermes gateway {action} failed."}),
    }


def install_iris_hermes_plugin_for_app(app: FastAPI) -> dict[str, Any]:
    settings: Settings = app.state.settings
    hermes_home = str(normalize_hermes_home(settings.hermes_home or os.environ.get("HERMES_HOME") or "~/.hermes"))
    token = getattr(app.state, "management_token", "") or iris_token(hermes_home)
    inbound_port = getattr(settings, "iris_inbound_port", None) or DEFAULT_IRIS_INBOUND_PORT
    installations: list[dict[str, Any]] = []
    for index, target_home in enumerate(hermes_plugin_install_homes(hermes_home)):
        try:
            result = install_hermes_plugin(
                str(target_home),
                host=settings.host,
                port=settings.port,
                token=token,
                inbound_port=int(inbound_port) + index,
            )
        except SystemExit as exc:
            result = {
                "ok": False,
                "hermesHome": str(target_home),
                "error": str(exc) or "Iris could not install the Hermes plugin.",
                "restartRequired": True,
            }
        except Exception as exc:  # pragma: no cover - defensive
            result = {
                "ok": False,
                "hermesHome": str(target_home),
                "error": str(exc) or "Iris could not install the Hermes plugin.",
                "restartRequired": True,
            }
        installations.append(result)

    failed_install = next((item for item in installations if not item.get("ok")), None)
    failed_enable = next((item for item in installations if not item.get("enabled")), None)
    primary = installations[0] if installations else {}
    return {
        "ok": failed_install is None,
        "hermesHome": hermes_home,
        "pluginPath": primary.get("pluginPath", ""),
        "enabled": failed_enable is None,
        "enableError": failed_enable.get("enableError", "") if failed_enable else "",
        "restartRequired": any(bool(item.get("restartRequired", True)) for item in installations) if installations else True,
        "installations": installations,
        **({} if failed_install is None else {"error": failed_install.get("error") or "Iris could not install the Hermes plugin."}),
    }


def hermes_plugin_install_homes(hermes_home: str) -> list[Path]:
    root = Path(hermes_home).expanduser()
    homes = [root]
    profiles_root = root / "profiles"
    if profiles_root.is_dir():
        for item in sorted(profiles_root.iterdir(), key=lambda path: path.name.lower()):
            if item.is_dir():
                homes.append(item)
    return homes


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


def core_event_messages_for_session(app: FastAPI, session_id: str) -> list[dict[str, Any]]:
    events = app.state.live_delivery_bus.list_events(after=0, limit=500, session_id=session_id)
    messages: list[dict[str, Any]] = []
    for event in events:
        metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
        event_type = str(event.get("type") or "")
        if bool(metadata.get("hidden")):
            continue
        if str(event.get("role") or "") != "assistant":
            continue
        if not is_automation_delivery_event(event, metadata):
            continue
        if not (
            event_type == "message.error" or
            event_type == "message.assistant.error" or
            event_type == "message.assistant.completed"
        ):
            continue
        message_id = str(event.get("externalMessageId") or event.get("id") or "")
        messages.append({
            "id": message_id,
            "sessionId": session_id,
            "role": "assistant",
            "content": str(event.get("content") or ""),
            "status": "error" if "error" in event_type else "completed",
            "toolName": "",
            "createdAt": int(event.get("createdAt") or now()),
            "updatedAt": int(event.get("createdAt") or now()),
            "metadata": {
                **metadata,
                "eventCursor": int(event.get("cursor") or 0),
                "eventType": event_type,
                "parentEventId": str(event.get("parentEventId") or ""),
                "externalMessageId": message_id,
            },
        })
    return messages


def is_automation_delivery_event(event: dict[str, Any], metadata: dict[str, Any]) -> bool:
    source = str(metadata.get("source") or "")
    return (
        source == "hermes-cron" or
        bool(metadata.get("automationId")) or
        bool(metadata.get("jobId")) or
        bool(metadata.get("job_id"))
    )


def merge_core_event_messages(
    history_messages: list[dict[str, Any]],
    event_messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not event_messages:
        return history_messages
    seen = set()
    for message in history_messages:
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        for key in (
            str(message.get("id") or ""),
            str(metadata.get("externalMessageId") or ""),
            str(metadata.get("streamMessageId") or metadata.get("stream_message_id") or ""),
        ):
            if key:
                seen.add(key)
    merged = list(history_messages)
    for message in event_messages:
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        keys = [
            str(message.get("id") or ""),
            str(metadata.get("externalMessageId") or ""),
            str(metadata.get("streamMessageId") or metadata.get("stream_message_id") or ""),
        ]
        if any(key and key in seen for key in keys):
            continue
        for key in keys:
            if key:
                seen.add(key)
        merged.append(message)
    merged.sort(key=lambda row: int(row.get("createdAt") or row.get("updatedAt") or 0))
    return coalesce_core_messages(merged)


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


def merge_active_sessions_for_agents(
    app: FastAPI,
    sessions: list[dict[str, Any]],
    agents: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    agent_ids = {str(agent.get("id") or "") for agent in agents}
    seen_ids = {str(session.get("id") or "") for session in sessions}
    seen_external_sessions = {
        (
            str(session.get("runtimeId") or ""),
            str(session.get("runtimeProfile") or ""),
            str(session.get("externalSessionId") or ""),
        )
        for session in sessions
        if str(session.get("externalSessionId") or "")
    }
    seen_chats = {
        (
            str(session.get("runtimeId") or ""),
            str(session.get("runtimeProfile") or ""),
            str(session.get("externalChatId") or ""),
        )
        for session in sessions
        if str(session.get("externalChatId") or "")
    }
    merged = list(sessions)
    for session in list(app.state.active_sessions.values()):
        if str(session.get("agentId") or "") not in agent_ids:
            continue
        session_id = str(session.get("id") or "")
        chat_key = (
            str(session.get("runtimeId") or ""),
            str(session.get("runtimeProfile") or ""),
            str(session.get("externalChatId") or ""),
        )
        external_session_key = (
            str(session.get("runtimeId") or ""),
            str(session.get("runtimeProfile") or ""),
            str(session.get("externalSessionId") or ""),
        )
        if active_session_runtime_backing_missing(session, seen_ids, seen_chats, seen_external_sessions):
            if should_prune_missing_runtime_active_session(session):
                forget_active_session(app, session_id, session)
                continue
        if session_id in seen_ids or (chat_key[2] and chat_key in seen_chats):
            continue
        if external_session_key[2] and external_session_key in seen_external_sessions:
            continue
        seen_ids.add(session_id)
        if chat_key[2]:
            seen_chats.add(chat_key)
        if external_session_key[2]:
            seen_external_sessions.add(external_session_key)
        merged.append(session)
    return merged


def active_session_runtime_backing_missing(
    session: dict[str, Any],
    seen_ids: set[str],
    seen_chats: set[tuple[str, str, str]],
    seen_external_sessions: set[tuple[str, str, str]],
) -> bool:
    external_session_id = str(session.get("externalSessionId") or "")
    if not external_session_id:
        return False
    session_id = str(session.get("id") or "")
    runtime_id = str(session.get("runtimeId") or "")
    runtime_profile = str(session.get("runtimeProfile") or "")
    chat_id = str(session.get("externalChatId") or "")
    return (
        session_id not in seen_ids
        and (not chat_id or (runtime_id, runtime_profile, chat_id) not in seen_chats)
        and (runtime_id, runtime_profile, external_session_id) not in seen_external_sessions
    )


def should_prune_missing_runtime_active_session(session: dict[str, Any]) -> bool:
    if not str(session.get("externalSessionId") or ""):
        return False
    metadata = session.get("metadata") if isinstance(session.get("metadata"), dict) else {}
    if not metadata.get("draft"):
        return True
    updated_at = int(session.get("updatedAt") or session.get("createdAt") or 0)
    if updated_at <= 0:
        return True
    return now() - updated_at > ACTIVE_SESSION_RUNTIME_MISSING_GRACE_SECONDS


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
    links = app.state.core_store.list_project_session_links(project["id"])
    resolved_by_link_id: dict[str, dict[str, Any]] = {}
    grouped_links: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for link in links:
        if link.get("externalSessionId") or link.get("externalChatId"):
            key = (str(link["runtimeId"]), str(link["runtimeProfile"]))
            grouped_links.setdefault(key, []).append(link)
            continue
        session = active_core_session(
            app,
            link["sessionId"],
            runtime_id=link["runtimeId"],
            runtime_profile=link["runtimeProfile"],
            external_chat_id=link["externalChatId"],
        )
        if session:
            resolved_by_link_id[link["sessionId"]] = session

    for (runtime_id, runtime_profile), group in grouped_links.items():
        agent = agent_for_runtime_profile(app, runtime_id, runtime_profile)
        if not agent:
            for link in group:
                session = resolve_project_session(app, link)
                if session:
                    resolved_by_link_id[link["sessionId"]] = session
            continue
        adapter = app.state.runtime_registry.adapter_for_runtime(runtime_id)
        batch_lookup = getattr(adapter, "get_sessions_by_external_refs", None)
        if not callable(batch_lookup):
            for link in group:
                session = resolve_project_session(app, link)
                if session:
                    resolved_by_link_id[link["sessionId"]] = session
            continue
        runtime_sessions = batch_lookup(
            agent,
            external_session_ids=[
                str(link.get("externalSessionId") or "")
                for link in group
                if str(link.get("externalSessionId") or "")
            ],
            external_chat_ids=[
                str(link.get("externalChatId") or "")
                for link in group
                if str(link.get("externalChatId") or "")
            ],
        )
        sessions_by_external_id = {
            str(session.get("externalSessionId") or ""): session
            for session in runtime_sessions
            if str(session.get("externalSessionId") or "")
        }
        sessions_by_chat_id = {
            str(session.get("externalChatId") or ""): session
            for session in runtime_sessions
            if str(session.get("externalChatId") or "")
        }
        for link in group:
            session = sessions_by_external_id.get(str(link.get("externalSessionId") or ""))
            if not session:
                session = sessions_by_chat_id.get(str(link.get("externalChatId") or ""))
            if session:
                remember_active_session(app, session)
                resolved_by_link_id[link["sessionId"]] = session
                continue
            active = active_core_session(
                app,
                link["sessionId"],
                runtime_id=link["runtimeId"],
                runtime_profile=link["runtimeProfile"],
                external_chat_id=link["externalChatId"],
                runtime_missing=True,
            )
            if active:
                resolved_by_link_id[link["sessionId"]] = active

    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for link in links:
        session = resolved_by_link_id.get(link["sessionId"])
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
        return active_core_session(
            app,
            link["sessionId"],
            runtime_id=link["runtimeId"],
            runtime_profile=link["runtimeProfile"],
            external_chat_id=link["externalChatId"],
            runtime_missing=True,
        )
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
            runtime_missing=True,
        )
    return None


def active_core_session(
    app: FastAPI,
    session_id: str,
    *,
    runtime_id: str = "",
    runtime_profile: str = "",
    external_chat_id: str = "",
    runtime_missing: bool = False,
) -> dict[str, Any] | None:
    active = app.state.active_sessions.get(session_id) if session_id else None
    if active:
        if runtime_missing and should_prune_missing_runtime_active_session(active):
            forget_active_session(app, str(active.get("id") or session_id), active)
            return None
        return active
    if external_chat_id:
        mapped_id = app.state.active_sessions_by_chat.get(
            (runtime_id or DEFAULT_RUNTIME_ID, runtime_profile or "default", external_chat_id)
        )
        if mapped_id and mapped_id in app.state.active_sessions:
            active = app.state.active_sessions[mapped_id]
            if runtime_missing and should_prune_missing_runtime_active_session(active):
                forget_active_session(app, str(active.get("id") or mapped_id), active)
                return None
            return active
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
                automations.append(automation_record_from_job(agent, job, app=app))
    return sorted(automations, key=lambda row: (row["nextRunAt"] or row["updatedAt"], -row["createdAt"], row["id"]))


def resolve_runtime_automation(app: FastAPI, automation_id: str) -> dict[str, Any] | None:
    registry: RuntimeRegistry = app.state.runtime_registry
    for agent in registry.agents():
        adapter = registry.adapter_for_runtime(agent["runtimeId"])
        result = adapter.get_automation(automation_id)
        if not result.get("ok"):
            continue
        job = automation_job_payload(result)
        if job_id(job):
            return automation_record_from_job(agent, job, app=app)
    return None


def automation_record_from_job(
    agent: dict[str, Any],
    job: dict[str, Any],
    *,
    app: FastAPI | None = None,
    request_payload: dict[str, Any] | None = None,
    deliver: str = "",
) -> dict[str, Any]:
    timestamp = now()
    external_job_id = job_id(job)
    request_payload = request_payload or {}
    job_name = str(job.get("name") or request_payload.get("name") or "Hermes job")
    if job_name and "name" not in request_payload:
        request_payload = {**request_payload, "name": job_name}
    deliver = deliver or str(job.get("deliver") or job.get("delivery") or "")
    routing = automation_delivery_fields(app, agent, deliver, request_payload)
    return {
        "id": external_job_id,
        "agentId": agent["id"],
        "runtimeId": agent["runtimeId"],
        "externalJobId": external_job_id,
        "name": job_name,
        "schedule": job_schedule(job) or str(request_payload.get("schedule") or ""),
        "prompt": str(job.get("prompt") or request_payload.get("prompt") or ""),
        "projectId": routing["projectId"],
        "deliverToSessionId": routing["deliverToSessionId"],
        "resolvedDeliveryTarget": routing["resolvedDeliveryTarget"],
        "status": job_status(job) or "active",
        "createdAt": job_timestamp(job, "createdAt", "created_at", "created") or timestamp,
        "updatedAt": job_timestamp(job, "updatedAt", "updated_at", "updated") or timestamp,
        "lastRunAt": job_timestamp(job, "lastRunAt", "last_run_at", "lastRun", "last_run"),
        "nextRunAt": job_timestamp(job, "nextRunAt", "next_run_at", "nextRun", "next_run"),
        "skills": list(job.get("skills") or []),
        "skill": job.get("skill"),
        "script": job.get("script"),
        "noAgent": bool(job.get("no_agent")),
        "contextFrom": list(job.get("context_from") or []),
        "workdir": job.get("workdir"),
        "enabledToolsets": job.get("enabled_toolsets"),
        "model": job.get("model"),
        "provider": job.get("provider"),
        "baseUrl": job.get("base_url"),
        "enabled": job.get("enabled", True),
        "metadata": {
            "source": "hermes-jobs",
            "deliver": deliver,
            "projectId": routing["projectId"],
            "deliverToSessionId": routing["deliverToSessionId"],
            "resolvedDeliveryTarget": routing["resolvedDeliveryTarget"],
            "repeat": job_repeat(job),
            "runtimeJob": job,
        },
    }


def automation_delivery_fields(
    app: FastAPI | None,
    agent: dict[str, Any],
    deliver: str,
    request_payload: dict[str, Any],
) -> dict[str, Any]:
    session = None
    project_id = normalized_optional_string(request_payload.get("projectId"))
    deliver_to_session_id = normalized_optional_string(request_payload.get("deliverToSessionId"))
    chat_id = iris_delivery_chat_id(deliver)
    project = None

    if app and deliver_to_session_id:
        session = resolve_core_session(app, deliver_to_session_id, prefer_runtime=True)
    if app and not session and chat_id:
        session = resolve_core_session(
            app,
            "",
            runtime_id=agent["runtimeId"],
            runtime_profile=agent["runtimeProfile"],
            external_chat_id=chat_id,
            prefer_runtime=True,
        )
    if app and session:
        deliver_to_session_id = str(session.get("id") or deliver_to_session_id)
        linked_project = app.state.core_store.project_for_session(deliver_to_session_id)
        if linked_project:
            project = linked_project
            project_id = linked_project["id"]
        chat_id = str(session.get("externalChatId") or chat_id)
    if app and not project_id and chat_id:
        link = app.state.core_store.project_session_link_for_external_chat(
            runtime_id=agent["runtimeId"],
            runtime_profile=agent["runtimeProfile"],
            external_chat_id=chat_id,
        )
        if link:
            deliver_to_session_id = str(link["sessionId"])
            project_id = str(link["projectId"])
            project = app.state.core_store.get_project(project_id)
    if app and project_id and not project:
        project = app.state.core_store.get_project(project_id)

    if app and chat_id and not session and is_automation_delivery_chat_id(chat_id):
        title = str(request_payload.get("name") or "Automation")
        metadata = {"createdBy": "automation", "automationDelivery": True}
        if project:
            metadata.update(project_runtime_metadata(project))
        session = draft_session(
            agent,
            title=title,
            external_chat_id=chat_id,
            metadata=metadata,
        )
        remember_active_session(app, session)
        deliver_to_session_id = str(session.get("id") or deliver_to_session_id)
        if project:
            app.state.core_store.link_project_session(project["id"], session, metadata={"createdBy": "automation"})

    resolved_delivery = {
        "platform": "iris" if chat_id else "",
        "deliver": deliver,
        "chatId": chat_id,
        "sessionId": deliver_to_session_id,
        "projectId": project_id,
    }
    return {
        "projectId": project_id or None,
        "deliverToSessionId": deliver_to_session_id,
        "resolvedDeliveryTarget": resolved_delivery,
    }


def automation_delivery_resolution(
    app: FastAPI,
    agent: dict[str, Any],
    request: dict[str, Any],
) -> dict[str, Any]:
    explicit_session_id = normalized_optional_string(request.get("deliverToSessionId"))
    if explicit_session_id:
        session = resolve_core_session(app, explicit_session_id)
        if not session or session["agentId"] != agent["id"]:
            raise ManagementError("Delivery session was not found for this agent.", status_code=404)
        project = app.state.core_store.project_for_session(session["id"])
        chat_id = str(session.get("externalChatId") or chat_id_for_session(session["id"]))
        return {
            "deliver": f"iris:{chat_id}",
            "session": session,
            "project": project,
        }

    project_id = normalized_optional_string(request.get("projectId"))
    project = app.state.core_store.get_project(project_id) if project_id else None
    if project_id and not project:
        raise ManagementError("Project was not found.", status_code=404)
    if project and project["defaultAgentId"] != agent["id"]:
        raise ManagementError("Project default agent does not match the automation agent.", status_code=400)

    chat_id = automation_delivery_chat_id()
    session = resolve_core_session(
        app,
        "",
        runtime_id=agent["runtimeId"],
        runtime_profile=agent["runtimeProfile"],
        external_chat_id=chat_id,
        prefer_runtime=True,
    )
    if not session:
        metadata = {"createdBy": "automation", "automationDelivery": True}
        if project:
            metadata.update(project_runtime_metadata(project))
        session = draft_session(
            agent,
            title=str(request.get("name") or "Automation"),
            external_chat_id=chat_id,
            metadata=metadata,
        )
    remember_active_session(app, session)
    if project:
        app.state.core_store.link_project_session(project["id"], session, metadata={"createdBy": "automation"})
        session = with_project_metadata(session, project)
    return {
        "deliver": f"iris:{session['externalChatId']}",
        "session": session,
        "project": project,
    }


def automation_delivery_chat_id() -> str:
    return f"automation-{random_id('chat')}"


def is_automation_delivery_chat_id(chat_id: str) -> bool:
    return str(chat_id or "").startswith("automation-")


def iris_delivery_chat_id(deliver: str) -> str:
    value = str(deliver or "").strip()
    return value.removeprefix("iris:") if value.startswith("iris:") else ""


CRON_RESPONSE_RE = re.compile(
    r"^\s*Cronjob Response:\s*(?P<title>.*?)\s*\(job_id:\s*(?P<job_id>[^)\s]+)\)",
    re.IGNORECASE | re.DOTALL,
)


def cron_delivery_fields(delivery: RuntimeDeliveryHermesRequest) -> dict[str, str]:
    metadata = delivery.metadata if isinstance(delivery.metadata, dict) else {}
    job_id_value = (
        metadata.get("jobId")
        or metadata.get("job_id")
        or metadata.get("automationId")
        or metadata.get("automation_id")
        or ""
    )
    title = str(metadata.get("automationName") or metadata.get("jobName") or metadata.get("job_name") or "").strip()
    job_id_text = str(job_id_value or "").strip()
    match = CRON_RESPONSE_RE.search(str(delivery.content or ""))
    if match:
        title = title or re.sub(r"\s+", " ", match.group("title")).strip()
        job_id_text = job_id_text or str(match.group("job_id") or "").strip()
    return {"jobId": job_id_text, "title": title}


def cron_delivery_title(delivery: RuntimeDeliveryHermesRequest) -> str:
    if delivery.source != "hermes-cron":
        return ""
    return cron_delivery_fields(delivery)["title"]


def cron_delivery_external_session_id(
    app: FastAPI,
    agent: dict[str, Any],
    delivery: RuntimeDeliveryHermesRequest,
) -> str:
    metadata = delivery.metadata if isinstance(delivery.metadata, dict) else {}
    explicit = str(
        metadata.get("externalSessionId")
        or metadata.get("hermesSessionId")
        or metadata.get("cronSessionId")
        or metadata.get("sessionId")
        or ""
    ).strip()
    if explicit:
        return explicit
    if delivery.source != "hermes-cron":
        return ""
    job_id_text = cron_delivery_fields(delivery)["jobId"]
    if not job_id_text:
        return ""
    adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
    finder = getattr(adapter, "latest_cron_session_for_job", None)
    if not callable(finder):
        return ""
    try:
        session = finder(agent, job_id_text)
    except Exception:
        logging.getLogger(__name__).exception("Could not resolve Hermes cron session for job %s", job_id_text)
        return ""
    return str((session or {}).get("externalSessionId") or "")


def normalized_optional_string(value: Any) -> str:
    return str(value or "").strip()


def automation_create_payload(app: FastAPI, agent: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    schedule = str(request.get("schedule") or "").strip()
    prompt = str(request.get("prompt") or "").strip()
    if not schedule:
        raise ManagementError("Automation schedule is required.", status_code=400)
    if not prompt:
        raise ManagementError("Automation prompt is required.", status_code=400)
    delivery = automation_delivery_resolution(app, agent, request)
    deliver = delivery["deliver"]
    payload: dict[str, Any] = {
        "name": str(request.get("name") or "Iris reminder"),
        "schedule": schedule,
        "prompt": prompt,
        "_delivery": delivery,
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


def install_hermes_plugin(
    hermes_home: str,
    *,
    host: str,
    port: int,
    token: str = "",
    inbound_port: int = DEFAULT_IRIS_INBOUND_PORT,
) -> dict[str, Any]:
    source = bundled_iris_platform_path()
    if not source.is_dir():
        raise SystemExit(f"Bundled iris-platform payload was not found at {source}")
    target_home = Path(hermes_home).expanduser()
    destination = target_home / "plugins" / "iris-platform"
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache", "*.pyc"))
    update_plugin_env_hints(
        target_home / ".env",
        {
            "IRIS_BASE_URL": f"http://{host}:{port}",
            "IRIS_INBOUND_HOST": host,
            "IRIS_INBOUND_PORT": str(inbound_port),
            **({"IRIS_TOKEN": token} if token else {}),
        },
    )
    hermes_result = run_hermes_plugin_enable(target_home)
    result = {
        "ok": True,
        "hermesHome": str(target_home),
        "pluginPath": str(destination),
        "enabled": hermes_result["ok"],
        "enableError": hermes_result.get("error", ""),
        "restartRequired": True,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    print("Restart Hermes gateway so the updated iris-platform plugin is loaded.")
    if not hermes_result["ok"]:
        print(
            f"Plugin files were copied, but Hermes CLI did not enable it. Run: HERMES_HOME={target_home} hermes plugins enable iris-platform",
            file=sys.stderr,
        )
    return result


def bundled_iris_platform_path() -> Path:
    return Path(__file__).resolve().parent / "payload" / "iris-platform"


def update_plugin_env_hints(path: Path, values: dict[str, str]) -> None:
    existing: list[str] = []
    if path.exists():
        existing = path.read_text(encoding="utf-8").splitlines()
    managed_keys = set(values)
    next_lines = [
        line
        for line in existing
        if not any(line.startswith(f"{key}=") for key in managed_keys)
    ]
    for key, value in values.items():
        if value:
            next_lines.append(f"{key}={shell_env_value(value)}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(next_lines).rstrip() + "\n", encoding="utf-8")


def shell_env_value(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_./:@-]+", value):
        return value
    return json.dumps(value)


def run_hermes_plugin_enable(hermes_home: Path) -> dict[str, Any]:
    hermes = shutil.which("hermes")
    if not hermes:
        return {"ok": False, "error": "Hermes CLI was not found in PATH."}
    result = subprocess_run(
        [hermes, "plugins", "enable", "iris-platform"],
        env={**os.environ, "HERMES_HOME": str(hermes_home)},
    )
    if result["returncode"] == 0:
        return {"ok": True}
    return {"ok": False, "error": result["stderr"] or result["stdout"] or "Hermes CLI failed."}


def subprocess_run(command: list[str], *, env: dict[str, str] | None = None) -> dict[str, Any]:
    import subprocess

    completed = subprocess.run(command, capture_output=True, text=True, env=env)
    return {
        "returncode": completed.returncode,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
    }


def service_install(settings: Settings, *, replace: bool = False) -> dict[str, Any]:
    if sys.platform != "darwin":
        raise SystemExit("Iris Core service install is currently supported on macOS only.")
    plist_path = launch_agent_path()
    if plist_path.exists() and not replace:
        raise SystemExit(f"LaunchAgent already exists at {plist_path}. Re-run with --replace to update it.")
    logs_dir = Path.home() / "Library" / "Logs" / "Iris"
    logs_dir.mkdir(parents=True, exist_ok=True)
    binary = iris_core_executable_path()
    plist = launch_agent_plist(
        binary=binary,
        host=settings.host,
        port=settings.port,
        hermes_home=str(normalize_hermes_home(settings.hermes_home)),
        stdout_log=str(logs_dir / "core-launchagent.out.log"),
        stderr_log=str(logs_dir / "core-launchagent.err.log"),
    )
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    plist_path.write_text(plist, encoding="utf-8")
    result = launchctl("bootstrap", f"gui/{os.getuid()}", str(plist_path))
    if result["returncode"] != 0 and "Service is already loaded" not in (result["stderr"] + result["stdout"]):
        # Try the older launchctl interface on older macOS variants.
        result = launchctl("load", "-w", str(plist_path))
    payload = {"ok": result["returncode"] == 0, "plistPath": str(plist_path), **result}
    print(json.dumps(payload, indent=2, sort_keys=True))
    return payload


def service_uninstall() -> dict[str, Any]:
    if sys.platform != "darwin":
        raise SystemExit("Iris Core service uninstall is currently supported on macOS only.")
    plist_path = launch_agent_path()
    bootout = launchctl("bootout", f"gui/{os.getuid()}", str(plist_path))
    if bootout["returncode"] != 0:
        bootout = launchctl("unload", "-w", str(plist_path))
    if plist_path.exists():
        plist_path.unlink()
    payload = {"ok": True, "plistPath": str(plist_path), "launchctl": bootout}
    print(json.dumps(payload, indent=2, sort_keys=True))
    return payload


def service_status() -> dict[str, Any]:
    plist_path = launch_agent_path()
    result = launchctl("print", f"gui/{os.getuid()}/com.nousresearch.iris-core") if sys.platform == "darwin" else {"returncode": 1, "stdout": "", "stderr": "unsupported platform"}
    payload = {
        "ok": result["returncode"] == 0,
        "installed": plist_path.exists(),
        "loaded": result["returncode"] == 0,
        "plistPath": str(plist_path),
        "detail": result["stdout"] or result["stderr"],
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return payload


def launch_agent_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / "com.nousresearch.iris-core.plist"


def iris_core_executable_path() -> str:
    if getattr(sys, "frozen", False):
        return sys.executable
    return shutil.which("iris-core") or sys.argv[0]


def launchctl(*args: str) -> dict[str, Any]:
    if sys.platform != "darwin":
        return {"returncode": 1, "stdout": "", "stderr": "unsupported platform"}
    return subprocess_run(["launchctl", *args])


def launch_agent_plist(
    *,
    binary: str,
    host: str,
    port: int,
    hermes_home: str,
    stdout_log: str,
    stderr_log: str,
) -> str:
    import plistlib

    payload = {
        "Label": "com.nousresearch.iris-core",
        "ProgramArguments": [
            binary,
            "serve",
            "--host",
            host,
            "--port",
            str(port),
            "--hermes-home",
            hermes_home,
        ],
        "EnvironmentVariables": {
            "IRIS_CORE_MANAGED": "0",
            "HERMES_HOME": hermes_home,
        },
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": stdout_log,
        "StandardErrorPath": stderr_log,
        "WorkingDirectory": str(Path.home()),
    }
    return plistlib.dumps(payload, sort_keys=False).decode("utf-8")


def is_automation_activity_event(event: dict[str, Any]) -> bool:
    event_type = str(event.get("type") or "")
    if not (event_type.startswith("message.assistant") or event_type == "message.error"):
        return False
    metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
    return is_automation_delivery_event(event, metadata)


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


def managed_flag() -> bool | None:
    value = os.environ.get("IRIS_CORE_MANAGED", "").strip().lower()
    if value in {"1", "true", "yes"}:
        return True
    if value in {"0", "false", "no"}:
        return False
    return None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Iris Core server.")
    parser.add_argument(
        "command",
        nargs="?",
        choices=("serve", "migrate-source-of-truth", "install-hermes-plugin", "service"),
        default="serve",
        help="Command to run. Defaults to serve.",
    )
    parser.add_argument(
        "service_action",
        nargs="?",
        choices=("install", "uninstall", "status"),
        help="Service action when command is service.",
    )
    parser.add_argument("--host", default=None, help="Bind host. Defaults to IRIS_CORE_HOST or 127.0.0.1.")
    parser.add_argument("--port", type=int, default=None, help="Bind port. Defaults to IRIS_CORE_PORT or 8765.")
    parser.add_argument(
        "--inbound-port",
        type=int,
        default=None,
        help="Hermes plugin inbound listener port for install-hermes-plugin. Defaults to IRIS_INBOUND_PORT or 8766.",
    )
    parser.add_argument("--hermes-home", default=None, help="Hermes home path. Defaults to HERMES_HOME or ~/.hermes.")
    parser.add_argument("--backup", action="store_true", help="Create a migration backup before dropping duplicate tables.")
    parser.add_argument("--replace", action="store_true", help="Replace an existing Iris Core service definition.")
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
    if args.command == "install-hermes-plugin":
        inbound_port = (
            args.inbound_port
            if args.inbound_port is not None
            else parse_port(os.environ.get("IRIS_INBOUND_PORT"), DEFAULT_IRIS_INBOUND_PORT)
        )
        if inbound_port < 1 or inbound_port > 65535:
            raise SystemExit(f"Inbound port must be between 1 and 65535: {inbound_port}")
        install_hermes_plugin(
            settings.hermes_home or str(normalize_hermes_home(None)),
            host=settings.host,
            port=settings.port,
            token=settings.token or "",
            inbound_port=inbound_port,
        )
        return
    if args.command == "service":
        action = args.service_action or "status"
        if action == "install":
            service_install(settings, replace=bool(args.replace))
        elif action == "uninstall":
            service_uninstall()
        else:
            service_status()
        return
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port)


def import_app_core_store_path() -> str:
    return str(Path(tempfile.gettempdir()) / "iris-core-import.sqlite3")


app = create_app(Settings(core_store_path=import_app_core_store_path()))


if __name__ == "__main__":
    cli()
