#!/usr/bin/env python3
"""Core-only Python bridge used by the Tauri shell."""

from __future__ import annotations

import json
import base64
import mimetypes
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any


DEFAULT_CORE_URL = "http://127.0.0.1:8765"
IRIS_CORE_TOKEN_ACCOUNT = "iris-core-token"
LEGACY_CORE_TOKEN_ACCOUNT = "hermes-" + "side" + "car-token"
REMOTE_TOKEN_SERVICE = "Iris Desktop"
DEFAULT_MAX_ATTACHMENT_SIZE_MB = 250


def main() -> None:
    if len(sys.argv) < 3:
        emit_error("Usage: core_bridge.py <action> <payload-json>")
        return

    try:
        payload = json.loads(sys.argv[2])
    except json.JSONDecodeError as exc:
        emit_error(f"Invalid payload JSON: {exc}")
        return

    handlers = {
        "core_request": core_request,
        "core_attachment_data": core_attachment_data,
        "core_upload_path": core_upload_path,
        "remote_credential_status": remote_credential_status,
        "remote_credential_save": remote_credential_save,
        "remote_credential_delete": remote_credential_delete,
    }
    handler = handlers.get(sys.argv[1])
    if handler is None:
        emit_error(f"Unknown Iris bridge action: {sys.argv[1]}")
        return
    try:
        emit(handler(payload))
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        emit_error(str(exc))


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False), flush=True)


def emit_error(message: str) -> None:
    emit({"ok": False, "error": message})


def core_request(payload: dict[str, Any]) -> dict[str, Any]:
    method = str(payload.get("method") or "GET").upper()
    if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        return {"ok": False, "error": "Unsupported Core request method."}
    path = str(payload.get("path") or "").strip()
    if not path.startswith("/"):
        path = f"/{path}"
    if path == "/":
        return {"ok": False, "error": "Core request path is required."}
    body = payload.get("body") if isinstance(payload.get("body"), dict) else None
    return core_json_request(payload, path, method=method, body=body, timeout=12)


def core_attachment_data(payload: dict[str, Any]) -> dict[str, Any]:
    path = str(payload.get("path") or payload.get("url") or "").strip()
    if not path:
        return {"ok": False, "error": "Attachment path is required."}
    url = core_attachment_url(payload, path)
    result = core_bytes_request(url, payload, timeout=30)
    if not result["ok"]:
        return result
    mime_type = str(result.get("mimeType") or "application/octet-stream").split(";", 1)[0]
    requested_mime_type = str(payload.get("mimeType") or "").split(";", 1)[0]
    filename = str(payload.get("filename") or payload.get("name") or "")
    content = result.get("_content") if isinstance(result.get("_content"), bytes) else b""
    local_path = ""
    if should_transcode_audio_for_webview(mime_type, filename) or should_transcode_audio_for_webview(requested_mime_type, filename):
        transcoded = transcode_audio_to_wav(content)
        if transcoded:
            content = transcoded
            mime_type = "audio/wav"
            local_path = write_temp_audio_file(content, ".wav")
    data = base64.b64encode(content).decode("ascii")
    return {
        "ok": True,
        "mimeType": mime_type,
        "dataUrl": f"data:{mime_type};base64,{data}",
        "localPath": local_path,
    }


def core_upload_path(payload: dict[str, Any]) -> dict[str, Any]:
    path = Path(str(payload.get("localPath") or payload.get("path") or "")).expanduser()
    if not path.is_file():
        return {"ok": False, "error": "Attachment file does not exist."}
    size_limit_mb = max_attachment_size_mb()
    if path.stat().st_size > size_limit_mb * 1024 * 1024:
        return {"ok": False, "error": f"Attachment exceeds the {size_limit_mb} MB limit."}

    filename = str(payload.get("name") or path.name or "attachment")
    mime_type = str(payload.get("mimeType") or mimetypes.guess_type(filename)[0] or "application/octet-stream")
    fields = {
        "profile": str(payload.get("profile") or "default"),
        "runtimeId": str(payload.get("runtimeId") or "runtime_local_hermes"),
        "kind": str(payload.get("kind") or kind_from_mime(mime_type)),
        "conversationId": str(payload.get("conversationId") or ""),
        "messageId": str(payload.get("messageId") or ""),
        "metadata": json.dumps(payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}),
    }
    try:
        content = path.read_bytes()
    except OSError as exc:
        return {"ok": False, "error": f"Could not read attachment: {exc}"}

    body, content_type = multipart_body(fields, file_field="file", filename=filename, mime_type=mime_type, content=content)
    result = core_raw_request(
        core_endpoint(core_base_url(payload), "/attachments"),
        payload,
        method="POST",
        body=body,
        headers={"Content-Type": content_type, "Accept": "application/json"},
        timeout=30,
    )
    return result


def max_attachment_size_mb() -> int:
    try:
        value = int(os.environ.get("IRIS_MAX_ATTACHMENT_SIZE_MB", ""))
    except ValueError:
        value = DEFAULT_MAX_ATTACHMENT_SIZE_MB
    return min(max(value or DEFAULT_MAX_ATTACHMENT_SIZE_MB, 1), 4096)


def kind_from_mime(mime_type: str) -> str:
    normalized = str(mime_type or "").split(";", 1)[0].strip().lower()
    if normalized.startswith("image/"):
        return "image"
    if normalized.startswith("audio/"):
        return "audio"
    if normalized.startswith("video/"):
        return "video"
    if normalized.startswith("text/"):
        return "code"
    if normalized in {"application/zip", "application/x-tar", "application/gzip", "application/x-7z-compressed", "application/vnd.rar"}:
        return "archive"
    if normalized in {"application/pdf", "application/json", "application/xml", "application/rtf"}:
        return "document"
    return "file"


def core_json_request(
    payload: dict[str, Any],
    path: str,
    *,
    method: str,
    body: dict[str, Any] | None,
    timeout: int,
) -> dict[str, Any]:
    data = json.dumps(body or {}).encode("utf-8") if body is not None else None
    return core_raw_request(
        core_endpoint(core_base_url(payload), path),
        payload,
        method=method,
        body=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        timeout=timeout,
    )


def core_raw_request(
    url: str,
    payload: dict[str, Any],
    *,
    method: str,
    body: bytes | None,
    headers: dict[str, str],
    timeout: int,
) -> dict[str, Any]:
    token = str(payload.get("coreToken") or "").strip() or read_remote_token("core")
    request_headers = dict(headers)
    if token:
        request_headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8", errors="replace")
            status = response.status
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "url": url, "status": exc.code, "error": api_error_text(text) or f"HTTP {exc.code}"}
    except Exception as exc:
        return {"ok": False, "url": url, "error": str(exc)}

    try:
        parsed = json.loads(text) if text else {}
    except json.JSONDecodeError as exc:
        return {"ok": False, "url": url, "status": status, "error": f"Invalid JSON: {exc}"}
    if not isinstance(parsed, dict):
        return {"ok": False, "url": url, "status": status, "error": "Expected a JSON object."}
    return {**parsed, "ok": bool(parsed.get("ok", True)), "url": url, "status": status}


def core_bytes_request(url: str, payload: dict[str, Any], *, timeout: int) -> dict[str, Any]:
    token = str(payload.get("coreToken") or "").strip() or read_remote_token("core")
    request_headers = {"Accept": "*/*"}
    if token:
        request_headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=request_headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content = response.read()
            status = response.status
            mime_type = response.headers.get("Content-Type", "application/octet-stream")
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "url": url, "status": exc.code, "error": api_error_text(text) or f"HTTP {exc.code}"}
    except Exception as exc:
        return {"ok": False, "url": url, "error": str(exc)}
    return {
        "ok": True,
        "url": url,
        "status": status,
        "mimeType": mime_type,
        "_content": content,
        "base64": base64.b64encode(content).decode("ascii"),
    }


def should_transcode_audio_for_webview(mime_type: str, filename: str = "") -> bool:
    normalized = str(mime_type or "").split(";", 1)[0].strip().lower()
    lower_filename = str(filename or "").lower()
    return normalized in {"audio/webm", "video/webm", "audio/ogg", "application/ogg"} or lower_filename.endswith((".webm", ".ogg"))


def transcode_audio_to_wav(content: bytes) -> bytes:
    if not content:
        return b""
    ffmpeg = first_existing_executable(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"])
    if not ffmpeg:
        return b""
    with tempfile.TemporaryDirectory(prefix="iris-audio-") as directory:
        source = Path(directory) / "source.webm"
        target = Path(directory) / "voice.wav"
        source.write_bytes(content)
        result = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-vn",
                "-acodec",
                "pcm_s16le",
                "-ac",
                "1",
                "-ar",
                "48000",
                str(target),
            ],
            capture_output=True,
        )
        if result.returncode != 0 or not target.is_file():
            return b""
        return target.read_bytes()


def write_temp_audio_file(content: bytes, suffix: str) -> str:
    if not content:
        return ""
    try:
        with tempfile.NamedTemporaryFile(prefix="iris-audio-", suffix=suffix, delete=False) as handle:
            handle.write(content)
            return handle.name
    except OSError:
        return ""


def first_existing_executable(candidates: list[str]) -> str:
    for candidate in candidates:
        if "/" in candidate:
            if Path(candidate).is_file() and os.access(candidate, os.X_OK):
                return candidate
            continue
        path = shutil.which(candidate)
        if path:
            return path
    return ""


def core_base_url(payload: dict[str, Any]) -> str:
    runtime = payload.get("runtime") if isinstance(payload.get("runtime"), dict) else {}
    value = str(runtime.get("coreApiUrl") or payload.get("coreApiUrl") or DEFAULT_CORE_URL).strip()
    return value or DEFAULT_CORE_URL


def core_endpoint(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    if not base.endswith("/v1"):
        base = f"{base}/v1"
    return f"{base}{path if path.startswith('/') else f'/{path}'}"


def core_attachment_url(payload: dict[str, Any], value: str) -> str:
    if value.startswith("http://") or value.startswith("https://"):
        return value
    if value.startswith("/v1/"):
        return f"{core_base_url(payload).rstrip('/')}{value[3:] if core_base_url(payload).rstrip('/').endswith('/v1') else value}"
    return core_endpoint(core_base_url(payload), value)


def multipart_body(
    fields: dict[str, str],
    *,
    file_field: str,
    filename: str,
    mime_type: str,
    content: bytes,
) -> tuple[bytes, str]:
    boundary = f"----iris-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}\r\n".encode())
    chunks.append(
        (
            f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
            f"Content-Type: {mime_type}\r\n\r\n"
        ).encode()
    )
    chunks.append(content)
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def remote_credential_status(payload: dict[str, Any]) -> dict[str, Any]:
    kind = credential_kind(payload.get("kind"))
    return {"ok": True, "kind": kind, **read_remote_token_status(kind)}


def remote_credential_save(payload: dict[str, Any]) -> dict[str, Any]:
    kind = credential_kind(payload.get("kind"))
    token = str(payload.get("token") or "").strip()
    if not token:
        return {"ok": False, "kind": kind, "error": "API token is empty."}
    backend = credential_backend()
    if backend == "test-file":
        test_credential_path(kind).write_text(token, encoding="utf-8")
        return {"ok": True, "kind": kind, "exists": True, "source": backend}
    if backend == "macos-keychain":
        delete_keychain_token(credential_account(kind))
        result = subprocess.run(
            [
                "security",
                "add-generic-password",
                "-U",
                "-a",
                credential_account(kind),
                "-s",
                REMOTE_TOKEN_SERVICE,
                "-w",
                token,
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return {"ok": True, "kind": kind, "exists": True, "source": backend}
        return {"ok": False, "kind": kind, "error": (result.stderr or result.stdout or "macOS Keychain rejected the token.").strip()}
    return {"ok": False, "kind": kind, "error": "No supported OS credential store is available."}


def remote_credential_delete(payload: dict[str, Any]) -> dict[str, Any]:
    kind = credential_kind(payload.get("kind"))
    backend = credential_backend()
    if backend == "test-file":
        path = test_credential_path(kind)
        if path.exists():
            path.unlink()
        return {"ok": True, "kind": kind, "exists": False, "source": backend}
    if backend == "macos-keychain":
        delete_keychain_token(credential_account(kind))
    return {"ok": True, "kind": kind, "exists": False, "source": backend}


def read_remote_token_status(kind: str = "core") -> dict[str, Any]:
    if read_env_token(kind):
        return {"exists": True, "source": "environment"}
    token = read_remote_token(kind, include_env=False)
    return {"exists": bool(token), "source": credential_backend()}


def read_remote_token(kind: str = "core", *, include_env: bool = True) -> str:
    kind = credential_kind(kind)
    if include_env:
        env_token = read_env_token(kind)
        if env_token:
            return env_token
    if os.environ.get("IRIS_DESKTOP_SECRET_TEST_DIR"):
        path = test_credential_path(kind)
        return path.read_text(encoding="utf-8").strip() if path.exists() else ""
    if credential_backend() != "macos-keychain":
        return ""
    return read_keychain_token(credential_account(kind)) or read_keychain_token(LEGACY_CORE_TOKEN_ACCOUNT)


def read_env_token(_kind: str) -> str:
    return (
        os.environ.get("IRIS_CORE_TOKEN", "").strip()
        or os.environ.get("IRIS_TOKEN", "").strip()
        or os.environ.get("AGENTUI_TOKEN", "").strip()
    )


def read_keychain_token(account: str) -> str:
    result = subprocess.run(
        ["security", "find-generic-password", "-w", "-a", account, "-s", REMOTE_TOKEN_SERVICE],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def delete_keychain_token(account: str) -> None:
    subprocess.run(
        ["security", "delete-generic-password", "-a", account, "-s", REMOTE_TOKEN_SERVICE],
        capture_output=True,
        text=True,
    )


def credential_kind(value: Any) -> str:
    raw = str(value or "").strip().lower()
    legacy_kind = "side" + "car"
    return "core" if raw in {"", "core", legacy_kind} else "core"


def credential_account(kind: str) -> str:
    return IRIS_CORE_TOKEN_ACCOUNT


def credential_backend() -> str:
    if os.environ.get("IRIS_DESKTOP_SECRET_TEST_DIR"):
        return "test-file"
    if sys.platform == "darwin":
        return "macos-keychain"
    if read_env_token("core"):
        return "environment"
    return "unavailable"


def test_credential_path(kind: str = "core") -> Path:
    base = Path(os.environ["IRIS_DESKTOP_SECRET_TEST_DIR"]).expanduser()
    base.mkdir(parents=True, exist_ok=True)
    path = base / credential_account(kind)
    try:
        base.chmod(0o700)
    except OSError:
        pass
    return path


def api_error_text(text: str) -> str:
    if not text.strip():
        return ""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text.strip()
    if not isinstance(parsed, dict):
        return text.strip()
    error = parsed.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error)
    return str(error or parsed.get("message") or "")


if __name__ == "__main__":
    main()
