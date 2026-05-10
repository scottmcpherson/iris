"""Configuration helpers for the Iris Hermes platform adapter."""

from __future__ import annotations

import os
import urllib.parse
from pathlib import Path


DEFAULT_INBOUND_HOST = "127.0.0.1"
DEFAULT_INBOUND_PORT = 8766
API_TO_AGENTUI_PORT_OFFSET = 124


def env_value(*names: str) -> str:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return ""


def sync_env_alias(preferred: str, legacy: str) -> None:
    if os.getenv(preferred) and not os.getenv(legacy):
        os.environ[legacy] = os.getenv(preferred, "")


def normalize_base_url(value: object) -> str:
    raw = str(value or "").strip().rstrip("/")
    if not raw:
        return ""
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return raw


def safe_int(value: object, default: int) -> int:
    try:
        parsed = int(str(value or "").strip())
    except (TypeError, ValueError):
        return default
    return parsed if 0 < parsed < 65536 else default


def clamp_int(value: object, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(str(value or "").strip())
    except (TypeError, ValueError):
        parsed = default
    return min(max(parsed, minimum), maximum)


def default_inbound_port() -> int:
    api_port = safe_int(os.getenv("API_SERVER_PORT"), 0)
    if api_port:
        return api_port + API_TO_AGENTUI_PORT_OFFSET
    return DEFAULT_INBOUND_PORT


def current_profile_name() -> str:
    home = Path(os.getenv("HERMES_HOME") or Path.home() / ".hermes").expanduser()
    if home.parent.name == "profiles" and home.name:
        return home.name
    return "default"


def safe_text(value: object, default: str, limit: int) -> str:
    text = str(value or default or "").strip()
    if not text:
        return default
    return text[:limit]
