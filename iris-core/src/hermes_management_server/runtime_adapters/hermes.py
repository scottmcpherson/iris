"""Hermes runtime adapter for Iris Core."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from ..attachment_types import normalized_runtime_mime_type
from ..core_store import (
    DEFAULT_RUNTIME_ID,
    CoreStore,
    agent_from_profile_summary,
    session_from_runtime_summary,
    core_message_from_hermes,
    message_content_hash_candidates,
)
from .hermes_store import HermesStore
from ..security import ManagementError


DEFAULT_GATEWAY_URL = "http://127.0.0.1:8642"
DEFAULT_MANAGEMENT_URL = "http://127.0.0.1:8765"
DEFAULT_AGENTUI_GATEWAY_URL = "http://127.0.0.1:8766"
AGENTUI_GATEWAY_PORT_OFFSET = 124


def agentui_multipart_attachments(attachments: Any) -> list[dict[str, Any]]:
    if not isinstance(attachments, list) or not attachments:
        return []
    rows: list[dict[str, Any]] = []
    for item in attachments:
        if not isinstance(item, dict):
            continue
        storage_path = str(item.get("storagePath") or "").strip()
        if not storage_path:
            continue
        name = str(item.get("name") or "attachment").strip()
        rows.append({
            "id": str(item.get("id") or ""),
            "name": name,
            "kind": str(item.get("kind") or ""),
            "mimeType": normalized_runtime_mime_type(item),
            "size": item.get("size") if isinstance(item.get("size"), int) else -1,
            "sha256": str(item.get("sha256") or ""),
            "path": storage_path,
        })
    return rows


def agentui_payload_attachment(attachment: dict[str, Any], field: str) -> dict[str, Any]:
    return {
        "field": field,
        "id": str(attachment.get("id") or ""),
        "name": str(attachment.get("name") or "attachment"),
        "kind": str(attachment.get("kind") or ""),
        "mimeType": normalized_runtime_mime_type(attachment),
        "size": attachment.get("size") if isinstance(attachment.get("size"), int) else -1,
        **({"sha256": attachment["sha256"]} if attachment.get("sha256") else {}),
    }


def local_runtime_config(*, management_url: str | None = None) -> dict[str, Any]:
    gateway_url = os.environ.get("HERMES_GATEWAY_URL") or DEFAULT_GATEWAY_URL
    default_agentui_url = os.environ.get("IRIS_TO_HERMES_URL") or os.environ.get("AGENTUI_TO_HERMES_URL") or DEFAULT_AGENTUI_GATEWAY_URL
    return {
        "id": DEFAULT_RUNTIME_ID,
        "kind": "hermes",
        "name": "Local Hermes",
        "enabled": True,
        "connection": {
            "gatewayUrl": gateway_url,
            "managementUrl": management_url or os.environ.get("HERMES_MGMT_URL") or DEFAULT_MANAGEMENT_URL,
            "agentuiGatewayUrls": {
                "default": default_agentui_url,
            },
            "network": "local",
        },
    }


class HermesRuntimeAdapter:
    kind = "hermes"

    def __init__(
        self,
        runtime: dict[str, Any],
        *,
        hermes_store: HermesStore | None = None,
        hermes_home: str | os.PathLike[str] | None = None,
        core_store: CoreStore | None = None,
        agentui_token: str = "",
        hermes_api_token: str = "",
    ) -> None:
        self.runtime = runtime
        self.hermes_store = hermes_store
        self.hermes_home = hermes_home
        self.core_store = core_store
        self.token = agentui_token or os.environ.get("IRIS_TOKEN") or os.environ.get("AGENTUI_TOKEN") or ""
        self.hermes_api_token = (
            hermes_api_token
            or os.environ.get("HERMES_API_TOKEN")
            or os.environ.get("HERMES_REMOTE_TOKEN")
            or ""
        )
        self.connection = runtime.get("connection") if isinstance(runtime.get("connection"), dict) else {}

    def list_agents(self) -> list[dict[str, Any]]:
        store = self.require_store()
        profiles = store.profiles()
        active_profile = next((profile.name for profile in profiles if profile.active), "default")
        return [agent_from_profile_summary(self.runtime, profile, active_profile) for profile in profiles]

    def get_agent(self, agent_id: str) -> dict[str, Any] | None:
        return next((agent for agent in self.list_agents() if agent["id"] == agent_id), None)

    def create_agent(self, name: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        del metadata
        self.require_store().create_profile(name)
        return self.require_agent_profile(name)

    def clone_agent(self, source_agent: dict[str, Any], name: str) -> dict[str, Any]:
        self.require_store().clone_profile(str(source_agent["runtimeProfile"]), name)
        return self.require_agent_profile(name)

    def rename_agent(self, agent: dict[str, Any], name: str) -> dict[str, Any]:
        self.require_store().rename_profile(str(agent["runtimeProfile"]), name)
        return self.require_agent_profile(name)

    def activate_agent(self, agent: dict[str, Any]) -> dict[str, Any]:
        self.require_store().activate_profile(str(agent["runtimeProfile"]))
        refreshed = self.get_agent(str(agent["id"])) or self.require_agent_profile(str(agent["runtimeProfile"]))
        return {**refreshed, "isDefault": True}

    def delete_agent(self, agent: dict[str, Any]) -> dict[str, Any]:
        next_profile = self.require_store().delete_profile(str(agent["runtimeProfile"]))
        return self.require_agent_profile(next_profile)

    def require_agent_profile(self, profile: str) -> dict[str, Any]:
        agent = next((row for row in self.list_agents() if row["runtimeProfile"] == profile), None)
        if not agent:
            raise ManagementError("Agent was not found.", status_code=404)
        return agent

    def agent_memory(self, agent: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        store = self.require_store()
        memory_file, user_file = store.memory_files(profile)
        directory = store.profile_directory(profile)
        return {
            "ok": True,
            "profile": profile,
            "path": str(directory / "memories"),
            "files": [memory_file, user_file],
            "memory": memory_file,
            "user": user_file,
            "history": [],
        }

    def save_agent_memory(
        self,
        agent: dict[str, Any],
        file: str,
        content: str,
        expected_updated_at: int | None = None,
    ) -> dict[str, Any]:
        self.require_store().save_memory_file(str(agent["runtimeProfile"]), file, content, expected_updated_at)
        return self.agent_memory(agent)

    def reset_agent_memory(self, agent: dict[str, Any], file: str) -> dict[str, Any]:
        self.require_store().reset_memory_file(str(agent["runtimeProfile"]), file)
        return self.agent_memory(agent)

    def list_agent_skills(self, agent: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        store = self.require_store()
        directory = store.profile_directory(profile)
        return {
            "ok": True,
            "profile": profile,
            "path": str(directory / "skills"),
            "skills": store.skills(profile),
        }

    def get_agent_skill(self, agent: dict[str, Any], skill_id: str) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        summary, content = self.require_store().skill_detail(profile, skill_id)
        return {"ok": True, "profile": profile, "content": content, "history": [], **summary.model_dump()}

    def create_agent_skill(self, agent: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        summary, content = self.require_store().save_skill(profile, payload)
        return {"ok": True, "profile": profile, "skill": {"content": content, "history": [], **summary.model_dump()}}

    def save_agent_skill(self, agent: dict[str, Any], skill_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        profile = str(agent["runtimeProfile"])
        summary, content = self.require_store().save_skill(profile, payload, skill_id)
        return {"ok": True, "profile": profile, "skill": {"content": content, "history": [], **summary.model_dump()}}

    def list_sessions(self, agent: dict[str, Any], limit: int = 80) -> list[dict[str, Any]]:
        store = self.require_store()
        result = store.sessions(str(agent["runtimeProfile"]), limit)
        return [session_from_runtime_summary(agent, session) for session in result.sessions]

    def get_session(
        self,
        agent: dict[str, Any],
        external_id: str = "",
        *,
        chat_id: str = "",
        session_id: str = "",
    ) -> dict[str, Any] | None:
        external_id = str(external_id or "").strip()
        chat_id = str(chat_id or "").strip()
        if external_id:
            try:
                detail = self.require_store().session_detail(str(agent["runtimeProfile"]), external_id)
                return session_from_runtime_summary(agent, detail.session)
            except ManagementError:
                pass
        for session in self.list_sessions(agent, 200):
            if session_id and session["id"] == session_id:
                return session
            if chat_id and session["externalChatId"] == chat_id:
                return session
        return None

    def rename_session(
        self,
        agent: dict[str, Any],
        session: dict[str, Any],
        title: str,
    ) -> dict[str, Any]:
        clean_title = title.strip()
        if not clean_title:
            raise ManagementError("Session title is required.", status_code=400)
        external_session_id = str(session.get("externalSessionId") or "").strip()
        if not external_session_id:
            return {**session, "title": clean_title, "updatedAt": int(time.time())}
        detail = self.require_store().rename_session(
            str(agent["runtimeProfile"]),
            external_session_id,
            clean_title,
        )
        return session_from_runtime_summary(agent, detail.session)

    def delete_session(
        self,
        agent: dict[str, Any],
        session: dict[str, Any],
    ) -> dict[str, Any]:
        external_session_id = str(session.get("externalSessionId") or "").strip()
        if external_session_id:
            self.require_store().delete_session(str(agent["runtimeProfile"]), external_session_id)
        return session

    def get_session_messages(
        self,
        agent: dict[str, Any],
        external_id: str = "",
        *,
        chat_id: str = "",
        session_id: str = "",
    ) -> tuple[list[dict[str, Any]], str | None]:
        session = self.get_session(
            agent,
            external_id,
            chat_id=chat_id,
            session_id=session_id,
        )
        if not session or not session["externalSessionId"]:
            return [], None
        detail = self.require_store().session_detail(
            str(agent["runtimeProfile"]),
            str(session["externalSessionId"]),
        )
        messages = [
            {**core_message_from_hermes(message), "sessionId": session["id"]}
            for message in detail.messages
        ]
        return self.with_client_message_metadata(
            messages,
            profile=str(agent["runtimeProfile"]),
            chat_id=str(session["externalChatId"] or ""),
        ), detail.warning

    def with_client_message_metadata(
        self,
        messages: list[dict[str, Any]],
        *,
        profile: str,
        chat_id: str,
    ) -> list[dict[str, Any]]:
        if not self.core_store or not chat_id:
            return messages
        overlays = self.core_store.client_message_metadata_for_messages(
            runtime_id=str(self.runtime["id"]),
            profile=profile,
            chat_id=chat_id,
            messages=messages,
        )
        by_message_id = overlays["byMessageId"]
        by_content_hash = overlays["byContentHash"]
        attachment_fallbacks = overlays.get("attachmentFallbacks", [])
        used_attachment_fallbacks: set[str] = set()
        enriched: list[dict[str, Any]] = []
        for message in messages:
            if message.get("role") not in {"user", "assistant"}:
                enriched.append(message)
                continue
            overlay = by_message_id.get(str(message.get("id") or ""))
            metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
            stream_message_id = str(metadata.get("streamMessageId") or metadata.get("stream_message_id") or "")
            if not overlay and stream_message_id:
                overlay = by_message_id.get(stream_message_id)
            if not overlay:
                overlay = next(
                    (
                        by_content_hash[content_hash]
                        for content_hash in message_content_hash_candidates(str(message.get("content") or ""))
                        if content_hash in by_content_hash
                    ),
                    None,
                )
            if not overlay:
                fallback = next(
                    (
                        item
                        for item in attachment_fallbacks
                        if str(item.get("messageId") or "") not in used_attachment_fallbacks
                    ),
                    None,
                ) if (
                    str(message.get("role") or "") == "user" and
                    is_transformed_voice_message_content(str(message.get("content") or ""))
                ) else None
                if fallback and isinstance(fallback.get("metadata"), dict):
                    used_attachment_fallbacks.add(str(fallback.get("messageId") or ""))
                    overlay = fallback["metadata"]
            if not overlay:
                enriched.append(message)
                continue
            content = str(message.get("content") or "")
            client_content = overlay.get("clientContent")
            if isinstance(client_content, str):
                content = client_content
            elif (
                message.get("role") == "user" and
                isinstance(overlay.get("attachments"), list) and
                is_transformed_voice_message_content(content)
            ):
                content = ""
            enriched.append({**message, "content": content, "metadata": {**metadata, **overlay}})
        return enriched

    def probe(self, profile: str = "default") -> dict[str, Any]:
        gateway_url = str(self.connection.get("gatewayUrl") or DEFAULT_GATEWAY_URL)
        management_url = str(self.connection.get("managementUrl") or DEFAULT_MANAGEMENT_URL)
        adapter_url = self.agentui_gateway_url(profile)
        return {
            "gateway": probe_endpoint(gateway_url),
            "management": probe_endpoint(f"{management_url.rstrip('/')}/health"),
            "agentuiAdapter": {
                **probe_endpoint(f"{adapter_url.rstrip('/')}/health"),
                "profile": profile,
            },
        }

    def send_message(
        self,
        *,
        profile: str,
        chat_id: str,
        chat_name: str,
        message_id: str,
        text: str,
        session_id: str = "",
        user_id: str = "agentui-user",
        user_name: str = "Iris User",
        metadata: dict[str, Any] | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if not self.token:
            return {"ok": False, "error": "IRIS_TOKEN or AGENTUI_TOKEN is required for Iris gateway chat."}
        url = f"{self.agentui_gateway_url(profile).rstrip('/')}/iris/messages"
        metadata_payload = metadata if isinstance(metadata, dict) else {}
        multipart_attachments = agentui_multipart_attachments(attachments or [])
        body: dict[str, Any] = {
            "chatId": chat_id,
            "chatName": chat_name or chat_id,
            "profile": profile,
            "userId": user_id,
            "userName": user_name,
            "messageId": message_id,
            "text": text,
        }
        if session_id:
            body["sessionId"] = session_id
        if multipart_attachments:
            files: list[dict[str, Any]] = []
            payload_attachments: list[dict[str, Any]] = []
            for index, attachment in enumerate(multipart_attachments):
                field = f"file_{index}"
                payload_attachments.append(agentui_payload_attachment(attachment, field))
                files.append({
                    "field": field,
                    "path": attachment["path"],
                    "name": str(attachment.get("name") or f"attachment-{index}"),
                    "mimeType": normalized_runtime_mime_type(attachment),
                })
            body["attachments"] = payload_attachments
        if metadata_payload:
            body["metadata"] = metadata_payload
        if multipart_attachments:
            result = http_multipart(url, method="POST", token=self.token, payload=body, files=files)
        else:
            result = http_json(url, method="POST", token=self.token, body=body)
        if not result.get("ok"):
            return {
                "ok": False,
                "url": result.get("url") or url,
                "status": result.get("status"),
                "error": result.get("error") or "Iris gateway message failed.",
            }
        parsed = result.get("json") if isinstance(result.get("json"), dict) else {}
        if parsed.get("ok") is False:
            return {**parsed, "url": result.get("url") or url, "status": result.get("status")}
        return {
            **parsed,
            "ok": True,
            "profile": str(parsed.get("profile") or profile),
            "url": result.get("url") or url,
            "status": result.get("status"),
        }

    def models(self, profile: str, max_models: int = 100) -> dict[str, Any]:
        if not self.token:
            return {
                "ok": False,
                "profile": profile,
                "current": None,
                "providers": [],
                "generatedAt": int(time.time()),
                "error": "IRIS_TOKEN or AGENTUI_TOKEN is required for model catalog discovery.",
            }
        query = urllib.parse.urlencode({"maxModels": max(1, min(int(max_models), 200))})
        url = f"{self.agentui_gateway_url(profile).rstrip('/')}/iris/models?{query}"
        return adapter_catalog_request(url, self.token, profile, fallback_key="providers")

    def slash_commands(self, profile: str) -> dict[str, Any]:
        if not self.token:
            return {
                "ok": False,
                "profile": profile,
                "commands": [],
                "generatedAt": int(time.time()),
                "error": "IRIS_TOKEN or AGENTUI_TOKEN is required for slash command discovery.",
            }
        url = f"{self.agentui_gateway_url(profile).rstrip('/')}/iris/slash-commands"
        return adapter_catalog_request(url, self.token, profile, fallback_key="commands")

    def slash_complete(self, profile: str, text: str, limit: int = 30) -> dict[str, Any]:
        if not self.token:
            return {
                "ok": False,
                "items": [],
                "replaceFrom": 0,
                "error": "IRIS_TOKEN or AGENTUI_TOKEN is required for slash command completion.",
            }
        url = f"{self.agentui_gateway_url(profile).rstrip('/')}/iris/slash-complete"
        result = http_json(url, method="POST", token=self.token, body={"text": text, "limit": limit})
        if not result.get("ok"):
            return {
                "ok": False,
                "items": [],
                "replaceFrom": 0,
                "url": result.get("url") or url,
                "status": result.get("status"),
                "error": result.get("error") or "Iris slash command completion is unavailable.",
            }
        parsed = result.get("json") if isinstance(result.get("json"), dict) else {}
        return {**parsed, "ok": bool(parsed.get("ok", True)), "url": result.get("url") or url, "status": result.get("status")}

    def list_automations(self, profile: str) -> dict[str, Any]:
        del profile
        return self.jobs_request("/api/jobs?include_disabled=true", method="GET")

    def require_store(self) -> HermesStore:
        if self.hermes_store is None:
            self.hermes_store = HermesStore(self.hermes_home)
        return self.hermes_store

    def create_automation(self, automation: dict[str, Any]) -> dict[str, Any]:
        body: dict[str, Any] = {}
        for key in ("name", "schedule", "prompt", "deliver", "repeat"):
            value = automation.get(key)
            if value not in (None, ""):
                body[key] = value
        skills = automation.get("skills")
        if isinstance(skills, list):
            body["skills"] = [str(item) for item in skills if str(item).strip()]
        return self.jobs_request("/api/jobs", method="POST", body=body)

    def update_automation(self, external_job_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        body: dict[str, Any] = {}
        for key in ("name", "schedule", "prompt", "deliver", "repeat"):
            if key == "repeat" and key in updates:
                body[key] = updates.get(key)
                continue
            value = updates.get(key)
            if value not in (None, ""):
                body[key] = value
        return self.jobs_request(
            f"/api/jobs/{urllib.parse.quote(external_job_id, safe='')}",
            method="PATCH",
            body=body,
        )

    def delete_automation(self, external_job_id: str) -> dict[str, Any]:
        return self.jobs_request(
            f"/api/jobs/{urllib.parse.quote(external_job_id, safe='')}",
            method="DELETE",
        )

    def control_automation(self, external_job_id: str, action: str) -> dict[str, Any]:
        return self.jobs_request(
            f"/api/jobs/{urllib.parse.quote(external_job_id, safe='')}/{action}",
            method="POST",
            body={},
        )

    def jobs_request(self, path: str, *, method: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        url = f"{str(self.connection.get('gatewayUrl') or DEFAULT_GATEWAY_URL).rstrip('/')}{path}"
        result = http_json(url, method=method, token=self.hermes_api_token, body=body)
        if not result.get("ok"):
            return {
                "ok": False,
                "url": result.get("url") or url,
                "status": result.get("status"),
                "error": result.get("error") or "Hermes jobs API request failed.",
            }
        parsed = result.get("json") if isinstance(result.get("json"), dict) else {}
        if parsed.get("ok") is False:
            return {
                **parsed,
                "url": result.get("url") or url,
                "status": result.get("status"),
                "error": parsed.get("error") or "Hermes jobs API request failed.",
            }
        return {**parsed, "ok": True, "url": result.get("url") or url, "status": result.get("status")}

    def agentui_gateway_url(self, profile: str) -> str:
        routes = self.connection.get("agentuiGatewayUrls") if isinstance(self.connection.get("agentuiGatewayUrls"), dict) else {}
        explicit = routes.get(profile) or routes.get("default")
        if explicit:
            return str(explicit)
        gateway_url = str(self.connection.get("gatewayUrl") or DEFAULT_GATEWAY_URL)
        derived = derive_agentui_gateway_url(gateway_url)
        return derived or DEFAULT_AGENTUI_GATEWAY_URL


def derive_agentui_gateway_url(gateway_url: str) -> str:
    parsed = urllib.parse.urlparse(gateway_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or not parsed.port:
        return ""
    host = parsed.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return urllib.parse.urlunparse(
        (parsed.scheme, f"{host}:{parsed.port + AGENTUI_GATEWAY_PORT_OFFSET}", "", "", "", "")
    )


def probe_endpoint(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            response.read(256)
            return {"ok": 200 <= response.status < 500, "url": url, "status": response.status}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "url": url, "status": exc.code, "error": f"HTTP {exc.code}"}
    except Exception as exc:
        return {"ok": False, "url": url, "error": str(exc)}


def adapter_catalog_request(url: str, token: str, profile: str, *, fallback_key: str) -> dict[str, Any]:
    result = http_json(url, method="GET", token=token)
    empty = [] if fallback_key in {"providers", "commands"} else {}
    if not result.get("ok"):
        return {
            "ok": False,
            "profile": profile,
            fallback_key: empty,
            "generatedAt": int(time.time()),
            "url": result.get("url") or url,
            "status": result.get("status"),
            "error": result.get("error") or "Iris adapter request failed.",
        }
    parsed = result.get("json") if isinstance(result.get("json"), dict) else {}
    return {
        **parsed,
        "ok": bool(parsed.get("ok", True)),
        "profile": str(parsed.get("profile") or profile),
        "url": result.get("url") or url,
        "status": result.get("status"),
    }


def http_json(url: str, *, method: str, token: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    data = json.dumps(body or {}).encode("utf-8") if body is not None else None
    headers = {
        "Accept": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
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
    return {"ok": True, "url": url, "status": status, "json": parsed}


def http_multipart(
    url: str,
    *,
    method: str,
    token: str,
    payload: dict[str, Any],
    files: list[dict[str, Any]],
) -> dict[str, Any]:
    boundary = f"iris-{uuid.uuid4().hex}"
    body = bytearray()

    def add_part(headers: dict[str, str], content: bytes) -> None:
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        for key, value in headers.items():
            body.extend(f"{key}: {value}\r\n".encode("utf-8"))
        body.extend(b"\r\n")
        body.extend(content)
        body.extend(b"\r\n")

    add_part(
        {
            "Content-Disposition": 'form-data; name="payload"',
            "Content-Type": "application/json; charset=utf-8",
        },
        json.dumps(payload).encode("utf-8"),
    )
    for file_part in files:
        path = Path(str(file_part.get("path") or ""))
        try:
            data = path.read_bytes()
        except OSError as exc:
            return {"ok": False, "url": url, "error": f"Attachment content is unavailable: {exc}"}
        field = str(file_part.get("field") or "file")
        filename = str(file_part.get("name") or path.name or "attachment")
        mime_type = str(file_part.get("mimeType") or "application/octet-stream")
        add_part(
            {
                "Content-Disposition": (
                    f'form-data; name="{quote_header_value(field)}"; '
                    f'filename="{quote_header_value(filename)}"'
                ),
                "Content-Type": mime_type,
            },
            data,
        )
    body.extend(f"--{boundary}--\r\n".encode("utf-8"))

    headers = {
        "Accept": "application/json",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=bytes(body), headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
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
    return {"ok": True, "url": url, "status": status, "json": parsed}


def quote_header_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def api_error_text(text: str) -> str:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text.strip()[:240]
    if isinstance(parsed, dict):
        return str(parsed.get("error") or parsed.get("detail") or "").strip()[:240]
    return text.strip()[:240]


def is_transformed_voice_message_content(content: str) -> bool:
    normalized = str(content or "").strip().lower()
    return (
        normalized.startswith("[the user sent a voice message") or
        normalized.startswith("transcription of voice message:")
    )
