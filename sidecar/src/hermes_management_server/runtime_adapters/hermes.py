"""Hermes runtime adapter for Iris Core."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from ..core_store import DEFAULT_RUNTIME_ID


DEFAULT_GATEWAY_URL = "http://127.0.0.1:8642"
DEFAULT_MANAGEMENT_URL = "http://127.0.0.1:8765"
DEFAULT_AGENTUI_GATEWAY_URL = "http://127.0.0.1:8766"
AGENTUI_GATEWAY_PORT_OFFSET = 124


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

    def __init__(self, runtime: dict[str, Any], agentui_token: str = "", hermes_api_token: str = "") -> None:
        self.runtime = runtime
        self.token = agentui_token or os.environ.get("IRIS_TOKEN") or os.environ.get("AGENTUI_TOKEN") or ""
        self.hermes_api_token = (
            hermes_api_token
            or os.environ.get("HERMES_API_TOKEN")
            or os.environ.get("HERMES_REMOTE_TOKEN")
            or ""
        )
        self.connection = runtime.get("connection") if isinstance(runtime.get("connection"), dict) else {}

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
        user_id: str = "agentui-user",
        user_name: str = "Iris User",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not self.token:
            return {"ok": False, "error": "IRIS_TOKEN or AGENTUI_TOKEN is required for Iris gateway chat."}
        url = f"{self.agentui_gateway_url(profile).rstrip('/')}/agentui/messages"
        body: dict[str, Any] = {
            "chatId": chat_id,
            "chatName": chat_name or chat_id,
            "profile": profile,
            "userId": user_id,
            "userName": user_name,
            "messageId": message_id,
            "text": text,
        }
        if metadata:
            body["metadata"] = metadata
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
        url = f"{self.agentui_gateway_url(profile).rstrip('/')}/agentui/models?{query}"
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
        url = f"{self.agentui_gateway_url(profile).rstrip('/')}/agentui/slash-commands"
        return adapter_catalog_request(url, self.token, profile, fallback_key="commands")

    def slash_complete(self, profile: str, text: str, limit: int = 30) -> dict[str, Any]:
        if not self.token:
            return {
                "ok": False,
                "items": [],
                "replaceFrom": 0,
                "error": "IRIS_TOKEN or AGENTUI_TOKEN is required for slash command completion.",
            }
        url = f"{self.agentui_gateway_url(profile).rstrip('/')}/agentui/slash-complete"
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
        return self.jobs_request("/api/jobs", method="GET")

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


def api_error_text(text: str) -> str:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text.strip()[:240]
    if isinstance(parsed, dict):
        return str(parsed.get("error") or parsed.get("detail") or "").strip()[:240]
    return text.strip()[:240]
