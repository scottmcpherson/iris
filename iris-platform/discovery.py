"""Slash command and model catalog discovery helpers for the Iris adapter."""

from __future__ import annotations

import logging
import re
import time
from typing import Any, Dict

try:
    from adapter_config import clamp_int
except ImportError:
    from .adapter_config import clamp_int

logger = logging.getLogger(__name__)


def normalize_model_provider(row: Dict[str, Any]) -> Dict[str, Any]:
    models_value = row.get("models")
    models = [str(item) for item in models_value if str(item).strip()] if isinstance(models_value, list) else []
    slug = str(row.get("slug") or row.get("provider") or row.get("id") or "").strip()
    return {
        "slug": slug,
        "name": str(row.get("name") or row.get("label") or slug or "Provider").strip(),
        "isCurrent": bool(row.get("isCurrent", row.get("is_current", False))),
        "isUserDefined": bool(row.get("isUserDefined", row.get("is_user_defined", False))),
        "models": models,
        "totalModels": clamp_int(row.get("totalModels") or row.get("total_models"), len(models), 0, 100_000),
        "source": str(row.get("source") or "").strip(),
    }


def discover_slash_commands(profile: str) -> Dict[str, Any]:
    warnings: list[str] = []
    commands: list[Dict[str, Any]] = []
    config = load_gateway_config(warnings)

    try:
        commands.extend(discover_builtin_commands(config))
    except Exception as exc:
        logger.exception("[Iris] built-in slash command discovery failed")
        warnings.append(f"Built-in command discovery failed: {exc}")

    try:
        commands.extend(discover_quick_commands(config))
    except Exception as exc:
        logger.exception("[Iris] quick command discovery failed")
        warnings.append(f"Quick command discovery failed: {exc}")

    try:
        commands.extend(discover_plugin_commands(config))
    except Exception as exc:
        logger.exception("[Iris] plugin slash command discovery failed")
        warnings.append(f"Plugin command discovery failed: {exc}")

    try:
        commands.extend(discover_skill_commands(config))
    except Exception as exc:
        logger.exception("[Iris] skill slash command discovery failed")
        warnings.append(f"Skill command discovery failed: {exc}")

    normalized = dedupe_command_rows(commands)
    ok = bool(normalized or len(warnings) < 4)
    return {
        "ok": ok,
        "profile": profile,
        "generatedAt": int(time.time()),
        "commands": normalized,
        **({"warning": "; ".join(warnings)} if warnings else {}),
        **({"error": "; ".join(warnings) or "Slash command discovery failed."} if not ok else {}),
    }


def load_gateway_config(warnings: list[str]) -> Dict[str, Any]:
    try:
        from gateway.run import _load_gateway_config

        loaded = _load_gateway_config() or {}
        return loaded if isinstance(loaded, dict) else {}
    except Exception as exc:
        warnings.append(f"Gateway config unavailable: {exc}")
        return {}


def discover_builtin_commands(config: Dict[str, Any]) -> list[Dict[str, Any]]:
    from hermes_cli.commands import COMMAND_REGISTRY

    rows = command_registry_rows(COMMAND_REGISTRY)
    return [
        normalize_slash_row(row, source="hermes", category=command_category(row, "Commands"))
        for row in rows
        if command_available(row, config)
    ]


def discover_quick_commands(config: Dict[str, Any]) -> list[Dict[str, Any]]:
    quick_commands = config.get("quick_commands") or config.get("quickCommands")
    rows: list[Dict[str, Any]] = []
    if isinstance(quick_commands, dict):
        for name, value in quick_commands.items():
            description = ""
            text = ""
            if isinstance(value, dict):
                description = str(value.get("description") or value.get("prompt") or "").strip()
                text = str(value.get("command") or value.get("text") or name).strip()
            else:
                description = str(value or "").strip()
                text = str(name or "").strip()
            rows.append(
                normalize_slash_row(
                    {
                        "name": name,
                        "text": text,
                        "description": description,
                    },
                    source="quick-command",
                    category="User commands",
                )
            )
    elif isinstance(quick_commands, list):
        for item in quick_commands:
            rows.append(normalize_slash_row(item, source="quick-command", category="User commands"))
    return rows


def discover_plugin_commands(config: Dict[str, Any]) -> list[Dict[str, Any]]:
    try:
        from hermes_cli.plugins import get_plugin_commands
    except Exception:
        return []

    try:
        raw = get_plugin_commands(config)
    except TypeError:
        raw = get_plugin_commands()
    return [
        normalize_slash_row(row, source="plugin", category="Plugins")
        for row in command_registry_rows(raw)
        if command_available(row, config)
    ]


def discover_skill_commands(config: Dict[str, Any]) -> list[Dict[str, Any]]:
    try:
        from agent.skill_commands import scan_skill_commands
    except Exception:
        return []

    try:
        raw = scan_skill_commands(config)
    except TypeError:
        try:
            raw = scan_skill_commands()
        except TypeError:
            raw = []
    return [
        normalize_slash_row(row, source="skill", category="Skills")
        for row in command_registry_rows(raw)
    ]


def command_registry_rows(value: Any) -> list[Any]:
    if isinstance(value, dict):
        return [
            {**object_dict(command), "name": name}
            if not isinstance(command, dict) or not command.get("name")
            else command
            for name, command in value.items()
        ]
    if isinstance(value, (list, tuple, set)):
        return list(value)
    return [value] if value else []


def object_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    attrs: Dict[str, Any] = {}
    for key in (
        "name",
        "text",
        "label",
        "description",
        "help",
        "args_hint",
        "argsHint",
        "aliases",
        "subcommands",
        "sub_commands",
        "requires_argument",
        "requiresArgument",
        "cli_only",
        "config_key",
        "enabled",
        "category",
        "prompt",
        "command",
    ):
        if hasattr(value, key):
            attrs[key] = getattr(value, key)
    return attrs


def normalize_slash_row(value: Any, *, source: str, category: str) -> Dict[str, Any]:
    row = object_dict(value)
    name = str(row.get("name") or row.get("command") or row.get("slug") or row.get("id") or "").strip().lstrip("/")
    text = str(row.get("text") or row.get("label") or name).strip()
    if text and not text.startswith("/"):
        text = f"/{text}"
    if not name:
        name = text.lstrip("/")
    args_hint = str(row.get("argsHint") or row.get("args_hint") or "").strip()
    clean_source = source if source in {"hermes", "skill", "quick-command", "plugin"} else "hermes"
    return {
        "id": str(row.get("id") or f"{clean_source}:{name}").strip(),
        "name": name,
        "text": text or f"/{name}",
        "label": str(row.get("label") or text or f"/{name}").strip(),
        "description": str(row.get("description") or row.get("help") or skill_description_fallback(name, clean_source)).strip(),
        "category": str(row.get("category") or category).strip(),
        "source": clean_source,
        "aliases": string_values(row.get("aliases")),
        "argsHint": args_hint,
        "subcommands": string_values(row.get("subcommands") or row.get("sub_commands")),
        "requiresArgument": bool(row.get("requiresArgument", row.get("requires_argument", args_hint.startswith("<")))),
    }


def command_available(value: Any, config: Dict[str, Any]) -> bool:
    row = object_dict(value)
    if bool(row.get("cli_only")):
        return False
    enabled = row.get("enabled")
    if enabled is False:
        return False
    config_key = str(row.get("config_key") or row.get("requires_config") or "").strip()
    if config_key and not config.get(config_key):
        return False
    return True


def command_category(value: Any, fallback: str) -> str:
    row = object_dict(value)
    return str(row.get("category") or fallback).strip() or fallback


def skill_description_fallback(name: str, source: str) -> str:
    if source == "skill":
        return f"Invoke the {name} skill"
    return ""


def string_values(value: Any) -> list[str]:
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip().lstrip("/") for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [item.strip().lstrip("/") for item in re.split(r"[, ]+", value) if item.strip()]
    return []


def dedupe_command_rows(commands: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    by_text: dict[str, Dict[str, Any]] = {}
    for command in commands:
        text = str(command.get("text") or "").strip()
        name = str(command.get("name") or "").strip()
        if not text or not name:
            continue
        key = text.lower()
        if key not in by_text:
            by_text[key] = command
    return sorted(by_text.values(), key=lambda row: str(row.get("text") or ""))


def filter_slash_command_rows(commands: list[Any], query: str) -> list[Dict[str, Any]]:
    needle = query.strip().lower()
    rows = [command for command in commands if isinstance(command, dict)]
    if not needle:
        return rows[:30]
    scored = [
        (score_slash_command_row(command, needle), command)
        for command in rows
    ]
    return [
        command
        for score, command in sorted(scored, key=lambda item: (-item[0], str(item[1].get("text") or "")))
        if score > 0
    ][:30]


def score_slash_command_row(command: Dict[str, Any], needle: str) -> int:
    name = str(command.get("name") or "").lower()
    text = str(command.get("text") or "").lower()
    aliases = [str(alias).lower() for alias in command.get("aliases", []) if str(alias).strip()]
    haystack = " ".join(
        str(command.get(key) or "")
        for key in ("description", "category", "source")
    ).lower()
    if name == needle or text == f"/{needle}":
        return 1000
    if name.startswith(needle):
        return 900 - len(name)
    if text.startswith(f"/{needle}"):
        return 850 - len(text)
    if any(alias == needle for alias in aliases):
        return 820
    if any(alias.startswith(needle) for alias in aliases):
        return 760
    if needle in name:
        return 560
    if any(needle in alias for alias in aliases):
        return 500
    if needle in haystack:
        return 120
    return 0
