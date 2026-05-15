from __future__ import annotations

import hashlib
import json
from typing import Any, Callable

from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from .attachment_helpers import safe_attachment_name
from .attachment_types import attachment_kind, attachment_mime_type
from .core_store import (
    DEFAULT_RUNTIME_ID,
    attachment_size_limit_label,
    client_attachment_payload,
    max_attachment_size_bytes,
)
from .security import ManagementError


def register_attachment_routes(app: FastAPI, require_auth: Callable[..., Any]) -> None:
    @app.post("/v1/attachments")
    async def core_create_attachment(
        request: Request,
        file: UploadFile = File(...),
        sessionId: str = Form(""),
        messageId: str = Form(""),
        runtimeId: str = Form(DEFAULT_RUNTIME_ID),
        profile: str = Form("default"),
        kind: str = Form(""),
        mimeType: str = Form(""),
        metadata: str = Form(""),
        _auth: None = Depends(require_auth),
    ) -> dict[str, Any]:
        core_store = app.state.core_store
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
                content_type=mimeType or file.content_type or "",
                head=head,
            )
            try:
                attachment = core_store.create_attachment(
                    source_path=temp_path,
                    runtime_id=runtimeId or DEFAULT_RUNTIME_ID,
                    profile=profile or "default",
                    session_id=sessionId,
                    message_id=messageId,
                    owner_device_id=str(getattr(getattr(request, "state", None), "iris_device", {}).get("id", "")),
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
        core_store = app.state.core_store
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
        core_store = app.state.core_store
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
