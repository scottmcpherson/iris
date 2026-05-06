#!/usr/bin/env python3
"""Python bridge used by the Tauri shell to inspect and run Hermes.

The desktop app keeps Hermes-specific filesystem and process conventions here
so the native shell can evolve without baking Hermes internals into the UI.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_GATEWAY_URL = "http://127.0.0.1:8642"
DEFAULT_MANAGEMENT_URL = "http://127.0.0.1:8765"
DEFAULT_AGENTUI_GATEWAY_URL = "http://127.0.0.1:8766"
AGENTUI_GATEWAY_PORT_OFFSET = 124
HERMES_API_TOKEN_ACCOUNT = "hermes-api-token"
SIDECAR_TOKEN_ACCOUNT = "hermes-sidecar-token"
REMOTE_TOKEN_SERVICE = "Hermes Agent Desktop"


def main() -> None:
    if len(sys.argv) < 3:
        emit_error("Usage: hermes_bridge.py <action> <payload-json>")
        return

    action = sys.argv[1]
    try:
        payload = json.loads(sys.argv[2])
    except json.JSONDecodeError as exc:
        emit_error(f"Invalid payload JSON: {exc}")
        return

    try:
        handlers = {
            "status": status,
            "profiles": profiles,
            "memory": memory,
            "memory_save": memory_save,
            "memory_reset": memory_reset,
            "skills": skills,
            "skill_detail": skill_detail,
            "skill_save": skill_save,
            "conversations": conversations,
            "conversation_detail": conversation_detail,
            "models": models,
            "slash_commands": slash_commands,
            "slash_complete": slash_complete,
            "jobs_list": jobs_list,
            "jobs_create": jobs_create,
            "jobs_update": jobs_update,
            "jobs_delete": jobs_delete,
            "jobs_pause": jobs_pause,
            "jobs_resume": jobs_resume,
            "jobs_run": jobs_run,
            "inbox_messages": inbox_messages,
            "inbox_ack": inbox_ack,
            "gateway_message": gateway_message,
            "send_message": send_message,
            "stream_message": stream_message,
            "profile_create": profile_create,
            "profile_clone": profile_clone,
            "profile_rename": profile_rename,
            "profile_switch": profile_switch,
            "profile_delete": profile_delete,
            "remote_credential_status": remote_credential_status,
            "remote_credential_save": remote_credential_save,
            "remote_credential_delete": remote_credential_delete,
            "core_request": core_request,
        }
        handler = handlers.get(action)
        if handler is None:
            emit_error(f"Unknown Hermes bridge action: {action}")
            return
        result = handler(payload)
        if result is not None:
            emit(result)
    except Exception as exc:
        emit_error(str(exc))


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False), flush=True)


def emit_error(message: str) -> None:
    emit({"ok": False, "error": message})


def hermes_root() -> Path:
    env_home = os.environ.get("HERMES_HOME", "").strip()
    home_root = Path.home() / ".hermes"
    if not env_home:
        return home_root

    env_path = Path(env_home).expanduser()
    if env_path.parent.name == "profiles":
        return env_path.parent.parent
    try:
        env_path.resolve().relative_to(home_root.resolve())
        return home_root
    except Exception:
        return env_path


def active_profile_name(root: Path) -> str:
    active_path = root / "active_profile"
    try:
        value = active_path.read_text(encoding="utf-8").strip()
        return value or "default"
    except OSError:
        return "default"


def write_active_profile(root: Path, name: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "active_profile").write_text(name, encoding="utf-8")


def profile_dir(root: Path, name: str) -> Path:
    return root if name == "default" else root / "profiles" / name


def safe_profile_name(value: str) -> str:
    name = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", name):
        raise ValueError("Profile names may use letters, numbers, dots, dashes, and underscores.")
    return name


def profile_scaffold(directory: Path) -> None:
    (directory / "memories").mkdir(parents=True, exist_ok=True)
    (directory / "skills").mkdir(parents=True, exist_ok=True)


def clone_ignore(source_name: str):
    if source_name != "default":
        return None

    def ignore(_directory: str, names: list[str]) -> set[str]:
        skipped = {"profiles", "active_profile", "gateway.pid", "gateway.lock"}
        return {name for name in names if name in skipped}

    return ignore


def discover_profiles(root: Path) -> list[dict[str, Any]]:
    active = active_profile_name(root)
    names = ["default"]
    profiles_root = root / "profiles"
    if profiles_root.is_dir():
        for entry in sorted(profiles_root.iterdir()):
            if entry.is_dir() and not entry.name.startswith("."):
                names.append(entry.name)

    summaries = [profile_summary(root, name, name == active) for name in names]
    if active not in names:
        summaries.append(profile_summary(root, active, True))
    return summaries


def profile_summary(root: Path, name: str, is_active: bool) -> dict[str, Any]:
    directory = profile_dir(root, name)
    config = read_config(directory / "config.yaml")
    model = model_summary(config)
    memory_stats = memory_file_stats(directory)

    return {
        "name": name,
        "path": str(directory),
        "active": is_active,
        "exists": directory.is_dir(),
        "model": model.get("model") or "not configured",
        "provider": model.get("provider") or "not configured",
        "memoryBytes": memory_stats["bytes"],
        "memoryUpdatedAt": memory_stats["updatedAt"],
        "skillCount": count_skills(directory / "skills"),
        "sessionCount": 0,
        "estimatedCostUsd": None,
        "gatewayRunning": gateway_running(directory),
    }


def read_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}

    text = safe_read(path)
    if not text:
        return {}

    try:
        import yaml  # type: ignore

        loaded = yaml.safe_load(text)
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return naive_yaml_subset(text)


def naive_yaml_subset(text: str) -> dict[str, Any]:
    config: dict[str, Any] = {}
    current: str | None = None
    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        line = raw_line.strip()
        if indent == 0 and ":" in line:
            key, value = line.split(":", 1)
            current = key.strip()
            config[current] = value.strip().strip("\"'") if value.strip() else {}
        elif current and ":" in line and isinstance(config.get(current), dict):
            key, value = line.split(":", 1)
            config[current][key.strip()] = value.strip().strip("\"'")
    return config


def model_summary(config: dict[str, Any]) -> dict[str, str]:
    model_config = config.get("model") if isinstance(config.get("model"), dict) else {}
    provider = str(model_config.get("provider") or config.get("provider") or "")
    model = str(model_config.get("model") or model_config.get("name") or config.get("model") or "")
    if isinstance(config.get("model"), str):
        model = str(config.get("model") or "")
    return {"provider": provider, "model": model}


def memory_file_stats(directory: Path) -> dict[str, Any]:
    total = 0
    updated_at = None
    for name in ("MEMORY.md", "USER.md"):
        path = directory / "memories" / name
        if path.exists():
            try:
                stat = path.stat()
                total += stat.st_size
                updated_at = max(updated_at or 0, stat.st_mtime)
            except OSError:
                pass
    return {"bytes": total, "updatedAt": int(updated_at) if updated_at else None}


def conversations(payload: dict[str, Any]) -> dict[str, Any]:
    selected = profile_name_from_payload(payload)
    limit = bounded_int(payload.get("limit"), default=80, minimum=1, maximum=200)
    path = (
        f"/profiles/{urllib.parse.quote(selected, safe='')}/conversations"
        f"?{urllib.parse.urlencode({'limit': limit})}"
    )
    result = management_get(payload, path, timeout=8)
    if not result.get("ok"):
        return {
            "ok": False,
            "profile": selected,
            "path": management_endpoint(management_base_url(payload), path),
            "source": "hermes-management",
            "schemaVersion": None,
            "conversations": [],
            "error": result.get("error") or "Could not load conversations from the management API.",
        }
    rows = result.get("conversations") if isinstance(result.get("conversations"), list) else []
    schema_version = number_or_none(result.get("schemaVersion"))
    return {
        "ok": True,
        "profile": str(result.get("profile") or selected),
        "path": str(result.get("path") or ""),
        "source": "hermes-management",
        "schemaVersion": int(schema_version) if schema_version is not None else None,
        "conversations": [
            normalize_management_conversation(item)
            for item in rows
            if isinstance(item, dict)
        ],
        "warning": result.get("warning"),
    }


def conversation_detail(payload: dict[str, Any]) -> dict[str, Any]:
    conversation_id = str(payload.get("conversationId") or payload.get("sessionId") or "").strip()
    if not conversation_id:
        return {"ok": False, "error": "conversationId is required.", "conversation": None, "messages": []}

    management_result = fetch_management_conversation_detail(payload, conversation_id)
    if management_result.get("ok"):
        return management_result

    if conversation_id.startswith("resp_"):
        api_result = fetch_api_response_detail(payload, conversation_id)
        if api_result.get("ok"):
            return api_result

    return {
        "ok": False,
        "profile": profile_name_from_payload(payload),
        "path": management_base_url(payload),
        "source": "hermes-management",
        "error": "Conversation history is not available from the selected route.",
        "conversation": None,
        "messages": [],
    }


def jobs_list(payload: dict[str, Any]) -> dict[str, Any]:
    return jobs_request(payload, "/api/jobs", method="GET")


def jobs_create(payload: dict[str, Any]) -> dict[str, Any]:
    body = payload.get("job") if isinstance(payload.get("job"), dict) else payload
    return jobs_request(payload, "/api/jobs", method="POST", body=job_create_body(body))


def jobs_update(payload: dict[str, Any]) -> dict[str, Any]:
    job_id = required_identifier(payload, "jobId")
    body = payload.get("job") if isinstance(payload.get("job"), dict) else {}
    return jobs_request(payload, f"/api/jobs/{urllib.parse.quote(job_id, safe='')}", method="PATCH", body=body)


def jobs_delete(payload: dict[str, Any]) -> dict[str, Any]:
    job_id = required_identifier(payload, "jobId")
    return jobs_request(payload, f"/api/jobs/{urllib.parse.quote(job_id, safe='')}", method="DELETE")


def jobs_pause(payload: dict[str, Any]) -> dict[str, Any]:
    return jobs_control_request(payload, "pause")


def jobs_resume(payload: dict[str, Any]) -> dict[str, Any]:
    return jobs_control_request(payload, "resume")


def jobs_run(payload: dict[str, Any]) -> dict[str, Any]:
    return jobs_control_request(payload, "run")


def jobs_control_request(payload: dict[str, Any], action: str) -> dict[str, Any]:
    job_id = required_identifier(payload, "jobId")
    return jobs_request(payload, f"/api/jobs/{urllib.parse.quote(job_id, safe='')}/{action}", method="POST", body={})


def inbox_messages(payload: dict[str, Any]) -> dict[str, Any]:
    after = bounded_int(payload.get("after"), default=0, minimum=0, maximum=2_000_000_000)
    limit = bounded_int(payload.get("limit"), default=50, minimum=1, maximum=200)
    query = {"after": after, "limit": limit}
    selected = str(payload.get("profile") or "").strip()
    if selected:
        query["profile"] = selected
    path = f"/inbox/messages?{urllib.parse.urlencode(query)}"
    result = management_get(payload, path, timeout=8)
    if not result.get("ok"):
        return {"ok": False, "messages": [], "cursor": after, "error": result.get("error") or "Could not load inbox messages."}
    return {
        "ok": True,
        "messages": result.get("messages") if isinstance(result.get("messages"), list) else [],
        "cursor": int(number_or_none(result.get("cursor")) or after),
    }


def inbox_ack(payload: dict[str, Any]) -> dict[str, Any]:
    message_id = required_identifier(payload, "messageId")
    return management_request(
        payload,
        f"/inbox/messages/{urllib.parse.quote(message_id, safe='')}/ack",
        method="POST",
        body={},
        timeout=8,
    )


def core_request(payload: dict[str, Any]) -> dict[str, Any]:
    method = str(payload.get("method") or "GET").upper()
    if method not in {"GET", "POST", "PATCH", "DELETE"}:
        return {"ok": False, "error": "Unsupported Core request method."}
    path = str(payload.get("path") or "").strip()
    if not path.startswith("/"):
        path = f"/{path}"
    if not path or path == "/":
        return {"ok": False, "error": "Core request path is required."}
    body = payload.get("body") if isinstance(payload.get("body"), dict) else None
    return management_request(payload, path, method=method, body=body, timeout=12)


def jobs_request(
    payload: dict[str, Any],
    path: str,
    *,
    method: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    url = gateway_endpoint(payload, path)
    result = (
        http_get_json(url, payload, timeout=8, token_kind="hermes")
        if method == "GET"
        else http_json_request(url, payload, method=method, body=body, timeout=8, token_kind="hermes")
    )
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


def gateway_endpoint(payload: dict[str, Any], path: str) -> str:
    base = bridge_config(payload)["gatewayUrl"].rstrip("/")
    return f"{base}{path if path.startswith('/') else f'/{path}'}"


def job_create_body(payload: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {}
    for key in ("name", "schedule", "prompt", "deliver", "repeat"):
        value = payload.get(key)
        if value not in (None, ""):
            body[key] = value
    skills = payload.get("skills")
    if isinstance(skills, list):
        body["skills"] = [str(item) for item in skills if str(item).strip()]
    return body


def required_identifier(payload: dict[str, Any], key: str) -> str:
    value = str(payload.get(key) or payload.get(key.replace("Id", "_id")) or "").strip()
    if not value:
        raise ValueError(f"{key} is required.")
    return value

def profile_name_from_payload(payload: dict[str, Any]) -> str:
    return str(payload.get("profile") or "default")


def conversation_summary(row: dict[str, Any]) -> dict[str, Any]:
    preview = compact_text(message_content_text(row.get("preview") or ""), 160)
    title = compact_text(str(row.get("title") or ""), 80)
    return {
        "id": str(row.get("id") or ""),
        "source": str(row.get("source") or ""),
        "model": str(row.get("model") or ""),
        "title": title or preview or "Untitled session",
        "preview": preview,
        "chatId": str(row.get("chatId") or row.get("chat_id") or ""),
        "origin": row.get("origin") if isinstance(row.get("origin"), dict) else {},
        "startedAt": number_or_none(row.get("started_at")),
        "endedAt": number_or_none(row.get("ended_at")),
        "lastActiveAt": number_or_none(row.get("last_active")) or number_or_none(row.get("ended_at")) or number_or_none(row.get("started_at")),
        "messageCount": int(row.get("message_count") or 0),
    }


def normalize_management_conversation(row: dict[str, Any]) -> dict[str, Any]:
    preview = compact_text(message_content_text(row.get("preview") or ""), 180)
    title = compact_text(str(row.get("title") or ""), 90)
    started_at = number_or_none(row.get("startedAt") if "startedAt" in row else row.get("started_at"))
    ended_at = number_or_none(row.get("endedAt") if "endedAt" in row else row.get("ended_at"))
    last_active_at = number_or_none(row.get("lastActiveAt") if "lastActiveAt" in row else row.get("last_active"))
    try:
        message_count = int(row.get("messageCount") if "messageCount" in row else row.get("message_count") or 0)
    except (TypeError, ValueError):
        message_count = 0
    return {
        "id": str(row.get("id") or ""),
        "source": str(row.get("source") or "hermes-management"),
        "model": str(row.get("model") or ""),
        "title": title or preview or "Untitled session",
        "preview": preview,
        "chatId": str(row.get("chatId") or row.get("chat_id") or ""),
        "origin": row.get("origin") if isinstance(row.get("origin"), dict) else {},
        "startedAt": started_at,
        "endedAt": ended_at,
        "lastActiveAt": last_active_at or ended_at or started_at,
        "messageCount": message_count,
    }


def safe_message_role(value: Any) -> str:
    role = str(value or "assistant")
    return role if role in {"system", "user", "assistant", "tool"} else "assistant"


def message_content_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
        stripped = text.strip()
        if stripped.startswith("[") or stripped.startswith("{"):
            try:
                return message_content_text(json.loads(stripped))
            except Exception:
                return text
        return text
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if item.get("type") in {"text", "input_text", "output_text"}:
                    parts.append(str(item.get("text") or ""))
                elif item.get("type") in {"image_url", "input_image"}:
                    parts.append("[image]")
                else:
                    parts.append(json.dumps(item, ensure_ascii=False))
        return "\n".join(part for part in parts if part)
    if isinstance(value, dict):
        if value.get("type") in {"text", "input_text", "output_text"}:
            return str(value.get("text") or "")
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def compact_text(value: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", value).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def number_or_none(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def bounded_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return min(max(number, minimum), maximum)


def count_skills(skills_dir: Path) -> int:
    if not skills_dir.is_dir():
        return 0
    return sum(1 for _ in skills_dir.rglob("SKILL.md"))


def gateway_running(directory: Path) -> bool:
    pid_path = directory / "gateway.pid"
    try:
        pid = int(pid_path.read_text(encoding="utf-8").strip())
    except Exception:
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def bridge_config(payload: dict[str, Any]) -> dict[str, str]:
    runtime = payload.get("runtime") if isinstance(payload.get("runtime"), dict) else {}
    mode = str(runtime.get("connectionMode") or payload.get("connectionMode") or "local")
    custom_path = str(runtime.get("customHermesPath") or payload.get("hermesPath") or "").strip()
    remote_url = str(runtime.get("remoteUrl") or payload.get("remoteUrl") or "").strip()
    gateway_url = str(runtime.get("gatewayUrl") or payload.get("gatewayUrl") or DEFAULT_GATEWAY_URL).strip()
    normalized_mode = "remote" if mode == "remote" else "local"
    profile = profile_name_from_payload(payload)
    profile_api_url = profile_url_from_runtime(runtime, "profileApiUrls", profile)
    sidecar_url = (
        profile_url_from_runtime(runtime, "profileSidecarUrls", profile)
        or str(
            runtime.get("managementApiUrl")
            or runtime.get("managementUrl")
            or payload.get("managementApiUrl")
            or payload.get("managementUrl")
            or DEFAULT_MANAGEMENT_URL
        ).strip()
    )
    return {
        "connectionMode": normalized_mode,
        "customHermesPath": custom_path,
        "remoteUrl": remote_url,
        "gatewayUrl": gateway_url or DEFAULT_GATEWAY_URL,
        "managementApiUrl": sidecar_url or DEFAULT_MANAGEMENT_URL,
        "profileApiUrl": profile_api_url,
        "apiUrl": profile_api_url,
    }


def profile_url_from_runtime(runtime: dict[str, Any], key: str, profile: str) -> str:
    routes = runtime.get(key) if isinstance(runtime.get(key), dict) else {}
    value = routes.get(profile) if isinstance(routes, dict) else ""
    return str(value or "").strip()


def management_base_url(payload: dict[str, Any]) -> str:
    return bridge_config(payload)["managementApiUrl"]


def management_endpoint(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    if not base.endswith("/v1"):
        base = f"{base}/v1"
    return f"{base}{path if path.startswith('/') else f'/{path}'}"


def http_get_json(url: str, payload: dict[str, Any], *, timeout: int = 8, token_kind: str = "hermes") -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers=http_headers(payload, token_kind),
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8", errors="replace")
            status_code = response.status
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return {
            "ok": False,
            "url": url,
            "status": exc.code,
            "error": api_error_text(text) or f"HTTP {exc.code}",
        }
    except Exception as exc:
        return {"ok": False, "url": url, "error": str(exc)}

    try:
        parsed = json.loads(text) if text else {}
    except json.JSONDecodeError as exc:
        return {"ok": False, "url": url, "status": status_code, "error": f"Invalid JSON: {exc}"}
    if not isinstance(parsed, dict):
        return {"ok": False, "url": url, "status": status_code, "error": "Expected a JSON object."}
    return {"ok": True, "url": url, "status": status_code, "json": parsed}


def http_json_request(
    url: str,
    payload: dict[str, Any],
    *,
    method: str,
    body: dict[str, Any] | None = None,
    timeout: int = 8,
    token_kind: str = "hermes",
) -> dict[str, Any]:
    data = json.dumps(body or {}).encode("utf-8") if body is not None else None
    headers = http_headers(payload, token_kind)
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8", errors="replace")
            status_code = response.status
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return {
            "ok": False,
            "url": url,
            "status": exc.code,
            "error": api_error_text(text) or f"HTTP {exc.code}",
        }
    except Exception as exc:
        return {"ok": False, "url": url, "error": str(exc)}

    try:
        parsed = json.loads(text) if text else {}
    except json.JSONDecodeError as exc:
        return {"ok": False, "url": url, "status": status_code, "error": f"Invalid JSON: {exc}"}
    if not isinstance(parsed, dict):
        return {"ok": False, "url": url, "status": status_code, "error": "Expected a JSON object."}
    return {"ok": True, "url": url, "status": status_code, "json": parsed}


def management_get(payload: dict[str, Any], path: str, *, timeout: int = 8) -> dict[str, Any]:
    return management_request(payload, path, method="GET", timeout=timeout)


def management_request(
    payload: dict[str, Any],
    path: str,
    *,
    method: str,
    body: dict[str, Any] | None = None,
    timeout: int = 8,
) -> dict[str, Any]:
    url = management_endpoint(management_base_url(payload), path)
    result = (
        http_get_json(url, payload, timeout=timeout, token_kind="sidecar")
        if method == "GET"
        else http_json_request(url, payload, method=method, body=body, timeout=timeout, token_kind="sidecar")
    )
    if not result.get("ok"):
        return {
            "ok": False,
            "url": result.get("url") or url,
            "status": result.get("status"),
            "error": result.get("error") or "Management API request failed.",
        }
    parsed = result.get("json") if isinstance(result.get("json"), dict) else {}
    if parsed.get("ok") is False:
        return {
            **parsed,
            "url": result.get("url") or url,
            "status": result.get("status"),
            "error": parsed.get("error") or "Management API request failed.",
        }
    return {**parsed, "ok": True, "url": result.get("url") or url, "status": result.get("status")}


def should_fallback_to_local_profile_action(payload: dict[str, Any], result: dict[str, Any]) -> bool:
    if result.get("ok") or result.get("status") is not None:
        return False
    config = bridge_config(payload)
    return (
        config["connectionMode"] == "local"
        and server_base_url(config["managementApiUrl"]) == server_base_url(DEFAULT_MANAGEMENT_URL)
    )


def endpoint_status(result: dict[str, Any], fallback_url: str = "") -> dict[str, Any]:
    return {
        "ok": bool(result.get("ok")),
        "url": str(result.get("url") or fallback_url or ""),
        "status": result.get("status"),
        "body": "",
        "error": str(result.get("error") or "") if not result.get("ok") else "",
    }


def normalize_management_profile(row: dict[str, Any], active_name: str) -> dict[str, Any]:
    name = str(row.get("name") or "default")
    source = str(row.get("source") or "installed")
    if source not in {"installed", "bundled", "community"}:
        source = "installed"
    return {
        "name": name,
        "path": str(row.get("path") or ""),
        "active": bool(row.get("active")) or name == active_name,
        "exists": bool(row.get("exists")),
        "model": str(row.get("model") or "not configured"),
        "provider": str(row.get("provider") or "not configured"),
        "memoryBytes": int(row.get("memoryBytes") or 0),
        "memoryUpdatedAt": number_or_none(row.get("memoryUpdatedAt")),
        "skillCount": int(row.get("skillCount") or 0),
        "sessionCount": int(row.get("sessionCount") or 0),
        "estimatedCostUsd": number_or_none(row.get("estimatedCostUsd")),
        "gatewayRunning": bool(row.get("gatewayRunning")),
    }


def offline_profile_summary(name: str) -> dict[str, Any]:
    return {
        "name": name or "default",
        "path": "",
        "active": True,
        "exists": False,
        "model": "not configured",
        "provider": "not configured",
        "memoryBytes": 0,
        "memoryUpdatedAt": None,
        "skillCount": 0,
        "sessionCount": 0,
        "estimatedCostUsd": None,
        "gatewayRunning": False,
    }


def http_probe(url: str, payload: dict[str, Any] | None = None, *, token_kind: str = "hermes") -> dict[str, Any]:
    if not url:
        return {"ok": False, "error": "No URL configured."}
    payload = payload or {}
    base = server_base_url(url)
    for suffix in ("/health", "/status", ""):
        try:
            request = urllib.request.Request(
                base + suffix,
                headers=http_headers(payload, token_kind),
                method="GET",
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                body = response.read(3000).decode("utf-8", errors="replace")
                return {"ok": True, "url": base, "status": response.status, "body": body}
        except Exception as exc:
            last_error = str(exc)
    return {"ok": False, "url": base, "error": last_error}


def server_base_url(url: str) -> str:
    base = url.rstrip("/")
    if base.endswith("/v1"):
        return base[:-3]
    return base


def status(payload: dict[str, Any]) -> dict[str, Any]:
    config = bridge_config(payload)
    selected = profile_name_from_payload(payload)
    management_status = management_get(payload, "/status", timeout=5)
    profiles_result = management_get(payload, "/profiles", timeout=8)
    active_name = str(
        profiles_result.get("activeProfile")
        or management_status.get("activeProfile")
        or selected
        or "default"
    )
    raw_profiles = profiles_result.get("profiles") if isinstance(profiles_result.get("profiles"), list) else []
    found_profiles = [
        normalize_management_profile(item, active_name)
        for item in raw_profiles
        if isinstance(item, dict)
    ]
    if not found_profiles:
        found_profiles = [offline_profile_summary(selected or active_name)]
    active = (
        next((item for item in found_profiles if item["name"] == selected), None)
        or next((item for item in found_profiles if item["active"]), None)
        or found_profiles[0]
    )
    active_api = http_probe(config["apiUrl"], payload)

    connected = bool(active_api.get("ok"))

    return {
        "ok": True,
        "connected": connected,
        "root": str(profiles_result.get("hermesHome") or management_status.get("hermesHome") or ""),
        "hermesPath": None,
        "hermesPathSource": None,
        "hermesPathCandidates": [],
        "version": None,
        "activeProfile": active,
        "profiles": found_profiles,
        "checkedAt": int(time.time()),
        "connectionMode": config["connectionMode"],
        "remoteUrl": config["remoteUrl"],
        "gatewayUrl": config["gatewayUrl"],
        "managementApiUrl": config["managementApiUrl"],
        "activeApiUrl": config["apiUrl"],
        "gatewayStatus": {"ok": False},
        "remoteStatus": {"ok": False},
        "activeApiStatus": active_api,
        "managementStatus": endpoint_status(management_status, management_endpoint(config["managementApiUrl"], "/status")),
        "error": None if profiles_result.get("ok") else profiles_result.get("error"),
    }


def profiles(payload: dict[str, Any]) -> dict[str, Any]:
    result = management_get(payload, "/profiles", timeout=8)
    if not result.get("ok"):
        return {
            "ok": False,
            "root": "",
            "profiles": [],
            "error": result.get("error") or "Could not load profiles from the management API.",
        }
    active_name = str(result.get("activeProfile") or profile_name_from_payload(payload))
    rows = result.get("profiles") if isinstance(result.get("profiles"), list) else []
    return {
        "ok": True,
        "root": str(result.get("hermesHome") or ""),
        "profiles": [
            normalize_management_profile(item, active_name)
            for item in rows
            if isinstance(item, dict)
        ],
    }


def memory(payload: dict[str, Any]) -> dict[str, Any]:
    selected = profile_name_from_payload(payload)
    result = management_get(payload, f"/profiles/{urllib.parse.quote(selected, safe='')}/memory", timeout=8)
    if not result.get("ok"):
        return {
            "ok": False,
            "profile": selected,
            "path": "",
            "memory": empty_file_payload("MEMORY.md"),
            "user": empty_file_payload("USER.md"),
            "history": [],
            "error": result.get("error") or "Could not load memory from the management API.",
        }
    return {
        "ok": True,
        "profile": selected,
        "path": str(result.get("path") or ""),
        "memory": normalize_file_payload(result.get("memory"), "MEMORY.md"),
        "user": normalize_file_payload(result.get("user"), "USER.md"),
        "history": [],
    }


def memory_save(payload: dict[str, Any]) -> dict[str, Any]:
    root = hermes_root()
    selected = str(payload.get("profile") or active_profile_name(root))
    directory = profile_dir(root, selected)
    path = memory_file_path(directory, str(payload.get("file") or ""))
    expected = payload.get("expectedUpdatedAt")

    current_updated_at = file_payload(path)["updatedAt"]
    if expected is not None and current_updated_at != expected:
        return {
            "ok": False,
            "error": "Memory changed on disk. Refresh before saving so you do not overwrite newer notes.",
        }

    if path.exists():
        append_memory_history(directory, path, "save")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(payload.get("content") or ""), encoding="utf-8")
    return {"ok": True, "profile": selected, "memory": memory({"profile": selected})}


def memory_reset(payload: dict[str, Any]) -> dict[str, Any]:
    confirm = str(payload.get("confirm") or "")
    if confirm != "RESET MEMORY":
        return {"ok": False, "error": "Type RESET MEMORY to confirm destructive memory reset."}

    root = hermes_root()
    selected = str(payload.get("profile") or active_profile_name(root))
    directory = profile_dir(root, selected)
    target = str(payload.get("file") or "")
    files = ["memory", "user"] if target == "all" else [target]

    for file_key in files:
        path = memory_file_path(directory, file_key)
        if path.exists():
            append_memory_history(directory, path, "reset")
            path.unlink()
    return {"ok": True, "profile": selected, "memory": memory({"profile": selected})}


def memory_file_path(directory: Path, file_key: str) -> Path:
    normalized = file_key.strip().lower()
    if normalized in {"memory", "memory.md"}:
        return directory / "memories" / "MEMORY.md"
    if normalized in {"user", "user.md"}:
        return directory / "memories" / "USER.md"
    raise ValueError("Memory writes are limited to MEMORY.md and USER.md.")


def memory_history_path(directory: Path) -> Path:
    return directory / "memories" / ".history.json"


def read_memory_history(directory: Path) -> list[dict[str, Any]]:
    path = memory_history_path(directory)
    if not path.exists():
        return []
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, list):
            return loaded[:30]
    except Exception:
        pass
    return []


def append_memory_history(directory: Path, path: Path, action: str) -> None:
    content = safe_read(path)
    stat = path.stat()
    entry = {
        "id": f"{int(time.time())}-{path.name}-{stat.st_size}",
        "file": path.name,
        "action": action,
        "updatedAt": int(stat.st_mtime),
        "bytes": stat.st_size,
        "summary": first_memory_line(content) or "Empty memory file",
        "content": content,
    }
    history = [entry, *read_memory_history(directory)][:30]
    destination = memory_history_path(directory)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")


def first_memory_line(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip().lstrip("#").strip()
        if stripped:
            return stripped[:180]
    return ""


def file_payload(path: Path) -> dict[str, Any]:
    text = safe_read(path)
    updated_at = None
    bytes_count = 0
    if path.exists():
        try:
            stat = path.stat()
            updated_at = int(stat.st_mtime)
            bytes_count = stat.st_size
        except OSError:
            pass
    return {
        "name": path.name,
        "path": str(path),
        "exists": path.exists(),
        "updatedAt": updated_at,
        "bytes": bytes_count,
        "content": text,
    }


def empty_file_payload(name: str) -> dict[str, Any]:
    return {
        "name": name,
        "path": "",
        "exists": False,
        "updatedAt": None,
        "bytes": 0,
        "content": "",
    }


def normalize_file_payload(value: Any, fallback_name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        return empty_file_payload(fallback_name)
    return {
        "name": str(value.get("name") or fallback_name),
        "path": str(value.get("path") or ""),
        "exists": bool(value.get("exists")),
        "updatedAt": number_or_none(value.get("updatedAt")),
        "bytes": int(value.get("bytes") or 0),
        "content": str(value.get("content") or ""),
    }


def normalize_skill_payload(value: dict[str, Any]) -> dict[str, Any]:
    source = str(value.get("source") or "installed")
    if source not in {"installed", "bundled", "community"}:
        source = "installed"
    metadata = value.get("metadata") if isinstance(value.get("metadata"), dict) else {}
    tags = value.get("tags") if isinstance(value.get("tags"), list) else []
    return {
        "id": str(value.get("id") or ""),
        "name": str(value.get("name") or "Untitled skill"),
        "path": str(value.get("path") or value.get("id") or ""),
        "category": str(value.get("category") or "personal"),
        "description": str(value.get("description") or "Hermes skill"),
        "updatedAt": number_or_none(value.get("updatedAt")),
        "source": source,
        "version": str(value.get("version")) if value.get("version") is not None else None,
        "tags": [str(tag) for tag in tags if str(tag)],
        "bytes": int(value.get("bytes") or 0),
        "metadata": {str(key): value for key, value in metadata.items()},
    }


def skills(payload: dict[str, Any]) -> dict[str, Any]:
    selected = profile_name_from_payload(payload)
    result = management_get(payload, f"/profiles/{urllib.parse.quote(selected, safe='')}/skills", timeout=8)
    if not result.get("ok"):
        return {
            "ok": False,
            "profile": selected,
            "path": "",
            "skills": [],
            "error": result.get("error") or "Could not load skills from the management API.",
        }
    rows = result.get("skills") if isinstance(result.get("skills"), list) else []
    return {
        "ok": True,
        "profile": selected,
        "path": str(result.get("path") or ""),
        "skills": [
            normalize_skill_payload(item)
            for item in rows
            if isinstance(item, dict)
        ],
    }


def skill_payload(path: Path, rel: Path) -> dict[str, Any]:
    text = safe_read(path)
    metadata = skill_metadata(text)
    title = metadata.get("name") or (rel.parts[-2] if len(rel.parts) > 1 else rel.stem)
    category = metadata.get("category") or (rel.parts[0] if len(rel.parts) > 1 else "personal")
    stat = path.stat() if path.exists() else None
    return {
        "name": title,
        "path": str(path),
        "category": category,
        "description": metadata.get("description") or first_markdown_paragraph(text) or "Local Hermes skill",
        "updatedAt": int(stat.st_mtime) if stat else None,
        "source": skill_source(rel, metadata),
        "version": metadata.get("version"),
        "tags": skill_tags(metadata),
        "bytes": stat.st_size if stat else 0,
        "metadata": metadata,
    }


def skill_detail(payload: dict[str, Any]) -> dict[str, Any]:
    selected = profile_name_from_payload(payload)
    skill_id = str(payload.get("skillId") or payload.get("id") or payload.get("path") or "").strip()
    if not skill_id:
        return {"ok": False, "profile": selected, "error": "skillId is required."}
    result = management_get(
        payload,
        f"/profiles/{urllib.parse.quote(selected, safe='')}/skills/{urllib.parse.quote(skill_id, safe='')}",
        timeout=8,
    )
    if not result.get("ok"):
        return {
            "ok": False,
            "profile": selected,
            "error": result.get("error") or "Could not load skill from the management API.",
        }
    detail = normalize_skill_payload(result)
    detail["content"] = str(result.get("content") or "")
    detail["history"] = []
    return {"ok": True, "profile": selected, **detail}


def skill_save(payload: dict[str, Any]) -> dict[str, Any]:
    root = hermes_root()
    selected = str(payload.get("profile") or active_profile_name(root))
    directory = profile_dir(root, selected)
    skill_dir = directory / "skills"
    skill_dir.mkdir(parents=True, exist_ok=True)

    existing_path = str(payload.get("path") or "").strip()
    if existing_path:
        path = safe_skill_path(skill_dir, existing_path)
    else:
        category = safe_skill_segment(str(payload.get("category") or "personal"), "personal")
        name = safe_skill_segment(str(payload.get("name") or "untitled-skill"), "untitled-skill")
        path = skill_dir / category / name / "SKILL.md"

    content = str(payload.get("content") or "").strip()
    rel = path.resolve().relative_to(skill_dir.resolve())
    if not content:
        content = default_skill_content(
            str(payload.get("name") or path.parent.name),
            str(payload.get("category") or (rel.parts[0] if len(rel.parts) > 1 else "personal")),
        )

    if path.exists():
        append_skill_history(skill_dir, rel, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content + "\n", encoding="utf-8")

    detail = skill_payload(path, rel)
    detail["content"] = safe_read(path)
    detail["history"] = read_skill_history(skill_dir, rel)
    return {"ok": True, "profile": selected, "skill": detail}


def safe_skill_path(skill_dir: Path, value: str) -> Path:
    if not value.strip():
        raise ValueError("Skill path is required.")
    base = skill_dir.resolve()
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = skill_dir / path
    resolved = path.resolve()
    try:
        resolved.relative_to(base)
    except ValueError:
        raise ValueError("Skill path must stay inside the active profile skills directory.")
    if resolved.name != "SKILL.md":
        raise ValueError("Skill editor can only write SKILL.md files.")
    return resolved


def skill_metadata(text: str) -> dict[str, str]:
    metadata: dict[str, str] = {}
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        for line in lines[1:]:
            if line.strip() == "---":
                break
            if ":" in line:
                key, value = line.split(":", 1)
                metadata[key.strip().lower()] = value.strip().strip("\"'")

    for line in lines[:50]:
        stripped = line.strip()
        lowered = stripped.lower()
        if lowered.startswith("# ") and "name" not in metadata:
            metadata["name"] = stripped.lstrip("#").strip()
        elif ":" in stripped:
            key, value = stripped.split(":", 1)
            key = key.strip().lower()
            if key in {"name", "description", "category", "version", "tags", "author"}:
                metadata.setdefault(key, value.strip().strip("\"'"))
    return metadata


def skill_tags(metadata: dict[str, str]) -> list[str]:
    value = metadata.get("tags") or ""
    value = value.strip().strip("[]")
    return [
        tag.strip().strip("\"'")
        for tag in re.split(r"[,;]", value)
        if tag.strip().strip("\"'")
    ]


def first_markdown_paragraph(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "---")) or ":" in stripped[:24]:
            continue
        return stripped[:180]
    return ""


def skill_source(rel: Path, metadata: dict[str, str]) -> str:
    source = (metadata.get("source") or "").lower()
    if source in {"installed", "bundled", "community"}:
        return source
    parts = {part.lower() for part in rel.parts}
    if parts & {"bundled", "system", ".system"}:
        return "bundled"
    if parts & {"community", "hub", "store"}:
        return "community"
    return "installed"


def safe_skill_segment(value: str, fallback: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip().lower()).strip("-._")
    return slug[:64] or fallback


def default_skill_content(name: str, category: str) -> str:
    clean_name = name.strip() or "Untitled skill"
    clean_category = category.strip() or "personal"
    return f"""---
name: {clean_name}
description: Describe when Iris should use this skill.
category: {clean_category}
version: 0.1.0
tags: []
---

# {clean_name}

Use this skill when...

## Workflow

1. Capture the user's goal and constraints.
2. Inspect the relevant files, tools, or context.
3. Execute the workflow and report the outcome.
"""


def history_path(skill_dir: Path, rel: Path) -> Path:
    slug = "__".join(rel.with_suffix("").parts)
    return skill_dir / ".history" / f"{slug}.json"


def read_skill_history(skill_dir: Path, rel: Path) -> list[dict[str, Any]]:
    path = history_path(skill_dir, rel)
    if not path.exists():
        return []
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, list) else []
    except Exception:
        return []


def append_skill_history(skill_dir: Path, rel: Path, path: Path) -> None:
    metadata = skill_metadata(safe_read(path))
    stat = path.stat()
    entry = {
        "version": metadata.get("version") or f"saved-{int(time.time())}",
        "updatedAt": int(stat.st_mtime),
        "summary": metadata.get("description") or "Previous saved revision",
        "bytes": stat.st_size,
    }
    history = [entry, *read_skill_history(skill_dir, rel)][:12]
    destination = history_path(skill_dir, rel)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")


def send_message(payload: dict[str, Any]) -> dict[str, Any]:
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        return {"ok": False, "error": "Prompt is empty."}

    return send_http_message(api_base_url(payload), payload)


def gateway_message(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("text") or payload.get("prompt") or "").strip()
    if not text:
        return {"ok": False, "error": "Message text is empty."}

    chat_id = str(payload.get("chatId") or payload.get("chat_id") or "desktop").strip()
    if not chat_id:
        return {"ok": False, "error": "chatId is required."}

    message_id = str(payload.get("messageId") or payload.get("message_id") or "").strip() or f"agentui-{int(time.time() * 1000)}"
    selected = profile_name_from_payload(payload)
    body = {
        "chatId": chat_id,
        "chatName": str(payload.get("chatName") or payload.get("chat_name") or chat_id).strip(),
        "profile": selected,
        "userId": str(payload.get("userId") or payload.get("user_id") or "agentui-user").strip(),
        "userName": str(payload.get("userName") or payload.get("user_name") or "Iris User").strip(),
        "messageId": message_id,
        "text": text,
    }
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    if metadata:
        body["metadata"] = {str(key): value for key, value in metadata.items()}
    url = agentui_gateway_endpoint(payload, "/agentui/messages")
    token = agentui_platform_token(payload)
    if not token:
        return {"ok": False, "error": "IRIS_TOKEN or AGENTUI_TOKEN is required for Iris gateway chat."}

    result = http_json_request(
        url,
        {"agentuiToken": token},
        method="POST",
        body=body,
        timeout=8,
        token_kind="agentui",
    )
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
    return {**parsed, "ok": True, "profile": str(parsed.get("profile") or selected), "url": result.get("url") or url, "status": result.get("status")}


def models(payload: dict[str, Any]) -> dict[str, Any]:
    selected = profile_name_from_payload(payload)
    query = urllib.parse.urlencode({"maxModels": int_value(payload.get("maxModels"), 100, 1, 200)})
    url = agentui_gateway_endpoint(payload, f"/agentui/models?{query}")
    token = agentui_platform_token(payload)
    if not token:
        return {
            "ok": False,
            "profile": selected,
            "current": None,
            "providers": [],
            "generatedAt": int(time.time()),
            "url": url,
            "error": "IRIS_TOKEN or AGENTUI_TOKEN is required for model catalog discovery.",
        }

    result = http_get_json(url, {"agentuiToken": token}, timeout=8, token_kind="agentui")
    if not result.get("ok"):
        return {
            "ok": False,
            "profile": selected,
            "current": None,
            "providers": [],
            "generatedAt": int(time.time()),
            "url": result.get("url") or url,
            "status": result.get("status"),
            "error": result.get("error") or "Iris model catalog is unavailable.",
        }

    parsed = result.get("json") if isinstance(result.get("json"), dict) else {}
    providers = [
        normalize_model_provider(row)
        for row in (parsed.get("providers") if isinstance(parsed.get("providers"), list) else [])
        if isinstance(row, dict)
    ]
    current = normalize_model_selection(parsed.get("current"))
    return {
        "ok": bool(parsed.get("ok", True)),
        "profile": str(parsed.get("profile") or selected),
        "current": current,
        "providers": providers,
        "generatedAt": int_value(parsed.get("generatedAt") or parsed.get("generated_at"), int(time.time()), 0, 4_102_444_800),
        "url": result.get("url") or url,
        "status": result.get("status"),
        **({"error": str(parsed.get("error"))} if parsed.get("error") else {}),
    }


def slash_commands(payload: dict[str, Any]) -> dict[str, Any]:
    selected = profile_name_from_payload(payload)
    url = agentui_gateway_endpoint(payload, "/agentui/slash-commands")
    token = agentui_platform_token(payload)
    if not token:
        return {
            "ok": False,
            "profile": selected,
            "commands": [],
            "generatedAt": int(time.time()),
            "url": url,
            "error": "IRIS_TOKEN or AGENTUI_TOKEN is required for slash command discovery.",
        }

    result = http_get_json(url, {"agentuiToken": token}, timeout=8, token_kind="agentui")
    if not result.get("ok"):
        return {
            "ok": False,
            "profile": selected,
            "commands": [],
            "generatedAt": int(time.time()),
            "url": result.get("url") or url,
            "status": result.get("status"),
            "error": result.get("error") or "Iris slash command catalog is unavailable.",
        }

    parsed = result.get("json") if isinstance(result.get("json"), dict) else {}
    commands = [
        normalize_slash_command(row)
        for row in (parsed.get("commands") if isinstance(parsed.get("commands"), list) else [])
        if isinstance(row, dict)
    ]
    return {
        "ok": bool(parsed.get("ok", True)),
        "profile": str(parsed.get("profile") or selected),
        "commands": commands,
        "generatedAt": int_value(parsed.get("generatedAt") or parsed.get("generated_at"), int(time.time()), 0, 4_102_444_800),
        "url": result.get("url") or url,
        "status": result.get("status"),
        **({"warning": str(parsed.get("warning"))} if parsed.get("warning") else {}),
        **({"error": str(parsed.get("error"))} if parsed.get("error") else {}),
    }


def slash_complete(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("text") or "").strip()
    selected = profile_name_from_payload(payload)
    url = agentui_gateway_endpoint(payload, "/agentui/slash-complete")
    token = agentui_platform_token(payload)
    if not token:
        return {
            "ok": False,
            "items": [],
            "replaceFrom": 1,
            "url": url,
            "error": "IRIS_TOKEN or AGENTUI_TOKEN is required for slash command completion.",
        }

    result = http_json_request(
        url,
        {"agentuiToken": token},
        method="POST",
        body={"text": text, "limit": int_value(payload.get("limit"), 30, 1, 100)},
        timeout=8,
        token_kind="agentui",
    )
    if not result.get("ok"):
        return {
            "ok": False,
            "items": [],
            "replaceFrom": 1,
            "url": result.get("url") or url,
            "status": result.get("status"),
            "error": result.get("error") or "Iris slash command completion is unavailable.",
        }

    parsed = result.get("json") if isinstance(result.get("json"), dict) else {}
    items = [
        normalize_slash_completion_item(row)
        for row in (parsed.get("items") if isinstance(parsed.get("items"), list) else [])
        if isinstance(row, dict)
    ]
    return {
        "ok": bool(parsed.get("ok", True)),
        "items": items,
        "replaceFrom": int_value(parsed.get("replaceFrom") or parsed.get("replace_from"), 1, 0, len(text)),
        "url": result.get("url") or url,
        "status": result.get("status"),
        **({"error": str(parsed.get("error"))} if parsed.get("error") else {}),
        **({"profile": str(parsed.get("profile") or selected)} if parsed.get("profile") else {}),
    }


def stream_message(payload: dict[str, Any]) -> None:
    prompt = str(payload.get("prompt") or "").strip()
    request_id = str(payload.get("requestId") or "")
    if not prompt:
        emit_stream(request_id, "error", error="Prompt is empty.")
        return

    stream_http_message(api_base_url(payload), payload, request_id)


def emit_stream(request_id: str, kind: str, **payload: Any) -> None:
    emit({"ok": True, "requestId": request_id, "type": kind, **payload})


def emit_tool_stream(
    request_id: str,
    *,
    tool_name: str,
    call_id: str = "",
    status: str = "running",
    label: str = "",
    arguments: Any = None,
    output: Any = None,
) -> None:
    payload: dict[str, Any] = {
        "toolName": tool_name or "tool",
        "status": status or "running",
        "label": label or tool_progress_label(tool_name, arguments),
    }
    if call_id:
        payload["callId"] = call_id
    if arguments not in (None, ""):
        payload["arguments"] = tool_payload_text(arguments)
    if output not in (None, ""):
        payload["output"] = tool_payload_text(output)
    emit_stream(request_id, "tool", **payload)


def tool_payload_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        text = message_content_text(value)
        return text if text else json.dumps(value, ensure_ascii=False)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def tool_progress_label(tool_name: str, arguments: Any = None) -> str:
    name = str(tool_name or "tool").replace("_", " ").strip() or "tool"
    args_text = ""
    if isinstance(arguments, dict):
        if str(tool_name or "") == "skill_view" and arguments.get("name"):
            return str(arguments.get("name"))
        for key in ("command", "query", "url", "path", "file", "title"):
            if arguments.get(key):
                args_text = str(arguments.get(key))
                break
    elif isinstance(arguments, str):
        stripped = arguments.strip()
        if stripped.startswith("{"):
            try:
                return tool_progress_label(tool_name, json.loads(stripped))
            except json.JSONDecodeError:
                args_text = arguments
        else:
            args_text = arguments
    args_text = compact_text(args_text, 90) if args_text else ""
    return f"{name}: {args_text}" if args_text else name


def response_output_tool_event(event_type: str, parsed: dict[str, Any]) -> dict[str, Any] | None:
    item = parsed.get("item") if isinstance(parsed.get("item"), dict) else {}
    item_type = str(item.get("type") or "")
    if item_type == "function_call":
        call_id = str(item.get("call_id") or "")
        tool_name = str(item.get("name") or "tool")
        arguments = item.get("arguments") or ""
        status = "completed" if event_type == "response.output_item.done" else "running"
        return {
            "tool_name": tool_name,
            "call_id": call_id,
            "status": status,
            "arguments": arguments,
            "label": tool_progress_label(tool_name, arguments),
        }
    if item_type == "function_call_output" and event_type == "response.output_item.done":
        call_id = str(item.get("call_id") or "")
        output = item.get("output")
        return {
            "tool_name": "tool",
            "call_id": call_id,
            "status": str(item.get("status") or "completed"),
            "output": output,
            "label": "Tool result",
        }
    return None


def chat_tool_progress_event(parsed: dict[str, Any]) -> dict[str, Any]:
    tool_name = str(parsed.get("tool") or parsed.get("name") or "tool")
    call_id = str(parsed.get("toolCallId") or parsed.get("callId") or "")
    status = str(parsed.get("status") or "running")
    label = str(parsed.get("label") or "") or tool_progress_label(tool_name, parsed.get("arguments"))
    return {
        "tool_name": tool_name,
        "call_id": call_id,
        "status": status,
        "label": label,
        "arguments": parsed.get("arguments"),
        "output": parsed.get("output"),
    }


def send_http_message(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not url:
        return {"ok": False, "error": "Hermes API URL is not configured."}
    continue_session = session_id_from_payload(payload)
    body = chat_completion_request_body(payload, stream=False) if continue_session else response_request_body(payload, stream=False)
    data = json.dumps(body).encode("utf-8")
    headers = http_headers(payload, "hermes")
    if continue_session:
        headers["X-Hermes-Session-Id"] = continue_session
    request = urllib.request.Request(
        api_endpoint(url, "/chat/completions" if continue_session else "/responses"),
        data=data,
        headers=headers,
        method="POST",
    )
    session_id = ""
    try:
        with urllib.request.urlopen(request, timeout=int(payload.get("timeoutSeconds") or 180)) as response:
            session_id = str(response.headers.get("X-Hermes-Session-Id") or "").strip()
            text = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "error": api_error_text(text) or f"Remote Hermes returned HTTP {exc.code}."}
    except Exception as exc:
        return {"ok": False, "error": f"Could not reach Hermes API at {url}: {exc}"}

    try:
        parsed = json.loads(text)
        response_text = response_text_from_api(parsed)
    except Exception:
        response_text = text
        parsed = {}

    response_id = str(parsed.get("id") or "").strip() if isinstance(parsed, dict) else ""
    result = {
        "ok": True,
        "response": response_text.strip(),
        "profile": profile_name_from_payload(payload),
        "events": parse_response_events(response_text),
    }
    if session_id or response_id:
        result["sessionId"] = session_id or response_id
    return result


def stream_http_message(url: str, payload: dict[str, Any], request_id: str) -> None:
    if not url:
        emit_stream(request_id, "error", error="Hermes API URL is not configured.")
        return

    continue_session = session_id_from_payload(payload)
    body = chat_completion_request_body(payload, stream=True) if continue_session else response_request_body(payload, stream=True)
    headers = http_headers(payload, "hermes")
    headers["Accept"] = "text/event-stream"
    if continue_session:
        headers["X-Hermes-Session-Id"] = continue_session
    request = urllib.request.Request(
        api_endpoint(url, "/chat/completions" if continue_session else "/responses"),
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    collected: list[str] = []
    completed: dict[str, Any] | None = None
    streamed_tool_summaries: dict[str, str] = {}
    session_id = ""
    try:
        with urllib.request.urlopen(request, timeout=int(payload.get("timeoutSeconds") or 180)) as response:
            session_id = str(response.headers.get("X-Hermes-Session-Id") or "").strip()
            for event_name, data in iter_sse(response):
                if data == "[DONE]":
                    break
                try:
                    parsed = json.loads(data)
                except json.JSONDecodeError:
                    continue
                event_type = str(parsed.get("type") or parsed.get("object") or event_name or "")
                if event_type in {"response.output_text.delta", "response.text.delta"}:
                    delta = str(parsed.get("delta") or "")
                    if delta:
                        collected.append(delta)
                        emit_stream(request_id, "delta", delta=delta)
                elif event_type == "chat.completion.chunk":
                    delta = chat_completion_delta(parsed)
                    if delta:
                        collected.append(delta)
                        emit_stream(request_id, "delta", delta=delta)
                elif event_type == "hermes.tool.progress":
                    tool_event = chat_tool_progress_event(parsed)
                    emit_tool_stream(request_id, **tool_event)
                    if tool_event["status"] == "running":
                        summary_key = tool_event["call_id"] or tool_event["label"]
                        streamed_tool_summaries[summary_key] = str(tool_event["label"])
                elif event_type in {"response.output_item.added", "response.output_item.done"}:
                    tool_event = response_output_tool_event(event_type, parsed)
                    if tool_event:
                        emit_tool_stream(request_id, **tool_event)
                        if tool_event["status"] == "running":
                            summary_key = tool_event["call_id"] or tool_event["label"]
                            streamed_tool_summaries[summary_key] = str(tool_event["label"])
                elif event_type in {"response.completed", "response.done"}:
                    response_payload = parsed.get("response") if isinstance(parsed.get("response"), dict) else parsed
                    completed = response_payload if isinstance(response_payload, dict) else {}
                    break
                elif event_type in {"response.failed", "response.error", "error"}:
                    emit_stream(request_id, "error", error=api_error_message(parsed))
                    return
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        emit_stream(request_id, "error", error=api_error_text(text) or f"Hermes API returned HTTP {exc.code}.")
        return
    except Exception as exc:
        emit_stream(request_id, "error", error=f"Could not reach Hermes API at {url}: {exc}")
        return

    final_text = response_text_from_api(completed) if completed else "".join(collected).strip()
    if final_text and not collected:
        emit_stream(request_id, "delta", delta=final_text)
    events = parse_response_events(final_text)
    if streamed_tool_summaries:
        existing_summaries = {item.get("summary") for item in events.get("toolCalls", [])}
        events["toolCalls"].extend(
            {"summary": summary}
            for summary in streamed_tool_summaries.values()
            if summary not in existing_summaries
        )
    done_payload = {
        "response": final_text,
        "events": events,
    }
    response_id = str((completed or {}).get("id") or "").strip()
    if session_id or response_id:
        done_payload["sessionId"] = session_id or response_id
    emit_stream(request_id, "done", **done_payload)


def fetch_management_conversation_detail(payload: dict[str, Any], conversation_id: str) -> dict[str, Any]:
    selected = profile_name_from_payload(payload)
    path = (
        f"/profiles/{urllib.parse.quote(selected, safe='')}/conversations/"
        f"{urllib.parse.quote(conversation_id, safe='')}"
    )
    result = management_get(payload, path, timeout=8)
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error") or "Could not load conversation from management API."}

    conversation = result.get("conversation") if isinstance(result.get("conversation"), dict) else {}
    messages = result.get("messages") if isinstance(result.get("messages"), list) else []
    return {
        "ok": True,
        "profile": str(result.get("profile") or selected),
        "path": str(result.get("path") or ""),
        "source": "hermes-management",
        "schemaVersion": int(schema_version) if (schema_version := number_or_none(result.get("schemaVersion"))) is not None else None,
        "conversation": normalize_management_conversation(conversation),
        "messages": [
            normalize_management_message(item, conversation_id, index)
            for index, item in enumerate(messages)
            if isinstance(item, dict)
        ],
        "warning": result.get("warning"),
    }


def normalize_management_message(item: dict[str, Any], conversation_id: str, index: int) -> dict[str, Any]:
    message_id = str(item.get("id") or f"{conversation_id}-{index}").strip()
    session_id = str(item.get("sessionId") or item.get("session_id") or conversation_id).strip()
    return {
        "id": message_id,
        "sessionId": session_id,
        "role": safe_message_role(item.get("role")),
        "content": message_content_text(item.get("content") or item.get("text") or item.get("message")),
        "toolName": str(item.get("toolName") or item.get("tool_name") or ""),
        "toolCallId": str(item.get("toolCallId") or item.get("tool_call_id") or item.get("call_id") or ""),
        "toolCalls": normalize_tool_calls(item.get("toolCalls") or item.get("tool_calls")),
        "timestamp": number_or_none(item.get("timestamp") or item.get("createdAt") or item.get("created_at")),
    }


def normalize_tool_calls(value: Any) -> list[dict[str, Any]]:
    if value in (None, ""):
        return []
    loaded: Any = value
    if isinstance(value, str):
        try:
            loaded = json.loads(value)
        except json.JSONDecodeError:
            return []
    if isinstance(loaded, dict):
        return [loaded]
    if isinstance(loaded, list):
        return [item for item in loaded if isinstance(item, dict)]
    return []


def fetch_api_response_detail(payload: dict[str, Any], response_id: str) -> dict[str, Any]:
    url = api_base_url(payload)
    if not url:
        return {"ok": False, "error": "Hermes API URL is not configured."}
    request = urllib.request.Request(
        api_endpoint(url, f"/responses/{urllib.parse.quote(response_id, safe='')}"),
        headers=http_headers(payload, "hermes"),
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=bounded_int(payload.get("timeoutSeconds"), default=8, minimum=1, maximum=30)) as response:
            text = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "error": api_error_text(text) or f"Hermes API returned HTTP {exc.code}."}
    except Exception as exc:
        return {"ok": False, "error": f"Could not fetch Hermes API response {response_id}: {exc}"}

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": f"Hermes API returned invalid JSON: {exc}"}
    return api_response_detail(payload, parsed)


def api_base_url(payload: dict[str, Any]) -> str:
    config = bridge_config(payload)
    return config["apiUrl"]


def agentui_gateway_base_url(payload: dict[str, Any]) -> str:
    runtime = payload.get("runtime") if isinstance(payload.get("runtime"), dict) else {}
    profile = profile_name_from_payload(payload)
    explicit_routes = runtime.get("agentuiGatewayUrls") if isinstance(runtime.get("agentuiGatewayUrls"), dict) else {}
    explicit_profile_url = explicit_routes.get(profile) if isinstance(explicit_routes, dict) else ""
    if explicit_profile_url:
        return str(explicit_profile_url).strip()

    derived_profile_url = derive_agentui_gateway_url(payload, runtime, profile)
    if profile != "default" and derived_profile_url:
        return derived_profile_url

    return str(
        runtime.get("agentuiGatewayUrl")
        or payload.get("agentuiGatewayUrl")
        or os.environ.get("IRIS_TO_HERMES_URL")
        or os.environ.get("AGENTUI_TO_HERMES_URL")
        or derived_profile_url
        or DEFAULT_AGENTUI_GATEWAY_URL
    ).strip()


def derive_agentui_gateway_url(payload: dict[str, Any], runtime: dict[str, Any], profile: str) -> str:
    source_url = (
        profile_url_from_runtime(runtime, "profileApiUrls", profile)
        or str(runtime.get("gatewayUrl") or payload.get("gatewayUrl") or "").strip()
    )
    if not source_url:
        return ""
    parsed = urllib.parse.urlparse(source_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or not parsed.port:
        return ""
    port = parsed.port + AGENTUI_GATEWAY_PORT_OFFSET
    netloc = parsed.hostname
    if ":" in netloc and not netloc.startswith("["):
        netloc = f"[{netloc}]"
    return urllib.parse.urlunparse((parsed.scheme, f"{netloc}:{port}", "", "", "", ""))


def agentui_gateway_endpoint(payload: dict[str, Any], path: str) -> str:
    base = agentui_gateway_base_url(payload).rstrip("/")
    return f"{base}{path if path.startswith('/') else f'/{path}'}"


def normalize_model_provider(row: dict[str, Any]) -> dict[str, Any]:
    models_value = row.get("models")
    models = [str(item) for item in models_value if str(item).strip()] if isinstance(models_value, list) else []
    slug = str(row.get("slug") or row.get("provider") or row.get("id") or "").strip()
    return {
        "slug": slug,
        "name": str(row.get("name") or row.get("label") or slug or "Provider").strip(),
        "isCurrent": bool(row.get("isCurrent", row.get("is_current", False))),
        "isUserDefined": bool(row.get("isUserDefined", row.get("is_user_defined", False))),
        "models": models,
        "totalModels": int_value(row.get("totalModels") or row.get("total_models"), len(models), 0, 100_000),
        "source": str(row.get("source") or "").strip(),
    }


def normalize_model_selection(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    model = str(value.get("model") or "").strip()
    provider = str(value.get("provider") or value.get("slug") or "").strip()
    if not model:
        return None
    selection = {"provider": provider, "model": model}
    provider_name = str(value.get("providerName") or value.get("provider_name") or value.get("name") or "").strip()
    if provider_name:
        selection["providerName"] = provider_name
    return selection


def normalize_slash_command(row: dict[str, Any]) -> dict[str, Any]:
    source = str(row.get("source") or "hermes").strip()
    if source not in {"hermes", "skill", "quick-command", "plugin"}:
        source = "hermes"
    text = str(row.get("text") or row.get("label") or row.get("name") or "").strip()
    if text and not text.startswith("/"):
        text = f"/{text}"
    name = str(row.get("name") or text.lstrip("/") or "").strip().lstrip("/")
    aliases = string_list(row.get("aliases"))
    subcommands = string_list(row.get("subcommands") or row.get("sub_commands"))
    args_hint = str(row.get("argsHint") or row.get("args_hint") or "").strip()
    command_id = str(row.get("id") or f"{source}:{name}" or text).strip()
    return {
        "id": command_id,
        "name": name,
        "text": text or f"/{name}",
        "label": str(row.get("label") or text or f"/{name}").strip(),
        "description": str(row.get("description") or row.get("help") or "").strip(),
        "category": str(row.get("category") or "Commands").strip(),
        "source": source,
        "aliases": aliases,
        "argsHint": args_hint,
        "subcommands": subcommands,
        "requiresArgument": bool(row.get("requiresArgument", row.get("requires_argument", args_hint.startswith("<")))),
    }


def normalize_slash_completion_item(row: dict[str, Any]) -> dict[str, str]:
    text = str(row.get("text") or row.get("value") or row.get("display") or "").strip()
    item = {
        "text": text,
        "display": str(row.get("display") or text).strip(),
    }
    meta = str(row.get("meta") or row.get("description") or "").strip()
    if meta:
        item["meta"] = meta
    return item


def string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, tuple):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [item.strip() for item in re.split(r"[, ]+", value) if item.strip()]
    return []


def int_value(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return min(max(parsed, minimum), maximum)


def api_endpoint(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    if not base.endswith("/v1"):
        base = f"{base}/v1"
    return f"{base}{path}"


def response_request_body(payload: dict[str, Any], *, stream: bool) -> dict[str, Any]:
    previous_response_id = str(
        payload.get("previousResponseId")
        or payload.get("previous_response_id")
        or ""
    ).strip()
    body = {
        "model": api_model_name(payload),
        "input": str(payload.get("prompt") or ""),
        "store": True,
        "stream": stream,
    }
    if previous_response_id:
        body["previous_response_id"] = previous_response_id
    return body


def chat_completion_request_body(payload: dict[str, Any], *, stream: bool) -> dict[str, Any]:
    return {
        "model": api_model_name(payload),
        "messages": [
            {
                "role": "user",
                "content": str(payload.get("prompt") or ""),
            }
        ],
        "stream": stream,
    }


def session_id_from_payload(payload: dict[str, Any]) -> str:
    return str(payload.get("conversationId") or payload.get("sessionId") or "").strip()


def api_model_name(payload: dict[str, Any]) -> str:
    model = str(payload.get("model") or "").strip()
    if model:
        return model
    profile = profile_name_from_payload(payload)
    return profile if profile and profile != "default" else "hermes-agent"


def iter_sse(response: Any):
    event_name = ""
    data_lines: list[str] = []
    for raw_line in response:
        line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
        if not line:
            if data_lines:
                yield event_name, "\n".join(data_lines)
            event_name = ""
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        field, separator, value = line.partition(":")
        if separator and value.startswith(" "):
            value = value[1:]
        if field == "event":
            event_name = value
        elif field == "data":
            data_lines.append(value)
    if data_lines:
        yield event_name, "\n".join(data_lines)


def chat_completion_delta(parsed: dict[str, Any]) -> str:
    choices = parsed.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0] if isinstance(choices[0], dict) else {}
    delta = first.get("delta") if isinstance(first.get("delta"), dict) else {}
    return str(delta.get("content") or "")


def response_text_from_api(value: Any) -> str:
    if not isinstance(value, dict):
        return str(value or "")
    if isinstance(value.get("response"), str):
        return str(value.get("response") or "")
    if isinstance(value.get("message"), str):
        return str(value.get("message") or "")
    if isinstance(value.get("content"), str):
        return str(value.get("content") or "")
    choices = value.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0] if isinstance(choices[0], dict) else {}
        message = first.get("message") if isinstance(first.get("message"), dict) else {}
        return str(message.get("content") or "")

    parts: list[str] = []
    output = value.get("output")
    if isinstance(output, str):
        return output
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "message":
                parts.extend(content_text_parts(item.get("content"), {"output_text", "text"}))
            elif item.get("type") in {"output_text", "text"}:
                parts.append(str(item.get("text") or ""))
    return "\n".join(part for part in parts if part).strip()


def input_text_from_api(value: dict[str, Any]) -> str:
    input_value = value.get("input")
    if isinstance(input_value, str):
        return input_value
    if isinstance(input_value, list):
        parts: list[str] = []
        for item in input_value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if item.get("role") == "user":
                    parts.extend(content_text_parts(item.get("content"), {"input_text", "text"}))
                elif item.get("type") in {"input_text", "text"}:
                    parts.append(str(item.get("text") or ""))
        return "\n".join(part for part in parts if part).strip()
    return ""


def content_text_parts(content: Any, allowed_types: set[str]) -> list[str]:
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    parts = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict) and item.get("type") in allowed_types:
            parts.append(str(item.get("text") or ""))
    return parts


def api_response_detail(payload: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    response_id = str(response.get("id") or "")
    response_text = response_text_from_api(response)
    input_text = input_text_from_api(response)
    created = number_or_none(response.get("created_at") or response.get("created"))
    model = str(response.get("model") or api_model_name(payload))
    messages = []
    if input_text:
        messages.append({
            "id": f"{response_id}-input",
            "sessionId": response_id,
            "role": "user",
            "content": input_text,
            "toolName": "",
            "timestamp": created,
        })
    if response_text:
        messages.append({
            "id": f"{response_id}-output",
            "sessionId": response_id,
            "role": "assistant",
            "content": response_text,
            "toolName": "",
            "timestamp": created,
        })
    conversation = {
        "id": response_id,
        "source": "hermes-api",
        "model": model,
        "started_at": created,
        "ended_at": created,
        "last_active": created,
        "message_count": len(messages),
        "title": compact_text(input_text or response_text, 80),
        "preview": compact_text(input_text or response_text, 160),
    }
    return {
        "ok": True,
        "profile": profile_name_from_payload(payload),
        "path": api_base_url(payload),
        "source": "hermes-api",
        "conversation": conversation_summary(conversation),
        "messages": messages,
    }


def api_error_message(parsed: dict[str, Any]) -> str:
    error = parsed.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error)
    if error:
        return str(error)
    return str(parsed.get("message") or "Hermes API returned an error.")


def api_error_text(text: str) -> str:
    if not text.strip():
        return ""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return text.strip()
    if isinstance(parsed, dict):
        return api_error_message(parsed)
    return text.strip()


def http_headers(payload: dict[str, Any], token_kind: str = "hermes") -> dict[str, str]:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if str(token_kind or "").strip() == "agentui":
        token = str(payload.get("agentuiToken") or "").strip() or agentui_platform_token(payload)
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers
    kind = credential_kind(token_kind)
    payload_key = "sidecarToken" if kind == "sidecar" else "hermesApiToken"
    token = str(payload.get(payload_key) or payload.get("remoteToken") or "").strip() or read_remote_token(kind)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def remote_credential_status(payload: dict[str, Any]) -> dict[str, Any]:
    kind = credential_kind(payload.get("kind"))
    status = read_remote_token_status(kind)
    return {"ok": True, "kind": kind, **status}


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
        subprocess.run(
            [
                "security",
                "delete-generic-password",
                "-a",
                credential_account(kind),
                "-s",
                REMOTE_TOKEN_SERVICE,
            ],
            capture_output=True,
            text=True,
        )
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
        subprocess.run(
            [
                "security",
                "delete-generic-password",
                "-a",
                credential_account(kind),
                "-s",
                REMOTE_TOKEN_SERVICE,
            ],
            capture_output=True,
            text=True,
        )
        return {"ok": True, "kind": kind, "exists": False, "source": backend}
    return {"ok": True, "kind": kind, "exists": False, "source": backend}


def read_remote_token_status(kind: str = "hermes") -> dict[str, Any]:
    kind = credential_kind(kind)
    if read_env_token(kind):
        return {"exists": True, "source": "environment"}
    token = read_remote_token(kind, include_env=False)
    backend = credential_backend()
    return {"exists": bool(token), "source": backend}


def read_remote_token(kind: str = "hermes", *, include_env: bool = True) -> str:
    kind = credential_kind(kind)
    if include_env:
        env_token = read_env_token(kind)
        if env_token:
            return env_token
    if os.environ.get("HERMES_DESKTOP_SECRET_TEST_DIR"):
        path = test_credential_path(kind)
        return path.read_text(encoding="utf-8").strip() if path.exists() else ""
    if credential_backend() != "macos-keychain":
        return ""
    return read_keychain_token(credential_account(kind))


def read_env_token(kind: str) -> str:
    kind = credential_kind(kind)
    if kind == "sidecar":
        return (
            os.environ.get("IRIS_INBOX_TOKEN", "").strip()
            or os.environ.get("AGENTUI_INBOX_TOKEN", "").strip()
            or os.environ.get("IRIS_CORE_TOKEN", "").strip()
            or os.environ.get("HERMES_SIDECAR_TOKEN", "").strip()
            or os.environ.get("HERMES_MGMT_TOKEN", "").strip()
            or os.environ.get("HERMES_REMOTE_TOKEN", "").strip()
        )
    return os.environ.get("HERMES_API_TOKEN", "").strip() or os.environ.get("HERMES_REMOTE_TOKEN", "").strip()


def agentui_platform_token(payload: dict[str, Any] | None = None) -> str:
    payload = payload or {}
    runtime = payload.get("runtime") if isinstance(payload.get("runtime"), dict) else {}
    return (
        str(payload.get("agentuiToken") or runtime.get("agentuiToken") or "").strip()
        or os.environ.get("IRIS_TOKEN", "").strip()
        or os.environ.get("AGENTUI_TOKEN", "").strip()
        or os.environ.get("IRIS_INBOX_TOKEN", "").strip()
        or os.environ.get("AGENTUI_INBOX_TOKEN", "").strip()
        or env_file_value(hermes_root() / ".env", "IRIS_TOKEN")
        or env_file_value(hermes_root() / ".env", "AGENTUI_TOKEN")
        or env_file_value(hermes_root() / ".env", "IRIS_INBOX_TOKEN")
        or env_file_value(hermes_root() / ".env", "AGENTUI_INBOX_TOKEN")
    )


def env_file_value(path: Path, key: str) -> str:
    text = safe_read(path)
    if not text:
        return ""
    prefix = f"{key}="
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or not stripped.startswith(prefix):
            continue
        return stripped[len(prefix):].strip().strip("\"'")
    return ""


def read_keychain_token(account: str) -> str:
    result = subprocess.run(
        [
            "security",
            "find-generic-password",
            "-w",
            "-a",
            account,
            "-s",
            REMOTE_TOKEN_SERVICE,
        ],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def credential_kind(value: Any) -> str:
    return "sidecar" if str(value or "").strip() == "sidecar" else "hermes"


def credential_account(kind: str) -> str:
    return SIDECAR_TOKEN_ACCOUNT if credential_kind(kind) == "sidecar" else HERMES_API_TOKEN_ACCOUNT


def credential_backend() -> str:
    if os.environ.get("HERMES_DESKTOP_SECRET_TEST_DIR"):
        return "test-file"
    if sys.platform == "darwin" and shutil.which("security"):
        return "macos-keychain"
    if (
        os.environ.get("HERMES_API_TOKEN", "").strip()
        or os.environ.get("HERMES_SIDECAR_TOKEN", "").strip()
        or os.environ.get("HERMES_MGMT_TOKEN", "").strip()
        or os.environ.get("HERMES_REMOTE_TOKEN", "").strip()
    ):
        return "environment"
    return "unavailable"


def test_credential_path(kind: str = "hermes") -> Path:
    base = Path(os.environ["HERMES_DESKTOP_SECRET_TEST_DIR"]).expanduser()
    base.mkdir(parents=True, exist_ok=True)
    path = base / credential_account(kind)
    try:
        base.chmod(0o700)
    except OSError:
        pass
    return path


def parse_response_events(text: str) -> dict[str, list[dict[str, str]]]:
    events: dict[str, list[dict[str, str]]] = {
        "toolCalls": [],
        "artifacts": [],
        "memoryWrites": [],
        "skillEvents": [],
    }
    for line in text.splitlines():
        lowered = line.lower()
        if re.search(r"\b(tool|function)\s*(call|use|result)\b", lowered):
            events["toolCalls"].append({"summary": line.strip()[:240]})
        if re.search(r"\b(artifact|file written|created file|updated file)\b", lowered):
            events["artifacts"].append({"summary": line.strip()[:240]})
        if re.search(r"\b(memory|remembered|stored)\b", lowered):
            events["memoryWrites"].append({"summary": line.strip()[:240]})
        if re.search(r"\b(skill|skill\.md)\b", lowered):
            events["skillEvents"].append({"summary": line.strip()[:240]})
    return events


def profile_create(payload: dict[str, Any]) -> dict[str, Any]:
    name = safe_profile_name(str(payload.get("name") or ""))
    result = management_request(payload, "/profiles", method="POST", body={"name": name}, timeout=20)
    if result.get("ok"):
        return {"ok": True, "profile": str(result.get("profile") or name), "profiles": result.get("profiles") or []}
    if not should_fallback_to_local_profile_action(payload, result):
        return {"ok": False, "error": result.get("error") or "Profile create failed."}
    return local_profile_create(name)


def local_profile_create(name: str) -> dict[str, Any]:
    root = hermes_root()
    directory = profile_dir(root, name)
    if directory.exists():
        return {"ok": False, "error": f"Profile '{name}' already exists."}
    profile_scaffold(directory)
    return {"ok": True, "profile": name, "profiles": discover_profiles(root)}


def profile_clone(payload: dict[str, Any]) -> dict[str, Any]:
    source_name = safe_profile_name(str(payload.get("source") or active_profile_name(hermes_root())))
    name = safe_profile_name(str(payload.get("name") or ""))
    path = f"/profiles/{urllib.parse.quote(source_name, safe='')}/clone"
    result = management_request(payload, path, method="POST", body={"name": name}, timeout=60)
    if result.get("ok"):
        return {"ok": True, "profile": str(result.get("profile") or name), "profiles": result.get("profiles") or []}
    if not should_fallback_to_local_profile_action(payload, result):
        return {"ok": False, "error": result.get("error") or "Profile clone failed."}
    return local_profile_clone(source_name, name)


def local_profile_clone(source_name: str, name: str) -> dict[str, Any]:
    root = hermes_root()
    source = profile_dir(root, source_name)
    destination = profile_dir(root, name)
    if not source.exists():
        return {"ok": False, "error": f"Source profile '{source_name}' does not exist."}
    if destination.exists():
        return {"ok": False, "error": f"Profile '{name}' already exists."}
    shutil.copytree(source, destination, ignore=clone_ignore(source_name))
    return {"ok": True, "profile": name, "profiles": discover_profiles(root)}


def profile_rename(payload: dict[str, Any]) -> dict[str, Any]:
    root = hermes_root()
    source_name = safe_profile_name(str(payload.get("source") or ""))
    name = safe_profile_name(str(payload.get("name") or ""))
    if source_name == "default":
        return {"ok": False, "error": "The default profile cannot be renamed."}
    source = profile_dir(root, source_name)
    destination = profile_dir(root, name)
    if not source.exists():
        return {"ok": False, "error": f"Profile '{source_name}' does not exist."}
    if destination.exists():
        return {"ok": False, "error": f"Profile '{name}' already exists."}
    source.rename(destination)
    if active_profile_name(root) == source_name:
        write_active_profile(root, name)
    return {"ok": True, "profile": name, "profiles": discover_profiles(root)}


def profile_switch(payload: dict[str, Any]) -> dict[str, Any]:
    root = hermes_root()
    name = safe_profile_name(str(payload.get("name") or ""))
    directory = profile_dir(root, name)
    if not directory.exists():
        return {"ok": False, "error": f"Profile '{name}' does not exist."}
    write_active_profile(root, name)
    return {"ok": True, "profile": name, "profiles": discover_profiles(root)}


def profile_delete(payload: dict[str, Any]) -> dict[str, Any]:
    name = safe_profile_name(str(payload.get("name") or ""))
    path = f"/profiles/{urllib.parse.quote(name, safe='')}"
    result = management_request(payload, path, method="DELETE", timeout=30)
    if result.get("ok"):
        return {
            "ok": True,
            "profile": str(result.get("profile") or "default"),
            "profiles": result.get("profiles") or [],
        }
    if not should_fallback_to_local_profile_action(payload, result):
        return {"ok": False, "error": result.get("error") or "Profile delete failed."}
    return local_profile_delete(name)


def local_profile_delete(name: str) -> dict[str, Any]:
    root = hermes_root()
    if name == "default":
        return {"ok": False, "error": "The default profile cannot be deleted."}
    directory = profile_dir(root, name)
    if not directory.exists():
        return {"ok": False, "error": f"Profile '{name}' does not exist."}
    shutil.rmtree(directory)
    if active_profile_name(root) == name:
        write_active_profile(root, "default")
    return {"ok": True, "profile": "default", "profiles": discover_profiles(root)}


def safe_read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(errors="replace")
    except OSError:
        return ""


if __name__ == "__main__":
    main()
