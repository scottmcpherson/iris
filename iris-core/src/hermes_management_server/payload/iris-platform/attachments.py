"""Inbound attachment helpers for the Iris Hermes platform adapter."""

from __future__ import annotations

import json
import mimetypes
from typing import Any

from gateway.platforms.base import (
    MessageType,
    cache_audio_from_bytes,
    cache_document_from_bytes,
    cache_image_from_bytes,
    cache_video_from_bytes,
)

try:
    from adapter_config import safe_text
except ImportError:
    from .adapter_config import safe_text


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
            name = safe_text(name or uploaded_file.get("filename"), field or "attachment", 180)
            mime_type = normalize_inbound_mime_type(
                kind,
                str(uploaded_file.get("mimeType") or mime_type).strip().lower(),
                name,
            )
            kind = kind or mime_type.split("/", 1)[0]
            path = cache_inbound_attachment(file_bytes, name, kind, mime_type)
        else:
            path = str(item.get("path") or item.get("url") or item.get("mediaUrl") or "").strip()
        if not path:
            continue
        attachments.append({
            "path": path,
            "name": name,
            "kind": kind or mime_type.split("/", 1)[0],
            "mimeType": mime_type,
        })
    return attachments


def cache_inbound_attachment(file_bytes: bytes, name: str, kind: str, mime_type: str) -> str:
    extension = attachment_extension(name, mime_type, kind)
    if kind == "audio" or mime_type.startswith("audio/"):
        return cache_audio_from_bytes(file_bytes, extension=extension)
    if kind == "image" or mime_type.startswith("image/"):
        return cache_image_from_bytes(file_bytes, extension=extension)
    if kind == "video" or mime_type.startswith("video/"):
        return cache_video_from_bytes(file_bytes, extension=extension)
    return cache_document_from_bytes(file_bytes, extension=extension)


def attachment_extension(name: str, mime_type: str, kind: str) -> str:
    suffix = ""
    if "." in name:
        suffix = name.rsplit(".", 1)[-1].strip().lower()
    if suffix:
        return suffix if suffix.startswith(".") else f".{suffix}"
    guessed = mimetypes.guess_extension(mime_type or "")
    if guessed:
        return guessed
    if kind == "audio":
        return ".wav"
    if kind == "image":
        return ".png"
    if kind == "video":
        return ".mp4"
    return ".bin"


def normalize_inbound_mime_type(kind: str, mime_type: str, name: str) -> str:
    normalized = mime_type.split(";", 1)[0].strip().lower()
    if kind == "audio" and (not normalized or normalized == "video/webm"):
        return "audio/webm"
    if normalized:
        return normalized
    guessed = mimetypes.guess_type(name or "")[0]
    if guessed:
        return guessed
    return mime_type_for_kind(kind)


def mime_type_for_kind(kind: str) -> str:
    if kind == "audio":
        return "audio/wav"
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
