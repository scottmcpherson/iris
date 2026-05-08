"""FastAPI application and CLI entrypoint."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import mimetypes
import os
import re
import secrets
import time
import urllib.parse
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, File, Form, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.responses import StreamingResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .core_store import (
    DEFAULT_RUNTIME_ID,
    CoreStore,
    attachment_size_limit_label,
    chat_id_for_conversation,
    clamp_int,
    client_attachment_payload,
    draft_conversation,
    max_attachment_size_bytes,
    normalize_attachment_kind,
    normalize_attachment_mime_type,
    now,
    random_id,
    runtime_attachment_payload,
    stable_hash,
)
from .models import (
    AgentCreateRequest,
    AgentMemoryResetRequest,
    AgentMemorySaveRequest,
    AgentRenameRequest,
    AgentSkillSaveRequest,
    CoreAutomationCreateRequest,
    CoreAutomationUpdateRequest,
    CoreConversationCreateRequest,
    DeviceCursorUpdateRequest,
    DevicePairRequest,
    CoreMessageCreateRequest,
    ErrorResponse,
    HealthResponse,
    InboxHealthResponse,
    InboxMessageCreateRequest,
    InboxMessageResponse,
    InboxMessagesResponse,
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


class LiveDeliveryBus:
    def __init__(self, *, max_events: int = 500, ttl_seconds: int = 900) -> None:
        self.max_events = max_events
        self.ttl_seconds = ttl_seconds
        self._events: deque[dict[str, Any]] = deque(maxlen=max_events)
        self._cursor = 0

    def publish(self, event: dict[str, Any]) -> dict[str, Any]:
        event_id = str(event.get("id") or "")
        if event_id:
            existing = next((row for row in self._events if row["id"] == event_id), None)
            if existing:
                return existing
        self._cursor += 1
        payload = {
            "cursor": self._cursor,
            "id": event_id or random_id("evt"),
            "conversationId": str(event.get("conversationId") or ""),
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
        conversation_id: str = "",
        agent_id: str = "",
    ) -> list[dict[str, Any]]:
        self.prune()
        rows = [
            event
            for event in self._events
            if event["cursor"] > after
            and (not conversation_id or event["conversationId"] == conversation_id)
            and (not agent_id or event["agentId"] == agent_id)
        ]
        return rows[:limit]

    def latest_cursor(self, *, conversation_id: str = "", agent_id: str = "") -> int:
        self.prune()
        for event in reversed(self._events):
            if conversation_id and event["conversationId"] != conversation_id:
                continue
            if agent_id and event["agentId"] != agent_id:
                continue
            return int(event["cursor"])
        return self._cursor

    def prune(self) -> None:
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


def safe_attachment_name(value: str) -> str:
    name = Path(value or "attachment").name.strip()
    return name or "attachment"


def attachment_mime_type(*, filename: str, content_type: str, head: bytes) -> str:
    lower_head = head[:512].lstrip().lower()
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"GIF87a") or head.startswith(b"GIF89a"):
        return "image/gif"
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head.startswith(b"RIFF") and len(head) >= 12 and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"RIFF") and len(head) >= 12 and head[8:12] == b"WAVE":
        return "audio/wav"
    if head.startswith(b"fLaC"):
        return "audio/flac"
    if head.startswith(b"ID3"):
        return "audio/mpeg"
    if head.startswith(b"\x1f\x8b"):
        return "application/gzip"
    if head.startswith(b"PK\x03\x04") or head.startswith(b"PK\x05\x06") or head.startswith(b"PK\x07\x08"):
        return office_or_zip_mime_type(filename)
    if head.startswith(b"7z\xbc\xaf\x27\x1c"):
        return "application/x-7z-compressed"
    if head.startswith(b"Rar!\x1a\x07"):
        return "application/vnd.rar"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        major_brand = head[8:12]
        if major_brand in {b"qt  "}:
            return "video/quicktime"
        if major_brand in {b"heic", b"heix", b"hevc", b"hevx"}:
            return "image/heic"
        if major_brand in {b"heif", b"mif1"}:
            return "image/heif"
        if major_brand in {b"avif", b"avis"}:
            return "image/avif"
        return "video/mp4"
    if lower_head.startswith(b"<svg") or (lower_head.startswith(b"<?xml") and b"<svg" in lower_head):
        return "image/svg+xml"
    guessed = mimetypes.guess_type(filename)[0] or ""
    return normalize_attachment_mime_type(guessed or content_type or "application/octet-stream")


def office_or_zip_mime_type(filename: str) -> str:
    extension = Path(filename).suffix.lower().lstrip(".")
    return {
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "epub": "application/epub+zip",
    }.get(extension, "application/zip")


def attachment_kind(mime_type: str, filename: str = "", hint: str = "") -> str:
    extension = Path(filename).suffix.lower().lstrip(".")
    extension_kinds = {
        "pdf": "document",
        "doc": "document",
        "docx": "document",
        "xls": "document",
        "xlsx": "document",
        "ppt": "document",
        "pptx": "document",
        "odt": "document",
        "ods": "document",
        "odp": "document",
        "rtf": "document",
        "csv": "document",
        "epub": "document",
        "html": "document",
        "htm": "document",
        "json": "document",
        "xml": "document",
        "md": "code",
        "markdown": "code",
        "yaml": "code",
        "yml": "code",
        "toml": "code",
        "js": "code",
        "jsx": "code",
        "ts": "code",
        "tsx": "code",
        "py": "code",
        "rb": "code",
        "go": "code",
        "rs": "code",
        "mp3": "audio",
        "wav": "audio",
        "m4a": "audio",
        "aac": "audio",
        "ogg": "audio",
        "flac": "audio",
        "mp4": "video",
        "mov": "video",
        "webm": "video",
        "zip": "archive",
        "tar": "archive",
        "gz": "archive",
        "tgz": "archive",
        "7z": "archive",
        "rar": "archive",
    }
    return normalize_attachment_kind(hint or extension_kinds.get(extension, ""), mime_type)


def parse_attachment_metadata(value: str) -> dict[str, Any]:
    if not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ManagementError(f"Attachment metadata must be valid JSON: {exc}", status_code=400) from exc
    if not isinstance(parsed, dict):
        raise ManagementError("Attachment metadata must be a JSON object.", status_code=400)
    return parsed


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
    runtime = item.get("runtime") if isinstance(item.get("runtime"), dict) else {}
    if not path_value and str(runtime.get("type") or "") == "local_path":
        path_value = str(runtime.get("path") or "").strip()
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
    conversation_id: str,
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
                conversation_id=conversation_id,
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


def merge_client_attachments(existing: Any, additions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in list(existing if isinstance(existing, list) else []) + additions:
        if not isinstance(item, dict):
            continue
        key = str(item.get("id") or item.get("sha256") or item.get("downloadUrl") or "")
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        merged.append(item)
    return merged


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
    if not metadata.get("attachments"):
        return
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
                metadata=metadata,
            )


def import_generated_file_history_attachments(
    app: FastAPI,
    *,
    conversation: dict[str, Any],
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    chat_id = str(conversation.get("externalChatId") or "")
    runtime_id = str(conversation.get("runtimeId") or DEFAULT_RUNTIME_ID)
    profile = str(conversation.get("runtimeProfile") or "default")
    conversation_id = str(conversation.get("id") or "")
    if not chat_id or not runtime_id or not profile or not conversation_id:
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
            conversation_id=conversation_id,
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
    app.state.active_conversations = {}
    app.state.active_conversations_by_chat = {}
    app.state.accepted_client_messages = set()
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
    async def unexpected_error_handler(_request, _exc: Exception) -> JSONResponse:
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

    @app.post("/v1/attachments")
    async def core_create_attachment(
        request: Request,
        file: UploadFile = File(...),
        conversationId: str = Form(""),
        messageId: str = Form(""),
        runtimeId: str = Form(DEFAULT_RUNTIME_ID),
        profile: str = Form("default"),
        kind: str = Form(""),
        metadata: str = Form(""),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        filename = safe_attachment_name(file.filename or "attachment")
        metadata_payload = parse_attachment_metadata(metadata)
        temp_path = core_store.tmp_attachment_path()
        hasher = hashlib.sha256()
        size = 0
        head = b""
        try:
            with temp_path.open("wb") as handle:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    if not head:
                        head = chunk[:512]
                    size += len(chunk)
                    if size > max_attachment_size_bytes():
                        raise ManagementError(
                            f"Attachment exceeds the {attachment_size_limit_label()} limit.",
                            status_code=413,
                        )
                    hasher.update(chunk)
                    handle.write(chunk)
            if size <= 0:
                raise ManagementError("Attachment file is empty.", status_code=400)
            mime_type = attachment_mime_type(
                filename=filename,
                content_type=file.content_type or "",
                head=head,
            )
            try:
                attachment = core_store.create_attachment(
                    source_path=temp_path,
                    runtime_id=runtimeId or DEFAULT_RUNTIME_ID,
                    profile=profile or "default",
                    conversation_id=conversationId,
                    message_id=messageId,
                    owner_device_id=str(getattr(getattr(request, "state", None), "agentui_device", {}).get("id", "")),
                    name=filename,
                    mime_type=mime_type,
                    kind=attachment_kind(mime_type, filename, kind),
                    size_bytes=size,
                    sha256=hasher.hexdigest(),
                    metadata=metadata_payload,
                )
            except ValueError as exc:
                raise ManagementError(str(exc), status_code=400) from exc
        finally:
            temp_path.unlink(missing_ok=True)
            await file.close()
        return {"ok": True, "attachment": client_attachment_payload(attachment)}

    @app.get("/v1/attachments/{attachment_id}/content")
    async def core_attachment_content(attachment_id: str, _auth: None = Depends(require_auth)) -> FileResponse:
        attachment = core_store.get_attachment(attachment_id, include_storage=True)
        if not attachment:
            raise ManagementError("Attachment was not found.", status_code=404)
        try:
            path = core_store.attachment_content_path(attachment_id)
        except ValueError as exc:
            raise ManagementError(str(exc), status_code=404) from exc
        return FileResponse(
            path,
            media_type=str(attachment.get("mimeType") or "application/octet-stream"),
            filename=str(attachment.get("name") or "attachment"),
            headers={"ETag": f"\"{attachment.get('sha256') or ''}\""},
        )

    @app.get("/v1/attachments/{attachment_id}/preview")
    async def core_attachment_preview(attachment_id: str, _auth: None = Depends(require_auth)) -> Response:
        attachment = core_store.get_attachment(attachment_id, include_storage=True)
        if not attachment:
            raise ManagementError("Attachment was not found.", status_code=404)
        if not str(attachment.get("mimeType") or "").startswith("image/"):
            return JSONResponse(
                status_code=415,
                content={"ok": False, "error": "Preview is only available for image attachments."},
            )
        try:
            path = core_store.attachment_content_path(attachment_id)
        except ValueError as exc:
            raise ManagementError(str(exc), status_code=404) from exc
        return FileResponse(
            path,
            media_type=str(attachment.get("mimeType") or "application/octet-stream"),
            headers={
                "Content-Disposition": f"inline; filename=\"{safe_attachment_name(str(attachment.get('name') or 'preview'))}\"",
                "ETag": f"\"{attachment.get('sha256') or ''}\"",
            },
        )

    @app.post("/v1/runtime/attachments/resolve")
    async def core_runtime_attachments_resolve(
        request: Request,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise ManagementError("Request body must be a JSON object.", status_code=400)
        runtime_id = str(payload.get("runtimeId") or DEFAULT_RUNTIME_ID)
        profile = str(payload.get("profile") or "default")
        refs = payload.get("attachments") if isinstance(payload.get("attachments"), list) else []
        attachments = [
            runtime_attachment_payload(attachment)
            for attachment in core_store.runtime_attachments(runtime_id=runtime_id, profile=profile, refs=refs)
        ]
        return {"ok": True, "attachments": attachments}

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
        probe = await asyncio.to_thread(app.state.runtime_registry.probe, runtime_id, profile=profile)
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
        agent = await asyncio.to_thread(adapter.create_agent, request.name, request.metadata)
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
        cloned = await asyncio.to_thread(adapter.clone_agent, agent, request.name)
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
        renamed = await asyncio.to_thread(adapter.rename_agent, agent, request.name)
        return {"ok": True, "agent": renamed}

    @app.delete("/v1/agents/{agent_id}")
    async def core_delete_agent(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        next_agent = await asyncio.to_thread(adapter.delete_agent, agent)
        return {"ok": True, "agent": next_agent}

    @app.post("/v1/agents/{agent_id}/activate")
    async def core_activate_agent(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        activated = await asyncio.to_thread(adapter.activate_agent, agent)
        return {"ok": True, "agent": activated}

    @app.get("/v1/agents/{agent_id}/memory")
    async def core_agent_memory(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return await asyncio.to_thread(adapter.agent_memory, agent)

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
        memory = await asyncio.to_thread(
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
        memory = await asyncio.to_thread(adapter.reset_agent_memory, agent, file)
        return {"ok": True, "profile": memory["profile"], "memory": memory}

    @app.get("/v1/agents/{agent_id}/skills")
    async def core_agent_skills(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return await asyncio.to_thread(adapter.list_agent_skills, agent)

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
        return await asyncio.to_thread(adapter.get_agent_skill, agent, skill_id)

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
        return await asyncio.to_thread(adapter.create_agent_skill, agent, dump_model(request))

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
        return await asyncio.to_thread(adapter.save_agent_skill, agent, skill_id, dump_model(request))

    @app.get("/v1/conversations")
    async def core_conversations(
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
        conversations: list[dict[str, Any]] = []
        for item in [row for row in agents if row]:
            adapter = app.state.runtime_registry.adapter_for_runtime(item["runtimeId"])
            conversations.extend(await asyncio.to_thread(adapter.list_conversations, item, limit))
        conversations.sort(key=lambda row: int(row.get("updatedAt") or 0), reverse=True)
        return {
            "ok": True,
            "conversations": conversations[:limit],
        }

    @app.post("/v1/conversations")
    async def core_create_conversation(
        request: CoreConversationCreateRequest,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(request.agentId)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        external_chat_id = (request.externalChatId or "").strip() or f"core-{secrets.token_urlsafe(18)}"
        external_session_id = (request.externalSessionId or "").strip()
        conversation = draft_conversation(
            agent,
            title=request.title,
            external_chat_id=external_chat_id,
            external_session_id=external_session_id,
            metadata=request.metadata,
        )
        remember_active_conversation(app, conversation)
        return {"ok": True, "conversation": conversation}

    @app.get("/v1/conversations/{conversation_id}")
    async def core_conversation_detail(
        conversation_id: str,
        externalSessionId: str | None = Query(None),
        externalChatId: str | None = Query(None),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        conversation = resolve_core_conversation(
            app,
            conversation_id,
            external_session_id=externalSessionId or "",
            external_chat_id=externalChatId or "",
        )
        if not conversation:
            raise ManagementError("Conversation was not found.", status_code=404)
        return {"ok": True, "conversation": conversation}

    @app.get("/v1/conversations/{conversation_id}/messages")
    async def core_conversation_messages(
        conversation_id: str,
        externalSessionId: str | None = Query(None),
        externalChatId: str | None = Query(None),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        conversation = resolve_core_conversation(
            app,
            conversation_id,
            external_session_id=externalSessionId or "",
            external_chat_id=externalChatId or "",
        )
        if not conversation:
            raise ManagementError("Conversation was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(conversation["runtimeId"])
        try:
            messages, warning = await asyncio.to_thread(
                adapter.get_conversation_messages,
                conversation_agent(app, conversation),
                conversation.get("externalSessionId") or "",
                chat_id=conversation.get("externalChatId") or "",
                conversation_id=conversation_id,
            )
        except ManagementError as exc:
            return {"ok": True, "conversationId": conversation_id, "messages": [], "warning": exc.error}
        messages = import_generated_file_history_attachments(
            app,
            conversation=conversation,
            messages=messages,
        )
        return {"ok": True, "conversationId": conversation_id, "messages": messages, "source": "hermes-management", "warning": warning}

    @app.post("/v1/conversations/{conversation_id}/messages")
    async def core_send_message(
        conversation_id: str,
        request: CoreMessageCreateRequest,
        http_request: Request,
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        conversation = resolve_core_conversation(app, conversation_id)
        if not conversation:
            raise ManagementError("Conversation was not found.", status_code=404)
        agent = app.state.runtime_registry.agent(conversation["agentId"])
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        text = request.text.strip()
        attachment_refs = normalize_attachment_refs(request.attachments)
        if not text and not attachment_refs:
            raise ManagementError("Message text is required.", status_code=400)
        message_id = request.clientMessageId or random_id("msg")
        idempotency_key = http_request.headers.get("Idempotency-Key") or request.clientMessageId
        accepted_key = (conversation_id, message_id)
        if accepted_key in app.state.accepted_client_messages:
            return {
                "ok": True,
                "conversationId": conversation_id,
                "messageId": message_id,
                "accepted": True,
                "eventCursor": app.state.live_delivery_bus.latest_cursor(agent_id=agent["id"]),
                "duplicate": True,
            }
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        chat_id = conversation["externalChatId"] or chat_id_for_conversation(conversation_id)
        if not conversation["externalChatId"]:
            conversation = {**conversation, "externalChatId": chat_id}
            remember_active_conversation(app, conversation)
        try:
            resolved_attachments = app.state.core_store.resolve_message_attachments(
                runtime_id=agent["runtimeId"],
                profile=agent["runtimeProfile"],
                conversation_id=conversation_id,
                chat_id=chat_id,
                message_id=message_id,
                refs=attachment_refs,
            )
        except ValueError as exc:
            raise ManagementError(str(exc), status_code=400) from exc
        client_attachments = [client_attachment_payload(attachment) for attachment in resolved_attachments]
        runtime_attachments = [runtime_attachment_payload(attachment) for attachment in resolved_attachments]
        runtime_metadata = {
            key: value
            for key, value in request.metadata.items()
            if key not in {"modelSwitch", "chatId"}
        }
        if runtime_attachments:
            runtime_metadata["attachments"] = runtime_attachments
        runtime_metadata.update({
                    "agentuiConversationId": conversation_id,
                    "chatId": chat_id,
                    "profile": agent["runtimeProfile"],
                    "idempotencyKey": idempotency_key,
                })
        switch_command = model_switch_command(request.metadata.get("modelSwitch"))
        if switch_command:
            switch_result = await asyncio.to_thread(
                adapter.send_message,
                profile=agent["runtimeProfile"],
                chat_id=chat_id,
                chat_name=conversation["title"],
                message_id=f"{message_id}-model",
                text=switch_command,
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
                    conversation_id=conversation_id,
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
                    "conversationId": conversation_id,
                    "messageId": message_id,
                    "accepted": False,
                    "eventCursor": error_event["cursor"],
                    "error": switch_result.get("error") or "Hermes gateway did not accept the model switch.",
                }
        result = await asyncio.to_thread(
            adapter.send_message,
            profile=agent["runtimeProfile"],
            chat_id=chat_id,
            chat_name=conversation["title"],
            message_id=message_id,
            text=text,
            metadata=runtime_metadata,
        )
        if not result.get("ok"):
            error_event = publish_core_event(
                app,
                conversation_id=conversation_id,
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
                "conversationId": conversation_id,
                "messageId": message_id,
                "accepted": False,
                "eventCursor": error_event["cursor"],
                "error": result.get("error") or "Hermes gateway did not accept the message.",
            }
        accepted_chat_id = str(result.get("chatId") or chat_id)
        if accepted_chat_id != conversation.get("externalChatId"):
            conversation = {**conversation, "externalChatId": accepted_chat_id}
            remember_active_conversation(app, conversation)
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
                **({"attachments": client_attachments} if client_attachments else {}),
            },
        )
        app.state.accepted_client_messages.add(accepted_key)
        return {
            "ok": True,
            "conversationId": conversation_id,
            "messageId": message_id,
            "accepted": True,
            "eventCursor": app.state.live_delivery_bus.latest_cursor(agent_id=agent["id"]),
            "runtime": result,
        }

    @app.post("/v1/conversations/{conversation_id}/cancel")
    async def core_cancel_message(conversation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        conversation = resolve_core_conversation(app, conversation_id)
        if not conversation:
            raise ManagementError("Conversation was not found.", status_code=404)
        agent = app.state.runtime_registry.agent(conversation["agentId"])
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        result = await asyncio.to_thread(
            adapter.send_message,
            profile=agent["runtimeProfile"],
            chat_id=conversation["externalChatId"] or chat_id_for_conversation(conversation_id),
            chat_name=conversation["title"],
            message_id=random_id("msg"),
            text="/stop",
            metadata={"kind": "cancel", "agentuiConversationId": conversation_id},
        )
        return {"ok": bool(result.get("ok")), "conversationId": conversation_id, "runtime": result}

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

    @app.get("/v1/conversations/{conversation_id}/events")
    async def core_conversation_events(
        conversation_id: str,
        after: int = Query(0),
        limit: int = Query(200),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        if not resolve_core_conversation(app, conversation_id):
            raise ManagementError("Conversation was not found.", status_code=404)
        after = clamp_int(after, default=0, minimum=0, maximum=9_223_372_036_854_775_807)
        limit = clamp_int(limit, default=200, minimum=1, maximum=500)
        events = app.state.live_delivery_bus.list_events(after=after, limit=limit, conversation_id=conversation_id)
        return {
            "ok": True,
            "events": events,
            "cursor": events[-1]["cursor"] if events else app.state.live_delivery_bus.latest_cursor(conversation_id=conversation_id),
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
        conversation = resolve_core_conversation(
            app,
            "",
            runtime_id=delivery.runtimeId,
            runtime_profile=delivery.profile,
            external_chat_id=delivery.chatId,
        )
        if not conversation:
            conversation = draft_conversation(
                agent,
                title=f"{delivery.profile} delivery",
                external_chat_id=delivery.chatId,
                metadata={"createdBy": "runtime-delivery"},
            )
            remember_active_conversation(app, conversation)
        conversation_id = conversation["id"]
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
            conversation_id=conversation_id,
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
            conversation_id=conversation_id,
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
            "conversationId": conversation_id,
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
        automations = await asyncio.to_thread(list_runtime_automations, app, agentId)
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
        result = await asyncio.to_thread(adapter.create_automation, payload)
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
        updates = {key: value for key, value in dump_model(request).items() if value not in (None, "", {})}
        result: dict[str, Any] = {"ok": True}
        if automation["externalJobId"]:
            adapter = app.state.runtime_registry.adapter_for_runtime(automation["runtimeId"])
            result = await asyncio.to_thread(
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
            result = await asyncio.to_thread(adapter.delete_automation, automation["externalJobId"])
            if not result.get("ok") and "not found" not in str(result.get("error") or "").lower():
                return {"ok": False, "error": result.get("error") or "Could not delete Hermes job.", "runtime": result}
        return {"ok": True, "automationId": automation_id, "runtime": result}

    @app.post("/v1/automations/{automation_id}/pause")
    async def core_pause_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return await asyncio.to_thread(control_core_automation, app, automation_id, "pause", "paused")

    @app.post("/v1/automations/{automation_id}/resume")
    async def core_resume_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return await asyncio.to_thread(control_core_automation, app, automation_id, "resume", "active")

    @app.post("/v1/automations/{automation_id}/run")
    async def core_run_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        return await asyncio.to_thread(control_core_automation, app, automation_id, "run", None)

    @app.get("/v1/agents/{agent_id}/models")
    async def core_agent_models(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return await asyncio.to_thread(adapter.models, agent["runtimeProfile"])

    @app.get("/v1/agents/{agent_id}/slash-commands")
    async def core_agent_slash_commands(agent_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
        agent = app.state.runtime_registry.agent(agent_id)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        return await asyncio.to_thread(adapter.slash_commands, agent["runtimeProfile"])

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
        return await asyncio.to_thread(
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
    conversation = resolve_core_conversation(
        app,
        "",
        runtime_id=runtime_id,
        runtime_profile=profile,
        external_chat_id=chat_id,
    )
    if not conversation:
        conversation = draft_conversation(
            agent,
            title=f"{profile} delivery",
            external_chat_id=chat_id,
            metadata={"createdBy": "legacy-inbox-delivery"},
        )
        remember_active_conversation(app, conversation)
    conversation_id = conversation["id"]
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
        conversation_id=conversation_id,
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
        conversation_id=conversation_id,
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
        "chatId": str(metadata.get("chatId") or event.get("conversationId") or "agentui"),
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


def remember_active_conversation(app: FastAPI, conversation: dict[str, Any]) -> None:
    app.state.active_conversations[conversation["id"]] = conversation
    chat_id = str(conversation.get("externalChatId") or "")
    if chat_id:
        app.state.active_conversations_by_chat[
            (conversation["runtimeId"], conversation["runtimeProfile"], chat_id)
        ] = conversation["id"]


def agent_for_runtime_profile(app: FastAPI, runtime_id: str, profile: str) -> dict[str, Any] | None:
    return next(
        (
            agent
            for agent in app.state.runtime_registry.agents()
            if agent["runtimeId"] == runtime_id and agent["runtimeProfile"] == profile
        ),
        None,
    )


def conversation_agent(app: FastAPI, conversation: dict[str, Any]) -> dict[str, Any]:
    agent = app.state.runtime_registry.agent(str(conversation.get("agentId") or ""))
    if not agent:
        raise ManagementError("Conversation agent was not found.", status_code=404)
    return agent


def resolve_core_conversation(
    app: FastAPI,
    conversation_id: str,
    *,
    runtime_id: str = "",
    runtime_profile: str = "",
    external_session_id: str = "",
    external_chat_id: str = "",
) -> dict[str, Any] | None:
    active = app.state.active_conversations.get(conversation_id) if conversation_id else None
    if active:
        return active
    if external_chat_id:
        mapped_id = app.state.active_conversations_by_chat.get(
            (runtime_id or DEFAULT_RUNTIME_ID, runtime_profile or "default", external_chat_id)
        )
        if mapped_id and mapped_id in app.state.active_conversations:
            return app.state.active_conversations[mapped_id]

    agents = app.state.runtime_registry.agents()
    for agent in agents:
        if runtime_id and agent["runtimeId"] != runtime_id:
            continue
        if runtime_profile and agent["runtimeProfile"] != runtime_profile:
            continue
        adapter = app.state.runtime_registry.adapter_for_runtime(agent["runtimeId"])
        conversation = adapter.get_conversation(
            agent,
            external_session_id,
            chat_id=external_chat_id,
            conversation_id=conversation_id,
        )
        if conversation:
            return conversation
    return None


def publish_core_event(
    app: FastAPI,
    *,
    conversation_id: str,
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
    return app.state.live_delivery_bus.publish(
        {
            "id": event_id,
            "conversationId": conversation_id,
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
        "deliverToConversationId": str(request_payload.get("deliverToConversationId") or ""),
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
    conversation_id = str(request.get("deliverToConversationId") or "").strip()
    if conversation_id:
        conversation = resolve_core_conversation(app, conversation_id)
        if not conversation or conversation["agentId"] != agent["id"]:
            raise ManagementError("Delivery conversation was not found for this agent.", status_code=404)
        deliver = deliver or f"agentui:{conversation['externalChatId'] or chat_id_for_conversation(conversation_id)}"
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


def prepare_assistant_delivery_event(
    messages: list[dict[str, Any]],
    *,
    content: str,
    metadata: dict[str, Any],
    stream_message_id: str,
    has_stream_id: bool,
    reply_to: str,
    status: str,
) -> tuple[str, dict[str, Any], bool]:
    if has_stream_id:
        existing = message_by_id(messages, stream_message_id)
        if not existing:
            return content, metadata, False
        existing_content = str(existing.get("content") or "")
        existing_status = str(existing.get("status") or "")
        if existing_status == "completed" and status == "streaming":
            return existing_content, metadata, True
        if status == "streaming":
            merged = merged_stream_snapshot_content(existing_content, content)
            return merged, metadata, same_normalized_content(merged, existing_content)
        merged = merged_completed_stream_content(existing_content, content)
        merged_metadata = merged_completion_metadata(existing, metadata, reply_to=reply_to)
        if existing_status == "completed" and same_normalized_content(merged, existing_content):
            return existing_content, merged_metadata, True
        return merged, merged_metadata, False

    if status != "completed":
        return content, metadata, False

    fallback = stream_fallback_completion(messages, reply_to=reply_to, content=content)
    if fallback:
        return (
            str(fallback["content"]),
            finalized_stream_metadata(
                metadata,
                existing_metadata=fallback["metadata"],
                stream_message_id=str(fallback["streamMessageId"]),
                reply_to=reply_to or str(fallback.get("replyTo") or ""),
            ),
            False,
        )

    existing = last_mergeable_assistant_message(messages, reply_to=reply_to, content=content)
    if not existing:
        return content, metadata, False
    existing_content = str(existing.get("content") or "")
    merged = merged_completed_stream_content(existing_content, content)
    merged_metadata = merged_completion_metadata(existing, metadata, reply_to=reply_to)
    if str(existing.get("status") or "") == "completed" and same_normalized_content(merged, existing_content):
        return existing_content, merged_metadata, True
    return merged, merged_metadata, False


def has_stream_message_id(metadata: dict[str, Any]) -> bool:
    return bool(metadata.get("streamMessageId") or metadata.get("stream_message_id"))


def stream_fallback_completion(
    messages: list[dict[str, Any]],
    *,
    reply_to: str,
    content: str,
) -> dict[str, Any] | None:
    existing = None
    metadata: dict[str, Any] = {}
    for message in reversed(messages):
        if message.get("role") != "assistant" or message.get("status") != "streaming":
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        stream_message_id = str(metadata.get("streamMessageId") or metadata.get("stream_message_id") or "")
        if stream_message_id:
            existing = message
            break
    if not existing or not stream_message_id:
        return None
    inferred_reply_to = reply_to or str(metadata.get("replyTo") or "") or last_user_message_id(messages)
    return {
        "content": merged_completed_stream_content(str(existing.get("content") or ""), content),
        "messageId": str(existing.get("id") or stream_message_id),
        "metadata": metadata,
        "replyTo": inferred_reply_to,
        "streamMessageId": stream_message_id,
    }


def finalized_stream_metadata(
    metadata: dict[str, Any],
    *,
    existing_metadata: dict[str, Any],
    stream_message_id: str,
    reply_to: str,
) -> dict[str, Any]:
    merged = {**existing_metadata, **metadata}
    attachments = merged_metadata_attachments(existing_metadata, metadata)
    if attachments:
        merged["attachments"] = attachments
    merged["streamMessageId"] = stream_message_id
    merged["streaming"] = False
    merged["finalize"] = True
    if reply_to:
        merged["replyTo"] = reply_to
    return merged


def merged_completion_metadata(existing: dict[str, Any], metadata: dict[str, Any], *, reply_to: str) -> dict[str, Any]:
    existing_metadata = existing.get("metadata") if isinstance(existing.get("metadata"), dict) else {}
    stream_message_id = str(existing_metadata.get("streamMessageId") or existing_metadata.get("stream_message_id") or "")
    if not stream_message_id:
        merged = {**existing_metadata, **metadata}
        attachments = merged_metadata_attachments(existing_metadata, metadata)
        if attachments:
            merged["attachments"] = attachments
        return merged
    return finalized_stream_metadata(
        metadata,
        existing_metadata=existing_metadata,
        stream_message_id=stream_message_id,
        reply_to=reply_to or str(existing_metadata.get("replyTo") or ""),
    )


def merged_metadata_attachments(left: dict[str, Any], right: dict[str, Any]) -> list[dict[str, Any]]:
    return merge_client_attachments(left.get("attachments"), [
        item for item in right.get("attachments", []) if isinstance(item, dict)
    ] if isinstance(right.get("attachments"), list) else [])


def last_user_message_id(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return str(message.get("id") or "")
    return ""


def message_by_id(messages: list[dict[str, Any]], message_id: str) -> dict[str, Any] | None:
    for message in messages:
        if message["id"] == message_id:
            return message
    return None


def coalesce_core_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    coalesced: list[dict[str, Any]] = []
    for message in messages:
        if message["role"] == "assistant" and coalesced:
            previous = coalesced[-1]
            if (
                previous["role"] == "assistant"
                and equivalent_message_content(
                    str(previous.get("content") or ""),
                    str(message.get("content") or ""),
                )
                and is_gateway_replay_pair(previous, message)
            ):
                if message.get("status") == "completed" and previous.get("status") != "completed":
                    metadata = merged_completion_metadata(previous, message.get("metadata") if isinstance(message.get("metadata"), dict) else {}, reply_to="")
                    coalesced[-1] = {
                        **previous,
                        "status": "completed",
                        "updatedAt": message.get("updatedAt") or previous.get("updatedAt"),
                        "metadata": metadata,
                    }
                else:
                    metadata = merged_completion_metadata(previous, message.get("metadata") if isinstance(message.get("metadata"), dict) else {}, reply_to="")
                    if metadata.get("attachments"):
                        coalesced[-1] = {**previous, "metadata": metadata}
                continue
        coalesced.append(message)
    return coalesced


def is_gateway_replay_pair(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_metadata = left.get("metadata") if isinstance(left.get("metadata"), dict) else {}
    right_metadata = right.get("metadata") if isinstance(right.get("metadata"), dict) else {}
    left_source = str(left_metadata.get("source") or "")
    right_source = str(right_metadata.get("source") or "")
    if not left_source.startswith("hermes-gateway") or not right_source.startswith("hermes-gateway"):
        return False
    return bool(
        left_metadata.get("streamMessageId")
        or right_metadata.get("streamMessageId")
        or (
            left_metadata.get("replyTo")
            and left_metadata.get("replyTo") == right_metadata.get("replyTo")
        )
    )


def last_mergeable_assistant_message(
    messages: list[dict[str, Any]],
    *,
    reply_to: str,
    content: str,
) -> dict[str, Any] | None:
    normalized_content = normalize_message_content(content)
    reply_scope_exists = bool(reply_to and any(
        message.get("role") == "user" and str(message.get("id") or "") == reply_to
        for message in messages
    ))
    for message in reversed(messages):
        if message["role"] == "user":
            if reply_scope_exists and str(message.get("id") or "") == reply_to:
                continue
            break
        if message["role"] != "assistant":
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        reply_matches = bool(reply_to and metadata.get("replyTo") == reply_to)
        unscoped_stream_message = bool((not reply_to or not reply_scope_exists) and metadata.get("streamMessageId"))
        if message["status"] == "streaming":
            return message
        if (
            normalized_content
            and equivalent_message_content(str(message.get("content") or ""), normalized_content)
            and (reply_matches or unscoped_stream_message)
        ):
            return message
        if is_post_stream_attachment(content) and (reply_matches or unscoped_stream_message):
            return message
    return None


def normalize_message_content(content: str) -> str:
    return "\n".join(line.rstrip() for line in content.strip().splitlines())


def same_normalized_content(left: str, right: str) -> bool:
    return normalize_message_content(left) == normalize_message_content(right)


def equivalent_message_content(left: str, right: str) -> bool:
    return compact_message_content(left) == compact_message_content(right)


def compact_message_content(content: str) -> str:
    return re.sub(r"\s+([,.;:!?])", r"\1", " ".join(normalize_message_content(content).split()))


def is_post_stream_attachment(content: str) -> bool:
    stripped = content.strip()
    return bool(
        stripped.startswith("Media:")
        or stripped.startswith("Image:")
        or stripped.startswith("File:")
        or stripped.startswith("🖼️ Image:")
        or stripped.startswith("📎 File:")
    )


def append_message_content(content: str, addition: str) -> str:
    left = content.rstrip()
    right = addition.strip()
    if not left:
        return right
    if not right or right in left or equivalent_message_content(left, right):
        return left
    if re.match(r"^[,.;:!?)]", right):
        return f"{left}{right}"
    if not re.search(r"[.!?:;)]$", left) and re.match(r"^[a-z]", right):
        return f"{left} {right}"
    return f"{left}\n\n{right}"


def merged_completed_stream_content(existing: str, delivery: str) -> str:
    existing_content = existing.rstrip()
    delivery_content = delivery.strip()
    if not existing_content:
        return delivery_content
    if not delivery_content:
        return existing_content
    compact_existing = compact_message_content(existing_content)
    compact_delivery = compact_message_content(delivery_content)
    if compact_existing == compact_delivery:
        return delivery_content
    if compact_delivery.startswith(compact_existing):
        return delivery_content
    if compact_existing.startswith(compact_delivery) or compact_delivery in compact_existing:
        return existing_content
    overlapped = overlapping_message_content(existing_content, delivery_content)
    if overlapped:
        return overlapped
    return append_message_content(existing_content, delivery_content)


def merged_stream_snapshot_content(existing: str, delivery: str) -> str:
    existing_content = existing.rstrip()
    delivery_content = delivery.strip()
    if not existing_content:
        return delivery_content
    if not delivery_content:
        return existing_content
    compact_existing = compact_message_content(existing_content)
    compact_delivery = compact_message_content(delivery_content)
    if compact_delivery.startswith(compact_existing):
        return delivery_content
    if compact_existing.startswith(compact_delivery):
        return existing_content
    return delivery_content if len(compact_delivery) >= len(compact_existing) else existing_content


def overlapping_message_content(existing: str, delivery: str) -> str:
    max_overlap = min(len(existing), len(delivery))
    for length in range(max_overlap, 11, -1):
        prefix = delivery[:length]
        index = existing.rfind(prefix)
        if index != -1:
            return f"{existing[:index]}{delivery}"
    return ""


def dump_model(model):
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Hermes management sidecar server.")
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
