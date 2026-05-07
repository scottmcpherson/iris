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


def profile_name_from_payload(payload: dict[str, Any]) -> str:
    return str(payload.get("profile") or "default")


def number_or_none(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


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
    management_endpoint_status = endpoint_status(management_status, management_endpoint(config["managementApiUrl"], "/status"))

    connected = bool(active_api.get("ok") or management_endpoint_status.get("ok"))

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
        "managementStatus": management_endpoint_status,
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
