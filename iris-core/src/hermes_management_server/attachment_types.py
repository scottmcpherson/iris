"""Attachment MIME and kind normalization shared by Iris Core."""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any


ATTACHMENT_KINDS = {"image", "document", "audio", "video", "archive", "code", "file"}
DOCUMENT_ATTACHMENT_MIME_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "application/rtf",
    "application/json",
    "application/xml",
    "application/epub+zip",
    "text/csv",
    "text/html",
}
CODE_ATTACHMENT_MIME_TYPES = {
    "application/javascript",
    "application/typescript",
    "application/toml",
    "application/x-yaml",
    "application/yaml",
    "text/markdown",
}
ARCHIVE_ATTACHMENT_MIME_TYPES = {
    "application/zip",
    "application/x-tar",
    "application/gzip",
    "application/x-gzip",
    "application/x-7z-compressed",
    "application/vnd.rar",
    "application/x-rar-compressed",
}

EXTENSION_ATTACHMENT_KINDS = {
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
    "txt": "code",
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
    "java": "code",
    "c": "code",
    "h": "code",
    "cpp": "code",
    "cc": "code",
    "css": "code",
    "sh": "code",
    "mp3": "audio",
    "wav": "audio",
    "m4a": "audio",
    "aac": "audio",
    "ogg": "audio",
    "flac": "audio",
    "mp4": "video",
    "mov": "video",
    "m4v": "video",
    "webm": "video",
    "mpg": "video",
    "mpeg": "video",
    "avi": "video",
    "zip": "archive",
    "tar": "archive",
    "gz": "archive",
    "tgz": "archive",
    "7z": "archive",
    "rar": "archive",
}


def normalize_attachment_mime_type(value: str) -> str:
    mime_type = str(value or "").split(";", 1)[0].strip().lower()
    if mime_type == "image/jpg":
        return "image/jpeg"
    if mime_type in {"application/x-m4a", "audio/x-m4a", "audio/m4a"}:
        return "video/mp4"
    return mime_type or "application/octet-stream"


def is_allowed_attachment_mime(mime_type: str) -> bool:
    normalized = normalize_attachment_mime_type(mime_type)
    if normalized == "application/octet-stream":
        return True
    if normalized.startswith(("image/", "audio/", "video/", "text/")):
        return True
    return normalized in (
        DOCUMENT_ATTACHMENT_MIME_TYPES
        | CODE_ATTACHMENT_MIME_TYPES
        | ARCHIVE_ATTACHMENT_MIME_TYPES
    )


def normalize_attachment_kind(kind: str, mime_type: str, filename: str = "") -> str:
    value = str(kind or "").strip().lower()
    if value in ATTACHMENT_KINDS:
        return value
    normalized_mime = normalize_attachment_mime_type(mime_type)
    if normalized_mime.startswith("image/"):
        return "image"
    if normalized_mime.startswith("audio/"):
        return "audio"
    if normalized_mime.startswith("video/"):
        return "video"
    if normalized_mime.startswith("text/") or normalized_mime in CODE_ATTACHMENT_MIME_TYPES:
        return "code"
    if normalized_mime in DOCUMENT_ATTACHMENT_MIME_TYPES:
        return "document"
    if normalized_mime in ARCHIVE_ATTACHMENT_MIME_TYPES:
        return "archive"
    extension_kind = EXTENSION_ATTACHMENT_KINDS.get(file_extension(filename))
    return extension_kind or "file"


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
    normalized_content_type = normalize_attachment_mime_type(content_type or "")
    if normalized_content_type and normalized_content_type != "application/octet-stream":
        return normalized_content_type
    guessed = mimetypes.guess_type(filename)[0] or ""
    return normalize_attachment_mime_type(guessed or normalized_content_type or "application/octet-stream")


def office_or_zip_mime_type(filename: str) -> str:
    return {
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "epub": "application/epub+zip",
    }.get(file_extension(filename), "application/zip")


def attachment_kind(mime_type: str, filename: str = "", hint: str = "") -> str:
    return normalize_attachment_kind(
        hint or EXTENSION_ATTACHMENT_KINDS.get(file_extension(filename), ""),
        mime_type,
        filename,
    )


def normalized_runtime_mime_type(attachment: dict[str, Any]) -> str:
    mime_type = normalize_attachment_mime_type(str(attachment.get("mimeType") or ""))
    kind = str(attachment.get("kind") or "").strip().lower()
    name = str(attachment.get("name") or "")
    if kind == "audio" and (mime_type == "application/octet-stream" or mime_type == "video/webm"):
        return "audio/webm"
    if mime_type != "application/octet-stream":
        return mime_type
    guessed = mimetypes.guess_type(name)[0]
    if guessed:
        return normalize_attachment_mime_type(guessed)
    if kind == "audio":
        return "audio/webm"
    if kind == "image":
        return "image/png"
    if kind == "video":
        return "video/mp4"
    return "application/octet-stream"


def file_extension(filename: str) -> str:
    return Path(filename or "").suffix.lower().lstrip(".")
