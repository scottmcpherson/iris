"""Read-only access to Hermes profile metadata."""

from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import re
import shlex
import shutil
import sqlite3
import tarfile
import tempfile
import time
from pathlib import Path
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any

from .hermes_sessions import (
    ID_COLUMNS,
    TITLE_COLUMNS,
    SessionDetail,
    SessionDiscovery,
    assert_within_profile,
    choose_session_table,
    choose_message_table,
    discover_session_detail,
    discover_session_summaries,
    discover_sessions,
    first_message_link_column,
    inspect_sqlite_schema,
    normalize_columns,
    normalize_session_file,
    quote_identifier,
    sqlite_candidates,
)
from ..models import FileContent, ProfileSummary, SkillSummary
from ..security import ManagementError


PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
LEGACY_PROFILE_DIR_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
RESERVED_PROFILE_NAMES = frozenset({"hermes", "test", "tmp", "root", "sudo"})
PROFILE_SCAFFOLD_DIRS = (
    "memories",
    "sessions",
    "skills",
    "skins",
    "logs",
    "plans",
    "workspace",
    "cron",
    "home",
)
CLONE_IDENTITY_FILES = ("config.yaml", ".env", "SOUL.md")
CLONE_IDENTITY_SUBDIR_FILES = ("memories/MEMORY.md", "memories/USER.md")
CLONE_ALL_STRIP = (
    "gateway.pid",
    "gateway.lock",
    "gateway_state.json",
    "processes.json",
)
CLONE_ALL_DEFAULT_EXCLUDE_ROOT = frozenset({
    "hermes-agent",
    ".worktrees",
    "profiles",
    "bin",
    "node_modules",
})
DEFAULT_EXPORT_EXCLUDE_ROOT = frozenset({
    "hermes-agent",
    ".worktrees",
    "profiles",
    "bin",
    "node_modules",
    "state.db",
    "state.db-shm",
    "state.db-wal",
    "hermes_state.db",
    "response_store.db",
    "response_store.db-shm",
    "response_store.db-wal",
    "gateway.pid",
    "gateway.lock",
    "gateway_state.json",
    "processes.json",
    "auth.json",
    ".env",
    "auth.lock",
    "active_profile",
    ".update_check",
    "errors.log",
    ".hermes_history",
    "image_cache",
    "audio_cache",
    "document_cache",
    "browser_screenshots",
    "checkpoints",
    "sandboxes",
    "logs",
})
CREDENTIAL_EXPORT_EXCLUDE = frozenset({"auth.json", ".env"})
DISTRIBUTION_MANIFEST = "distribution.yaml"
DISTRIBUTION_ENV_TEMPLATE = ".env.template"
DISTRIBUTION_ENV_EXAMPLE = ".env.EXAMPLE"
DISTRIBUTION_DEFAULT_OWNED = ("SOUL.md", "config.yaml", "mcp.json", "skills", "cron", DISTRIBUTION_MANIFEST)
DISTRIBUTION_USER_OWNED_EXCLUDE = frozenset({
    "auth.json",
    ".env",
    "state.db",
    "state.db-shm",
    "state.db-wal",
    "hermes_state.db",
    "response_store.db",
    "response_store.db-shm",
    "response_store.db-wal",
    "gateway.pid",
    "gateway.lock",
    "gateway_state.json",
    "processes.json",
    "auth.lock",
    "active_profile",
    ".update_check",
    "errors.log",
    ".hermes_history",
    "memories",
    "sessions",
    "logs",
    "plans",
    "workspace",
    "home",
    "image_cache",
    "audio_cache",
    "document_cache",
    "browser_screenshots",
    "checkpoints",
    "sandboxes",
    "backups",
    "cache",
    "hermes-agent",
    ".worktrees",
    "profiles",
    "bin",
    "node_modules",
    "local",
})
PROFILE_FILE_ALLOWLIST = frozenset({"SOUL.md", "config.yaml", ".env"})
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
FALLBACK_SOUL_MD = (
    "# Hermes Profile\n\n"
    "You are a Hermes agent profile managed by Iris. Customize this file to shape the agent's behavior.\n"
)


def checked_at() -> int:
    return int(time.time())


def normalize_hermes_home(value: str | os.PathLike[str] | None = None) -> Path:
    raw = str(value or os.environ.get("HERMES_HOME") or "").strip()
    if not raw:
        return (Path.home() / ".hermes").expanduser()

    path = Path(raw).expanduser()
    if path.parent.name == "profiles" and path.name:
        return path.parent.parent
    return path


def normalize_profile_name(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        raise ManagementError("Profile name is required.", status_code=400)
    if raw.casefold() == "default":
        return "default"
    return raw.lower()


def validate_profile_name(value: str) -> str:
    name = str(value or "").strip()
    if name == "default":
        return name
    if not PROFILE_NAME_RE.fullmatch(name):
        raise ManagementError(
            "Profile names must match [a-z0-9][a-z0-9_-]{0,63}.",
            status_code=400,
        )
    if name in RESERVED_PROFILE_NAMES:
        raise ManagementError(f"Profile name '{name}' is reserved.", status_code=400)
    return name


def canonical_profile_name(value: str, *, allow_default: bool = True) -> str:
    name = normalize_profile_name(value)
    validate_profile_name(name)
    if name == "default" and not allow_default:
        raise ManagementError("The default Hermes profile cannot be used for this operation.", status_code=400)
    return name


def profile_dir(root: Path, profile: str) -> Path:
    name = validate_profile_name(profile)
    return root if name == "default" else root / "profiles" / name


def profile_scaffold(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for relative in PROFILE_SCAFFOLD_DIRS:
        (directory / relative).mkdir(parents=True, exist_ok=True)


def default_soul_md() -> tuple[str, str | None]:
    try:
        from hermes_cli.default_soul import DEFAULT_SOUL_MD  # type: ignore

        return str(DEFAULT_SOUL_MD), None
    except Exception as exc:
        return FALLBACK_SOUL_MD, f"Hermes default SOUL.md template was unavailable; Iris used a minimal fallback. ({exc})"


def seed_soul_file(directory: Path) -> str | None:
    soul = directory / "SOUL.md"
    if soul.exists():
        return None
    content, warning = default_soul_md()
    soul.write_text(content, encoding="utf-8")
    return warning


def clone_all_ignore(source_dir: Path, *, exclude_default_root: bool = False):
    source_resolved = source_dir.resolve()

    def ignore(directory: str, names: list[str]) -> set[str]:
        ignored: set[str] = set()
        for entry in names:
            if entry == "__pycache__" or entry.endswith((".pyc", ".pyo", ".sock", ".tmp")):
                ignored.add(entry)
        try:
            if Path(directory).resolve() == source_resolved and exclude_default_root:
                ignored.update(name for name in names if name in CLONE_ALL_DEFAULT_EXCLUDE_ROOT)
        except OSError:
            pass
        return ignored

    return ignore


def _is_safe_profile_dir_name(name: str) -> bool:
    return bool(LEGACY_PROFILE_DIR_RE.fullmatch(name))


def assert_within_base(path: Path, base: Path) -> Path:
    resolved_base = base.resolve()
    resolved_path = path.resolve()
    try:
        resolved_path.relative_to(resolved_base)
    except ValueError as exc:
        raise ManagementError(
            "Resolved path must stay inside the selected Hermes profile directory.",
            status_code=400,
        ) from exc
    return resolved_path


def assert_profile_directory(root: Path, directory: Path) -> Path:
    if not directory.exists():
        return directory
    root_base = root.resolve()
    resolved_directory = directory.resolve()
    try:
        resolved_directory.relative_to(root_base)
    except ValueError as exc:
        raise ManagementError(
            "Profile directory must stay inside the configured Hermes home.",
            status_code=400,
        ) from exc
    return directory


def safe_stat(path: Path, base: Path) -> os.stat_result | None:
    if not path.exists():
        return None
    safe_path = assert_within_base(path, base)
    try:
        return safe_path.stat()
    except OSError:
        return None


def safe_read_text(path: Path, base: Path) -> str:
    if not path.exists():
        return ""
    safe_path = assert_within_base(path, base)
    try:
        return safe_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return safe_path.read_text(errors="replace")
    except OSError:
        return ""


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


def read_config(path: Path, profile_root: Path) -> dict[str, Any]:
    text = safe_read_text(path, profile_root)
    if not text:
        return {}

    try:
        import yaml  # type: ignore

        loaded = yaml.safe_load(text)
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return naive_yaml_subset(text)


def model_summary(config: dict[str, Any]) -> tuple[str, str]:
    model_config = config.get("model") if isinstance(config.get("model"), dict) else {}
    provider = str(model_config.get("provider") or config.get("provider") or "")
    if isinstance(config.get("model"), str):
        model = str(config.get("model") or "")
    else:
        model = str(model_config.get("model") or model_config.get("name") or model_config.get("default") or "")
    return provider or "not configured", model or "not configured"


def memory_file_stats(directory: Path) -> tuple[int, int | None]:
    total = 0
    updated_at: int | None = None
    memories = directory / "memories"
    for name in ("MEMORY.md", "USER.md"):
        stat = safe_stat(memories / name, directory)
        if stat is None:
            continue
        total += stat.st_size
        updated_at = max(updated_at or 0, int(stat.st_mtime))
    return total, updated_at


def count_skills(skills_dir: Path, profile_root: Path) -> int:
    return len(skill_entrypoint_paths(skills_dir, profile_root))


def skill_entrypoint_paths(skills_dir: Path, profile_root: Path) -> list[Path]:
    if not skills_dir.is_dir():
        return []
    root = assert_within_base(skills_dir, profile_root)
    paths: list[Path] = []
    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack:
        directory, depth = stack.pop()
        skill_file = directory / "SKILL.md"
        if skill_file.is_file():
            paths.append(assert_within_base(skill_file, profile_root))
            continue
        if depth >= 2:
            continue
        try:
            children = list(directory.iterdir())
        except OSError:
            continue
        for child in sorted(children, key=lambda item: item.name.lower(), reverse=True):
            if child.name in {".git", "__pycache__", "node_modules", ".venv", "venv"}:
                continue
            if child.is_symlink() or not child.is_dir():
                continue
            stack.append((assert_within_base(child, profile_root), depth + 1))
    return sorted(paths, key=lambda item: item.as_posix().lower())


def gateway_running(directory: Path) -> bool:
    pid_path = directory / "gateway.pid"
    try:
        raw_pid = safe_read_text(pid_path, directory).strip()
        pid_data = json.loads(raw_pid)
        pid = int(pid_data.get("pid") if isinstance(pid_data, dict) else pid_data)
    except (ValueError, TypeError, json.JSONDecodeError):
        return False
    if pid <= 0:
        return False
    if is_windows():
        return windows_pid_running(pid)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def is_windows() -> bool:
    return os.name == "nt"


def windows_pid_running(pid: int) -> bool:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    kernel32.GetExitCodeProcess.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int

    process_query_limited_information = 0x1000
    still_active = 259
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        access_denied = 5
        return ctypes.get_last_error() == access_denied
    try:
        exit_code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return True
        return exit_code.value == still_active
    finally:
        kernel32.CloseHandle(handle)


def encode_skill_id(relative_path: Path) -> str:
    value = relative_path.as_posix().encode("utf-8")
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def decode_skill_id(skill_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", skill_id):
        raise ManagementError("Skill id is invalid.", status_code=400)
    padding = "=" * (-len(skill_id) % 4)
    try:
        decoded = base64.urlsafe_b64decode(skill_id + padding).decode("utf-8")
    except Exception as exc:
        raise ManagementError("Skill id is invalid.", status_code=400) from exc
    path = Path(decoded)
    if path.is_absolute() or ".." in path.parts or path.name != "SKILL.md":
        raise ManagementError("Skill id does not reference a safe SKILL.md path.", status_code=400)
    return path


def safe_skill_path(skills_dir: Path, profile_root: Path, skill_id: str) -> tuple[Path, Path]:
    relative_path = decode_skill_id(skill_id)
    path = skills_dir / relative_path
    resolved = assert_within_base(path, profile_root)
    try:
        resolved.relative_to(skills_dir.resolve())
    except ValueError as exc:
        raise ManagementError(
            "Skill id must stay inside the active profile skills directory.",
            status_code=400,
        ) from exc
    return resolved, relative_path


def normalized_memory_file_key(file_key: str) -> str:
    normalized = file_key.strip().lower()
    if normalized in {"memory", "memory.md"}:
        return "memory"
    if normalized in {"user", "user.md"}:
        return "user"
    raise ManagementError("Memory writes are limited to MEMORY.md and USER.md.", status_code=400)


def memory_file_name(file_key: str) -> str:
    return "MEMORY.md" if normalized_memory_file_key(file_key) == "memory" else "USER.md"


def memory_file_path(directory: Path, file_key: str) -> Path:
    return directory / "memories" / memory_file_name(file_key)


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def safe_skill_segment(value: str, fallback: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip(".-")
    return slug[:64] or fallback


def skill_path_for_write(skills_dir: Path, profile_root: Path, payload: dict[str, Any], skill_id: str = "") -> Path:
    if skill_id:
        path, _relative_path = safe_skill_path(skills_dir, profile_root, skill_id)
        return path
    raw_path = str(payload.get("path") or "").strip()
    if raw_path:
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            path = skills_dir / path
        resolved = assert_within_base(path, profile_root)
        try:
            resolved.relative_to(skills_dir.resolve())
        except ValueError as exc:
            raise ManagementError(
                "Skill path must stay inside the active profile skills directory.",
                status_code=400,
            ) from exc
        if resolved.name != "SKILL.md":
            raise ManagementError("Skill editor can only write SKILL.md files.", status_code=400)
        return resolved
    category = safe_skill_segment(str(payload.get("category") or "personal"), "personal")
    name = safe_skill_segment(str(payload.get("name") or "untitled-skill"), "untitled-skill")
    return assert_within_base(skills_dir / category / name / "SKILL.md", profile_root)


def default_skill_content(name: str, category: str) -> str:
    title = name.strip() or "Untitled skill"
    return "\n".join(
        [
            "---",
            f"name: {title}",
            f"category: {category.strip() or 'personal'}",
            "---",
            "",
            f"# {title}",
            "",
            "Describe when to use this skill and the workflow it should follow.",
        ]
    )


def file_payload(path: Path, profile_root: Path) -> FileContent:
    text = safe_read_text(path, profile_root)
    stat = safe_stat(path, profile_root)
    return FileContent(
        name=path.name,
        path=str(path),
        exists=stat is not None,
        updatedAt=int(stat.st_mtime) if stat else None,
        bytes=stat.st_size if stat else 0,
        content=text,
        contentHash=content_hash(text),
    )


def profile_file_path(directory: Path, relative_path: str) -> Path:
    clean = str(relative_path or "").strip()
    if clean not in PROFILE_FILE_ALLOWLIST:
        raise ManagementError("Profile file access is limited to SOUL.md, config.yaml, and controlled .env status.", status_code=400)
    return assert_within_base(directory / clean, directory)


def parse_config_text(text: str) -> tuple[dict[str, Any], str | None]:
    if not text.strip():
        return {}, None
    try:
        import yaml  # type: ignore
    except Exception:
        return naive_yaml_subset(text), "PyYAML is not installed; Iris is showing a best-effort config summary."
    try:
        loaded = yaml.safe_load(text)
        if isinstance(loaded, dict):
            return loaded, None
        return {}, None
    except Exception as exc:
        return naive_yaml_subset(text), f"Could not parse config.yaml: {exc}"


def config_summary(path: Path, profile_root: Path) -> dict[str, Any]:
    raw = safe_read_text(path, profile_root)
    parsed, parse_error = parse_config_text(raw)
    provider, model = model_summary(parsed)
    payload = file_payload(path, profile_root)
    return {
        "path": str(path),
        "exists": payload.exists,
        "updatedAt": payload.updatedAt,
        "bytes": payload.bytes,
        "contentHash": payload.contentHash,
        "raw": raw,
        "provider": provider,
        "model": model,
        **({"parseError": parse_error} if parse_error else {}),
    }


def env_key_from_line(line: str) -> str:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return ""
    if stripped.startswith("export "):
        stripped = stripped[len("export "):].lstrip()
    if "=" not in stripped:
        return ""
    key = stripped.split("=", 1)[0].strip()
    return key if ENV_KEY_RE.fullmatch(key) else ""


def env_status(path: Path, profile_root: Path) -> dict[str, Any]:
    stat = safe_stat(path, profile_root)
    keys: list[str] = []
    for line in safe_read_text(path, profile_root).splitlines():
        key = env_key_from_line(line)
        if key and key not in keys:
            keys.append(key)
    return {
        "path": str(path),
        "exists": stat is not None,
        "updatedAt": int(stat.st_mtime) if stat else None,
        "bytes": stat.st_size if stat else 0,
        "keys": sorted(keys),
    }


def env_line_defines_key(line: str, key: str) -> bool:
    return env_key_from_line(line) == key


def dotenv_value(value: str) -> str:
    text = str(value)
    if "\n" in text or "\r" in text:
        raise ManagementError("Environment values cannot contain newlines.", status_code=400)
    if not text or re.search(r"\s|#|'|\"|\\|=", text):
        return shlex.quote(text)
    return text


def update_env_file(path: Path, profile_root: Path, values: dict[str, str], remove_keys: list[str] | set[str]) -> None:
    normalized_values: dict[str, str] = {}
    for key, value in values.items():
        clean_key = str(key or "").strip()
        if not ENV_KEY_RE.fullmatch(clean_key):
            raise ManagementError(f"Environment key '{clean_key}' is invalid.", status_code=400)
        normalized_values[clean_key] = str(value)
    normalized_remove = {str(key or "").strip() for key in remove_keys if str(key or "").strip()}
    for key in normalized_remove:
        if not ENV_KEY_RE.fullmatch(key):
            raise ManagementError(f"Environment key '{key}' is invalid.", status_code=400)

    existing = safe_read_text(path, profile_root).splitlines() if path.exists() else []
    next_lines = [
        line
        for line in existing
        if not any(env_line_defines_key(line, key) for key in set(normalized_values) | normalized_remove)
    ]
    for key, value in normalized_values.items():
        next_lines.append(f"{key}={dotenv_value(value)}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(next_lines).rstrip() + ("\n" if next_lines else ""), encoding="utf-8")


def _load_yaml_like(text: str) -> tuple[Any, str | None]:
    try:
        import yaml  # type: ignore

        return yaml.safe_load(text), None
    except Exception as exc:
        return naive_yaml_subset(text), str(exc)


def distribution_manifest(path: Path, profile_root: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    raw = safe_read_text(path, profile_root)
    parsed, parse_error = _load_yaml_like(raw)
    if not isinstance(parsed, dict):
        parsed = {}
    env_requires = parsed.get("env_requires")
    if not isinstance(env_requires, list):
        env_requires = []
    return {
        "name": str(parsed.get("name") or ""),
        "version": str(parsed.get("version") or ""),
        "description": str(parsed.get("description") or ""),
        "hermesRequires": str(parsed.get("hermes_requires") or parsed.get("hermesRequires") or ""),
        "author": str(parsed.get("author") or ""),
        "license": str(parsed.get("license") or ""),
        "source": str(parsed.get("source") or ""),
        "installedAt": str(parsed.get("installed_at") or parsed.get("installedAt") or ""),
        "envRequires": [
            item
            for item in env_requires
            if isinstance(item, dict) and str(item.get("name") or "").strip()
        ],
        "distributionOwned": parsed.get("distribution_owned") if isinstance(parsed.get("distribution_owned"), list) else [],
        **({"parseError": parse_error} if parse_error else {}),
    }


def archive_member_parts(member_name: str) -> list[str]:
    normalized = member_name.replace("\\", "/")
    posix = PurePosixPath(normalized)
    windows = PureWindowsPath(member_name)
    if not normalized or posix.is_absolute() or windows.is_absolute() or windows.drive:
        raise ManagementError(f"Unsafe archive member path: {member_name}", status_code=400)
    parts = [part for part in posix.parts if part not in {"", "."}]
    if not parts or any(part == ".." for part in parts):
        raise ManagementError(f"Unsafe archive member path: {member_name}", status_code=400)
    return parts


def inspect_archive_root(archive: Path) -> str:
    roots: set[str] = set()
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            parts = archive_member_parts(member.name)
            if member.isdir() or len(parts) > 1:
                roots.add(parts[0])
            if member.issym() or member.islnk() or member.isdev():
                raise ManagementError(f"Unsupported archive member type: {member.name}", status_code=400)
    if len(roots) != 1:
        raise ManagementError("Profile archive must contain exactly one top-level directory.", status_code=400)
    return next(iter(roots))


def safe_extract_archive(archive: Path, destination: Path) -> None:
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            parts = archive_member_parts(member.name)
            target = destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                raise ManagementError(f"Unsupported archive member type: {member.name}", status_code=400)
            target.parent.mkdir(parents=True, exist_ok=True)
            extracted = tar.extractfile(member)
            if extracted is None:
                raise ManagementError(f"Cannot read archive member: {member.name}", status_code=400)
            with extracted, open(target, "wb") as output:
                shutil.copyfileobj(extracted, output)
            try:
                os.chmod(target, member.mode & 0o777)
            except OSError:
                pass


def export_ignore(root: Path, *, default_profile: bool):
    def ignore(directory: str, names: list[str]) -> set[str]:
        skipped = {name for name in names if name == "__pycache__" or name.endswith((".sock", ".tmp", ".pyc", ".pyo"))}
        if default_profile and Path(directory) == root:
            skipped.update(name for name in names if name in DEFAULT_EXPORT_EXCLUDE_ROOT)
        if not default_profile:
            skipped.update(name for name in names if name in CREDENTIAL_EXPORT_EXCLUDE)
        return skipped

    return ignore


def stage_distribution_source(source: str, workdir: Path) -> tuple[Path, str]:
    raw = str(source or "").strip()
    if not raw:
        raise ManagementError("Distribution source is required.", status_code=400)
    path = Path(raw).expanduser()
    if path.is_dir():
        if not (path / DISTRIBUTION_MANIFEST).is_file():
            raise ManagementError("Distribution source must contain distribution.yaml.", status_code=400)
        return path.resolve(), str(path.resolve())
    if raw.endswith(".git") or raw.startswith(("git@", "ssh://", "git://", "http://", "https://")) or re.match(r"^github\.com/[\w.-]+/[\w.-]+/?$", raw):
        clone_url = f"https://{raw.rstrip('/')}" if raw.startswith("github.com/") else raw
        destination = workdir / "source"
        try:
            import subprocess

            subprocess.run(["git", "clone", "--depth", "1", clone_url, str(destination)], check=True, capture_output=True, text=True)
        except FileNotFoundError as exc:
            raise ManagementError("git is required to install profile distributions from git URLs.", status_code=400) from exc
        except subprocess.CalledProcessError as exc:
            raise ManagementError((exc.stderr or exc.stdout or "git clone failed").strip(), status_code=400) from exc
        shutil.rmtree(destination / ".git", ignore_errors=True)
        if not (destination / DISTRIBUTION_MANIFEST).is_file():
            raise ManagementError("Distribution source must contain distribution.yaml.", status_code=400)
        return destination, raw
    raise ManagementError("Distribution source must be a git URL or Core-local directory.", status_code=400)


def copy_distribution_payload(staged: Path, target: Path, manifest: dict[str, Any], *, preserve_config: bool) -> list[str]:
    changed: list[str] = []
    target.mkdir(parents=True, exist_ok=True)
    for entry in staged.iterdir():
        name = entry.name
        if name in DISTRIBUTION_USER_OWNED_EXCLUDE:
            continue
        if name == DISTRIBUTION_ENV_TEMPLATE:
            destination = target / DISTRIBUTION_ENV_EXAMPLE
            shutil.copy2(entry, destination)
            changed.append(DISTRIBUTION_ENV_EXAMPLE)
            continue
        if name == "config.yaml" and preserve_config and (target / "config.yaml").exists():
            continue
        destination = target / name
        if entry.is_dir():
            if destination.exists():
                shutil.rmtree(destination)
            shutil.copytree(
                entry,
                destination,
                ignore=lambda _directory, names: [item for item in names if item in DISTRIBUTION_USER_OWNED_EXCLUDE],
            )
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(entry, destination)
        changed.append(name)

    manifest_path = target / DISTRIBUTION_MANIFEST
    try:
        import yaml  # type: ignore

        manifest_path.write_text(yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8")
    except Exception:
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if DISTRIBUTION_MANIFEST not in changed:
        changed.append(DISTRIBUTION_MANIFEST)
    return sorted(set(changed))


def profile_alias_path(alias: str) -> Path:
    return Path.home() / ".local" / "bin" / alias


def wrapper_is_iris_managed(path: Path) -> bool:
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return False
    return "hermes -p" in content


def alias_collision(alias: str) -> str:
    clean = canonical_profile_name(alias, allow_default=False)
    path = profile_alias_path(clean)
    found = shutil.which(clean)
    if found and Path(found).resolve() != path.resolve():
        return f"'{clean}' conflicts with an existing command at {found}."
    if path.exists() and not wrapper_is_iris_managed(path):
        return f"'{clean}' already exists and is not a Hermes profile wrapper."
    return ""


def parse_skill_metadata(text: str) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        frontmatter: list[str] = []
        for line in lines[1:]:
            if line.strip() == "---":
                break
            frontmatter.append(line)
        metadata.update(_parse_frontmatter("\n".join(frontmatter)))

    for line in lines[:50]:
        stripped = line.strip()
        lowered = stripped.lower()
        if lowered.startswith("# ") and "name" not in metadata:
            metadata["name"] = stripped.lstrip("#").strip()
        elif ":" in stripped:
            key, value = stripped.split(":", 1)
            normalized_key = key.strip().lower()
            if normalized_key in {"name", "description", "category", "version", "tags", "author", "source"}:
                metadata.setdefault(normalized_key, value.strip().strip("\"'"))
    return metadata


def _parse_frontmatter(text: str) -> dict[str, Any]:
    if not text.strip():
        return {}
    try:
        import yaml  # type: ignore

        loaded = yaml.safe_load(text)
        if isinstance(loaded, dict):
            return {str(key).lower(): value for key, value in loaded.items()}
    except Exception:
        pass
    return naive_yaml_subset(text)


def skill_tags(metadata: dict[str, Any]) -> list[str]:
    value = metadata.get("tags") or []
    if isinstance(value, list):
        return [str(tag).strip() for tag in value if str(tag).strip()]
    text = str(value).strip().strip("[]")
    return [tag.strip().strip("\"'") for tag in re.split(r"[,;]", text) if tag.strip().strip("\"'")]


def first_markdown_paragraph(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "---")) or ":" in stripped[:24]:
            continue
        return stripped[:180]
    return ""


def skill_source(relative_path: Path, metadata: dict[str, Any]) -> str:
    source = str(metadata.get("source") or "").lower()
    if source in {"installed", "bundled", "community"}:
        return source
    parts = {part.lower() for part in relative_path.parts}
    if parts & {"bundled", "system", ".system"}:
        return "bundled"
    if parts & {"community", "hub", "store"}:
        return "community"
    return "installed"


def skill_payload(path: Path, profile_root: Path, skills_dir: Path) -> SkillSummary:
    relative_path = path.relative_to(skills_dir)
    text = safe_read_text(path, profile_root)
    metadata = parse_skill_metadata(text)
    stat = safe_stat(path, profile_root)
    title = str(metadata.get("name") or (relative_path.parts[-2] if len(relative_path.parts) > 1 else relative_path.stem))
    category = str(metadata.get("category") or (relative_path.parts[0] if len(relative_path.parts) > 1 else "personal"))
    description = str(metadata.get("description") or first_markdown_paragraph(text) or "Local Hermes skill")
    version = metadata.get("version")
    return SkillSummary(
        id=encode_skill_id(relative_path),
        name=title,
        path=str(path),
        category=category,
        description=description,
        updatedAt=int(stat.st_mtime) if stat else None,
        source=skill_source(relative_path, metadata),
        version=str(version) if version is not None else None,
        tags=skill_tags(metadata),
        bytes=stat.st_size if stat else 0,
        contentHash=content_hash(text),
        metadata=metadata,
    )


def model_payload(model: Any) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def profile_catalog_sort_key(profile: str) -> tuple[int, str]:
    return (0 if profile == "default" else 1, profile.lower())


class HermesStore:
    def __init__(self, hermes_home: str | os.PathLike[str] | None = None) -> None:
        self.root = normalize_hermes_home(hermes_home)

    @property
    def profiles_root(self) -> Path:
        return self.root / "profiles"

    def active_profile_name(self) -> str:
        value = self.raw_active_profile_name()
        if not value:
            return "default"
        try:
            return canonical_profile_name(value)
        except ManagementError:
            return "default"

    def raw_active_profile_name(self) -> str:
        active_path = self.root / "active_profile"
        try:
            return active_path.read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    def profile_directory(self, profile: str) -> Path:
        return assert_profile_directory(self.root, profile_dir(self.root, validate_profile_name(profile)))

    def existing_profile_directory(self, profile: str) -> Path:
        name = str(profile or "").strip()
        if name == "default":
            return assert_profile_directory(self.root, self.root)
        if not name or "/" in name or "\\" in name or name in {".", ".."}:
            raise ManagementError("Profile name is invalid.", status_code=400)
        return assert_profile_directory(self.root, self.profiles_root / name)

    def discover_profile_names(self) -> list[str]:
        names = ["default"]
        if self.profiles_root.is_dir():
            for entry in sorted(self.profiles_root.iterdir(), key=lambda item: item.name.lower()):
                if entry.is_dir() and _is_safe_profile_dir_name(entry.name):
                    names.append(entry.name)
        active = self.raw_active_profile_name()
        if active and active not in names:
            names.append(active)
        return names

    def profile_summary(self, profile: str) -> ProfileSummary:
        name = str(profile or "").strip()
        active = name == self.raw_active_profile_name() or (name == "default" and not self.raw_active_profile_name())
        warnings: list[str] = []
        managed = True
        error: str | None = None
        try:
            canonical = validate_profile_name(name)
        except ManagementError as exc:
            canonical = name
            managed = False
            error = exc.error
            warnings.append("This Hermes profile directory uses a non-canonical name. Iris can inspect it but will not mutate it.")
        directory = self.existing_profile_directory(canonical)
        if not managed:
            return ProfileSummary(
                name=canonical,
                path=str(directory),
                active=active,
                exists=directory.is_dir(),
                provider="unmanaged",
                model="invalid profile name",
                memoryBytes=0,
                memoryUpdatedAt=None,
                skillCount=0,
                gatewayRunning=gateway_running(directory) if directory.is_dir() else False,
                managed=False,
                error=error,
                warnings=warnings,
            )

        config = read_config(directory / "config.yaml", directory)
        provider, model = model_summary(config)
        memory_bytes, memory_updated_at = memory_file_stats(directory)
        return ProfileSummary(
            name=canonical,
            path=str(directory),
            active=active,
            exists=directory.is_dir(),
            provider=provider,
            model=model,
            memoryBytes=memory_bytes,
            memoryUpdatedAt=memory_updated_at,
            skillCount=count_skills(directory / "skills", directory),
            gatewayRunning=gateway_running(directory),
            managed=True,
            warnings=warnings,
        )

    def profiles(self) -> list[ProfileSummary]:
        return [self.profile_summary(name) for name in self.discover_profile_names()]

    def create_profile(self, profile: str, *, no_skills: bool = False) -> tuple[ProfileSummary, list[str]]:
        name = canonical_profile_name(profile, allow_default=False)
        directory = self.profile_directory(name)
        if directory.exists():
            raise ManagementError(f"Profile '{name}' already exists.", status_code=400)
        profile_scaffold(directory)
        warning = seed_soul_file(directory)
        if no_skills:
            (directory / ".no-bundled-skills").write_text(
                "This profile opted out of bundled-skill seeding from Iris.\n",
                encoding="utf-8",
            )
        return self.profile_summary(name), [warning] if warning else []

    def clone_profile(self, source_profile: str, profile: str, *, clone_mode: str = "identity") -> tuple[ProfileSummary, list[str]]:
        source_name = canonical_profile_name(source_profile)
        name = canonical_profile_name(profile, allow_default=False)
        mode = str(clone_mode or "identity").strip().lower()
        if mode not in {"identity", "all"}:
            raise ManagementError("cloneMode must be 'identity' or 'all'.", status_code=400)
        source = self.profile_directory(source_name)
        destination = self.profile_directory(name)
        if not source.exists():
            raise ManagementError(f"Source profile '{source_name}' does not exist.", status_code=404)
        if destination.exists():
            raise ManagementError(f"Profile '{name}' already exists.", status_code=400)
        warnings: list[str] = []
        if mode == "all":
            shutil.copytree(source, destination, ignore=clone_all_ignore(source, exclude_default_root=source_name == "default"))
            for stale in CLONE_ALL_STRIP:
                path = destination / stale
                if path.exists():
                    path.unlink()
            profiles = destination / "profiles"
            if profiles.exists() and source_name == "default":
                shutil.rmtree(profiles)
        else:
            profile_scaffold(destination)
            for relative in CLONE_IDENTITY_FILES:
                src = source / relative
                if src.exists():
                    shutil.copy2(src, destination / relative)
            source_skills = source / "skills"
            if source_skills.is_dir():
                shutil.copytree(source_skills, destination / "skills", dirs_exist_ok=True)
            for relative in CLONE_IDENTITY_SUBDIR_FILES:
                src = source / relative
                if src.exists():
                    dst = destination / relative
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
        warning = seed_soul_file(destination)
        if warning:
            warnings.append(warning)
        return self.profile_summary(name), warnings

    def rename_profile(self, source_profile: str, profile: str) -> ProfileSummary:
        source_name = canonical_profile_name(source_profile)
        name = canonical_profile_name(profile, allow_default=False)
        if source_name == "default":
            raise ManagementError("The default profile cannot be renamed.", status_code=400)
        source = self.profile_directory(source_name)
        destination = self.profile_directory(name)
        if not source.exists():
            raise ManagementError(f"Profile '{source_name}' does not exist.", status_code=404)
        if destination.exists():
            raise ManagementError(f"Profile '{name}' already exists.", status_code=400)
        source.rename(destination)
        if self.active_profile_name() == source_name:
            self.activate_profile(name)
        return self.profile_summary(name)

    def activate_profile(self, profile: str) -> ProfileSummary:
        name = canonical_profile_name(profile)
        directory = self.profile_directory(name)
        if not directory.exists():
            raise ManagementError(f"Profile '{name}' does not exist.", status_code=404)
        active_path = self.root / "active_profile"
        active_path.parent.mkdir(parents=True, exist_ok=True)
        if name == "default":
            active_path.unlink(missing_ok=True)
        else:
            tmp = active_path.with_suffix(".tmp")
            tmp.write_text(name, encoding="utf-8")
            tmp.replace(active_path)
        return self.profile_summary(name)

    def delete_profile(self, profile: str) -> str:
        name = canonical_profile_name(profile)
        if name == "default":
            raise ManagementError("The default profile cannot be deleted.", status_code=400)
        directory = self.profile_directory(name)
        if not directory.exists():
            raise ManagementError(f"Profile '{name}' does not exist.", status_code=404)
        shutil.rmtree(directory)
        if self.active_profile_name() == name:
            self.activate_profile("default")
        return "default" if self.active_profile_name() == "default" else self.active_profile_name()

    def profile_file(self, profile: str, relative_path: str) -> Path:
        directory = self.profile_directory(canonical_profile_name(profile))
        return profile_file_path(directory, relative_path)

    def read_profile_file(self, profile: str, relative_path: str) -> FileContent:
        directory = self.profile_directory(canonical_profile_name(profile))
        path = profile_file_path(directory, relative_path)
        if path.name == ".env":
            raise ManagementError("Use the profile env endpoint for redacted secret status.", status_code=400)
        return file_payload(path, directory)

    def write_profile_file(
        self,
        profile: str,
        relative_path: str,
        content: str,
        expected_content_hash: str | None = None,
    ) -> FileContent:
        directory = self.profile_directory(canonical_profile_name(profile))
        path = profile_file_path(directory, relative_path)
        if path.name == ".env":
            raise ManagementError("Use the profile env endpoint for write-only secret updates.", status_code=400)
        current = file_payload(path, directory)
        if expected_content_hash is not None and current.contentHash != expected_content_hash:
            raise ManagementError("Profile file changed on disk. Refresh before saving.", status_code=409)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return file_payload(path, directory)

    def reset_soul_file(self, profile: str, expected_content_hash: str | None = None) -> FileContent:
        directory = self.profile_directory(canonical_profile_name(profile))
        path = profile_file_path(directory, "SOUL.md")
        current = file_payload(path, directory)
        if expected_content_hash is not None and current.contentHash != expected_content_hash:
            raise ManagementError("SOUL.md changed on disk. Refresh before resetting.", status_code=409)
        content, _warning = default_soul_md()
        path.write_text(content, encoding="utf-8")
        return file_payload(path, directory)

    def profile_identity(self, profile: str) -> dict[str, Any]:
        name = canonical_profile_name(profile)
        directory = self.profile_directory(name)
        soul = file_payload(directory / "SOUL.md", directory)
        config = config_summary(directory / "config.yaml", directory)
        env = env_status(directory / ".env", directory)
        distribution = distribution_manifest(directory / DISTRIBUTION_MANIFEST, directory)
        return {
            "ok": True,
            "profile": name,
            "path": str(directory),
            "soul": {"ok": True, "profile": name, **soul.model_dump()},
            "config": config,
            "env": env,
            "distribution": distribution,
        }

    def profile_config(self, profile: str) -> dict[str, Any]:
        name = canonical_profile_name(profile)
        directory = self.profile_directory(name)
        return {"ok": True, "profile": name, **config_summary(directory / "config.yaml", directory)}

    def profile_env(self, profile: str) -> dict[str, Any]:
        name = canonical_profile_name(profile)
        directory = self.profile_directory(name)
        return {"ok": True, "profile": name, **env_status(directory / ".env", directory)}

    def update_profile_env(self, profile: str, values: dict[str, str], remove_keys: list[str] | set[str]) -> dict[str, Any]:
        name = canonical_profile_name(profile)
        directory = self.profile_directory(name)
        update_env_file(directory / ".env", directory, values, remove_keys)
        return self.profile_env(name)

    def export_profile(self, profile: str, output_path: Path) -> Path:
        name = canonical_profile_name(profile)
        directory = self.profile_directory(name)
        if not directory.is_dir():
            raise ManagementError(f"Profile '{name}' does not exist.", status_code=404)
        base = str(output_path).removesuffix(".tar.gz").removesuffix(".tgz")
        with tempfile.TemporaryDirectory(prefix="iris_profile_export_") as tmpdir:
            staged = Path(tmpdir) / name
            shutil.copytree(directory, staged, ignore=export_ignore(directory, default_profile=name == "default"))
            return Path(shutil.make_archive(base, "gztar", tmpdir, name))

    def import_profile(self, archive_path: Path, name: str = "") -> tuple[ProfileSummary, list[str]]:
        archive_root = inspect_archive_root(archive_path)
        target_name = canonical_profile_name(name or archive_root, allow_default=False)
        destination = self.profile_directory(target_name)
        if destination.exists():
            raise ManagementError(f"Profile '{target_name}' already exists.", status_code=409)
        self.profiles_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="iris_profile_import_") as tmpdir:
            staging = Path(tmpdir)
            safe_extract_archive(archive_path, staging)
            source = staging / archive_root
            if not source.is_dir():
                raise ManagementError("Profile archive root is missing.", status_code=400)
            final_source = source
            if archive_root != target_name:
                final_source = staging / target_name
                source.rename(final_source)
            shutil.move(str(final_source), str(destination))
        profile_scaffold(destination)
        warning = seed_soul_file(destination)
        return self.profile_summary(target_name), [warning] if warning else []

    def install_distribution(
        self,
        *,
        source: str,
        name: str = "",
        force: bool = False,
    ) -> tuple[ProfileSummary, dict[str, Any], list[str]]:
        with tempfile.TemporaryDirectory(prefix="iris_dist_install_") as tmpdir:
            staged, provenance = stage_distribution_source(source, Path(tmpdir))
            manifest = distribution_manifest(staged / DISTRIBUTION_MANIFEST, staged)
            if not manifest or not manifest.get("name"):
                raise ManagementError("Distribution manifest is missing a name.", status_code=400)
            target_name = canonical_profile_name(name or str(manifest.get("name") or ""), allow_default=False)
            target = self.profile_directory(target_name)
            if target.exists() and not force:
                raise ManagementError(f"Profile '{target_name}' already exists.", status_code=409)
            profile_scaffold(target)
            manifest_for_write = {
                "name": target_name,
                "version": manifest.get("version") or "0.1.0",
                "description": manifest.get("description") or "",
                "hermes_requires": manifest.get("hermesRequires") or "",
                "author": manifest.get("author") or "",
                "license": manifest.get("license") or "",
                "env_requires": manifest.get("envRequires") or [],
                "distribution_owned": manifest.get("distributionOwned") or [],
                "source": provenance,
                "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            changed = copy_distribution_payload(staged, target, manifest_for_write, preserve_config=False)
            return self.profile_summary(target_name), {"manifest": manifest_for_write, "changedPaths": changed}, []

    def update_distribution(self, profile: str, *, force_config: bool = False) -> dict[str, Any]:
        name = canonical_profile_name(profile)
        directory = self.profile_directory(name)
        current = distribution_manifest(directory / DISTRIBUTION_MANIFEST, directory)
        if not current:
            raise ManagementError("This profile is not backed by a distribution.", status_code=400)
        source = str(current.get("source") or "").strip()
        if not source:
            raise ManagementError("Distribution source is missing from distribution.yaml.", status_code=400)
        with tempfile.TemporaryDirectory(prefix="iris_dist_update_") as tmpdir:
            staged, provenance = stage_distribution_source(source, Path(tmpdir))
            incoming = distribution_manifest(staged / DISTRIBUTION_MANIFEST, staged)
            if not incoming:
                raise ManagementError("Distribution source is missing distribution.yaml.", status_code=400)
            manifest_for_write = {
                "name": name,
                "version": incoming.get("version") or current.get("version") or "0.1.0",
                "description": incoming.get("description") or "",
                "hermes_requires": incoming.get("hermesRequires") or "",
                "author": incoming.get("author") or "",
                "license": incoming.get("license") or "",
                "env_requires": incoming.get("envRequires") or [],
                "distribution_owned": incoming.get("distributionOwned") or [],
                "source": provenance,
                "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            changed = copy_distribution_payload(staged, directory, manifest_for_write, preserve_config=not force_config)
        return {
            "ok": True,
            "profile": name,
            "distribution": distribution_manifest(directory / DISTRIBUTION_MANIFEST, directory),
            "changedPaths": changed,
            "preservedUserOwnedPaths": sorted(DISTRIBUTION_USER_OWNED_EXCLUDE),
        }

    def distribution_info(self, profile: str) -> dict[str, Any]:
        name = canonical_profile_name(profile)
        directory = self.profile_directory(name)
        return {
            "ok": True,
            "profile": name,
            "distribution": distribution_manifest(directory / DISTRIBUTION_MANIFEST, directory),
        }

    def alias_status(self, profile: str, alias: str = "") -> dict[str, Any]:
        name = canonical_profile_name(profile)
        alias_name = canonical_profile_name(alias or name, allow_default=False)
        path = profile_alias_path(alias_name)
        collision = alias_collision(alias_name)
        return {
            "ok": True,
            "profile": name,
            "alias": alias_name,
            "path": str(path),
            "exists": path.exists() and wrapper_is_iris_managed(path),
            "inPath": str(path.parent) in os.environ.get("PATH", "").split(os.pathsep),
            "collision": collision,
        }

    def create_alias(self, profile: str, alias: str = "") -> dict[str, Any]:
        name = canonical_profile_name(profile)
        alias_name = canonical_profile_name(alias or name, allow_default=False)
        collision = alias_collision(alias_name)
        if collision:
            raise ManagementError(collision, status_code=409)
        path = profile_alias_path(alias_name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'#!/bin/sh\nexec hermes -p {name} "$@"\n', encoding="utf-8")
        path.chmod(path.stat().st_mode | 0o111)
        return self.alias_status(name, alias_name)

    def remove_alias(self, profile: str, alias: str = "") -> dict[str, Any]:
        name = canonical_profile_name(profile)
        alias_name = canonical_profile_name(alias or name, allow_default=False)
        path = profile_alias_path(alias_name)
        if path.exists() and wrapper_is_iris_managed(path):
            path.unlink()
        return self.alias_status(name, alias_name)

    def memory_files(self, profile: str) -> tuple[FileContent, FileContent]:
        directory = self.profile_directory(canonical_profile_name(profile))
        memories = directory / "memories"
        return (
            file_payload(memories / "MEMORY.md", directory),
            file_payload(memories / "USER.md", directory),
        )

    def save_memory_file(
        self,
        profile: str,
        file_key: str,
        content: str,
        expected_updated_at: int | None = None,
        expected_content_hash: str | None = None,
    ) -> tuple[FileContent, FileContent]:
        directory = self.profile_directory(canonical_profile_name(profile))
        path = memory_file_path(directory, file_key)
        current = file_payload(path, directory)
        if expected_content_hash is not None and current.contentHash != expected_content_hash:
            raise ManagementError(
                "Memory changed on disk. Refresh before saving so you do not overwrite newer notes.",
                status_code=409,
            )
        if expected_content_hash is None and expected_updated_at is not None and current.updatedAt != expected_updated_at:
            raise ManagementError(
                "Memory changed on disk. Refresh before saving so you do not overwrite newer notes.",
                status_code=409,
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return self.memory_files(profile)

    def reset_memory_file(self, profile: str, file_key: str) -> tuple[FileContent, FileContent]:
        directory = self.profile_directory(canonical_profile_name(profile))
        targets = ["memory", "user"] if file_key.strip().lower() == "all" else [file_key]
        for target in targets:
            path = memory_file_path(directory, target)
            if path.exists():
                path.unlink()
        return self.memory_files(profile)

    def skills(self, profile: str) -> list[SkillSummary]:
        directory = self.profile_directory(canonical_profile_name(profile))
        skills_dir = directory / "skills"
        rows: list[SkillSummary] = []
        for path in skill_entrypoint_paths(skills_dir, directory):
            rows.append(skill_payload(path, directory, skills_dir.resolve()))
        return rows

    def skill_detail(self, profile: str, skill_id: str) -> tuple[SkillSummary, str]:
        directory = self.profile_directory(canonical_profile_name(profile))
        skills_dir = directory / "skills"
        path, _relative_path = safe_skill_path(skills_dir, directory, skill_id)
        if not path.is_file():
            raise ManagementError("Skill was not found.", status_code=404)
        summary = skill_payload(path, directory, skills_dir.resolve())
        return summary, safe_read_text(path, directory)

    def skill_catalog(
        self,
        profile: str,
        *,
        agents_by_profile: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        target = canonical_profile_name(profile)
        installed = self.skills(target)
        installed_relative_paths = {
            decode_skill_id(skill.id).as_posix()
            for skill in installed
        }
        available: list[dict[str, Any]] = []
        agents = agents_by_profile or {}
        for source_profile in sorted(self.discover_profile_names(), key=profile_catalog_sort_key):
            try:
                source = validate_profile_name(source_profile)
            except ManagementError:
                continue
            if source == target:
                continue
            source_agent = agents.get(source) or {}
            source_agent_id = str(source_agent.get("id") or "")
            for summary in self.skills(source):
                relative_path = decode_skill_id(summary.id).as_posix()
                available.append({
                    **model_payload(summary),
                    "catalogId": f"{source_agent_id or source}:{summary.id}",
                    "installed": False,
                    "sourceProfile": source,
                    "sourceAgentId": source_agent_id,
                    "sourceSkillId": summary.id,
                    "targetProfile": target,
                    "conflict": relative_path in installed_relative_paths,
                })
        return {
            "ok": True,
            "profile": target,
            "installed": installed,
            "available": available,
            "generatedAt": checked_at(),
        }

    def install_skill(self, profile: str, payload: dict[str, Any]) -> tuple[SkillSummary, str]:
        target = canonical_profile_name(profile)
        source = canonical_profile_name(str(payload.get("sourceProfile") or "").strip())
        if source == target:
            raise ManagementError("Source and target profiles must be different.", status_code=400)
        source_skill_id = str(payload.get("sourceSkillId") or "").strip()
        if not source_skill_id:
            raise ManagementError("Source skill id is required.", status_code=400)

        source_directory = self.profile_directory(source)
        source_skills_dir = source_directory / "skills"
        source_path, relative_path = safe_skill_path(source_skills_dir, source_directory, source_skill_id)
        if not source_path.is_file():
            raise ManagementError("Source skill was not found.", status_code=404)

        target_directory = self.profile_directory(target)
        target_skills_dir = target_directory / "skills"
        target_skills_dir.mkdir(parents=True, exist_ok=True)
        target_path = assert_within_base(target_skills_dir / relative_path, target_directory)
        try:
            target_path.relative_to(target_skills_dir.resolve())
        except ValueError as exc:
            raise ManagementError(
                "Installed skill path must stay inside the target profile skills directory.",
                status_code=400,
            ) from exc
        if target_path.exists() and not bool(payload.get("overwrite")):
            raise ManagementError("A skill already exists at that path.", status_code=409)

        content = safe_read_text(source_path, source_directory)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(content, encoding="utf-8")
        summary = skill_payload(target_path, target_directory, target_skills_dir.resolve())
        return summary, safe_read_text(target_path, target_directory)

    def save_skill(self, profile: str, payload: dict[str, Any], skill_id: str = "") -> tuple[SkillSummary, str]:
        directory = self.profile_directory(canonical_profile_name(profile))
        skills_dir = directory / "skills"
        skills_dir.mkdir(parents=True, exist_ok=True)
        path = skill_path_for_write(skills_dir, directory, payload, skill_id=skill_id)
        relative_path = path.relative_to(skills_dir.resolve())
        content = str(payload.get("content") or "").strip()
        if not content:
            content = default_skill_content(
                str(payload.get("name") or path.parent.name),
                str(payload.get("category") or (relative_path.parts[0] if len(relative_path.parts) > 1 else "personal")),
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content.rstrip() + "\n", encoding="utf-8")
        summary = skill_payload(path, directory, skills_dir.resolve())
        return summary, safe_read_text(path, directory)

    def delete_skill(self, profile: str, skill_id: str) -> dict[str, Any]:
        directory = self.profile_directory(canonical_profile_name(profile))
        skills_dir = directory / "skills"
        path, _relative_path = safe_skill_path(skills_dir, directory, skill_id)
        if not path.is_file():
            raise ManagementError("Skill was not found.", status_code=404)

        skills_root = skills_dir.resolve()
        skill_directory = path.parent.resolve()
        try:
            skill_directory.relative_to(skills_root)
        except ValueError as exc:
            raise ManagementError(
                "Skill removal must stay inside the active profile skills directory.",
                status_code=400,
            ) from exc
        if skill_directory == skills_root:
            raise ManagementError("Refusing to remove the profile skills directory.", status_code=400)
        if (skill_directory / "SKILL.md").resolve() != path:
            raise ManagementError("Skill removal target is invalid.", status_code=400)

        deleted_path = str(path)
        shutil.rmtree(skill_directory)
        parent = skill_directory.parent
        while parent != skills_root:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
        return {
            "deletedSkillId": skill_id,
            "deletedPath": deleted_path,
        }

    def sessions(self, profile: str, limit: int | None = 80) -> SessionDiscovery:
        directory = self.profile_directory(canonical_profile_name(profile))
        return discover_sessions(directory, limit)

    def session_detail(self, profile: str, session_id: str) -> SessionDetail:
        directory = self.profile_directory(canonical_profile_name(profile))
        return discover_session_detail(directory, session_id)

    def session_summaries(
        self,
        profile: str,
        *,
        session_ids: set[str] | None = None,
        chat_ids: set[str] | None = None,
    ) -> list[Any]:
        directory = self.profile_directory(canonical_profile_name(profile))
        return discover_session_summaries(directory, session_ids=session_ids, chat_ids=chat_ids)

    def rename_session(self, profile: str, session_id: str, title: str) -> SessionDetail:
        directory = self.profile_directory(canonical_profile_name(profile))
        clean_title = title.strip()
        if not clean_title:
            raise ManagementError("Session title is required.", status_code=400)
        if len(clean_title) > 160:
            raise ManagementError("Session title must be 160 characters or fewer.", status_code=400)
        if self._rename_sqlite_session(directory, session_id, clean_title):
            return self.session_detail(profile, session_id)
        if self._rename_session_file_session(directory, session_id, clean_title):
            return self.session_detail(profile, session_id)
        raise ManagementError("Session was not found.", status_code=404)

    def delete_session(self, profile: str, session_id: str) -> None:
        directory = self.profile_directory(canonical_profile_name(profile))
        clean_id = session_id.strip()
        if not clean_id:
            raise ManagementError("Session id is required.", status_code=400)
        deleted = self._delete_sqlite_session(directory, clean_id)
        deleted = self._delete_session_file_session(directory, clean_id) or deleted
        if not deleted:
            raise ManagementError("Session was not found.", status_code=404)
        self._delete_session_origin(directory, clean_id)

    def _delete_sqlite_session(self, directory: Path, session_id: str) -> bool:
        for db_path in sqlite_candidates(directory):
            try:
                safe_path = assert_within_profile(db_path, directory)
                connection = sqlite3.connect(f"file:{safe_path.as_posix()}?mode=rw", uri=True)
            except Exception:
                continue
            try:
                connection.row_factory = sqlite3.Row
                schema = inspect_sqlite_schema(connection)
                session_table = choose_session_table(schema.tables)
                if session_table is None:
                    continue
                columns = normalize_columns(schema.tables[session_table])
                id_column = next((columns[key] for key in ID_COLUMNS if key in columns), "")
                if not id_column:
                    continue
                session_deleted = connection.execute(
                    (
                        f"delete from {quote_identifier(session_table)} "
                        f"where {quote_identifier(id_column)} = ?"
                    ),
                    (session_id,),
                ).rowcount
                if not session_deleted:
                    connection.rollback()
                    continue
                message_table = choose_message_table(schema.tables, session_table)
                if message_table:
                    message_columns = normalize_columns(schema.tables[message_table])
                    link_column = first_message_link_column(message_columns)
                    if link_column:
                        connection.execute(
                            (
                                f"delete from {quote_identifier(message_table)} "
                                f"where {quote_identifier(link_column)} = ?"
                            ),
                            (session_id,),
                        )
                connection.commit()
                return True
            except sqlite3.Error:
                connection.rollback()
                continue
            finally:
                connection.close()
        return False

    def _delete_session_file_session(self, directory: Path, session_id: str) -> bool:
        sessions_dir = directory / "sessions"
        try:
            safe_sessions_dir = assert_within_profile(sessions_dir, directory)
        except ManagementError:
            return False
        if not safe_sessions_dir.is_dir():
            return False
        for path in sorted(safe_sessions_dir.glob("*.json"), key=lambda item: item.name.lower()):
            if path.name == "sessions.json":
                continue
            try:
                safe_path = assert_within_profile(path, directory)
                payload = json.loads(safe_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ManagementError):
                continue
            if not isinstance(payload, dict):
                continue
            summary = normalize_session_file(payload)
            if summary is None or summary.id != session_id:
                continue
            safe_path.unlink()
            return True
        return False

    def _delete_session_origin(self, directory: Path, session_id: str) -> None:
        path = directory / "sessions" / "sessions.json"
        try:
            safe_path = assert_within_profile(path, directory)
            loaded = json.loads(safe_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ManagementError):
            return
        if not isinstance(loaded, dict):
            return
        next_loaded = {
            key: value
            for key, value in loaded.items()
            if key != session_id
            and not (isinstance(value, dict) and str(value.get("session_id") or "").strip() == session_id)
        }
        if len(next_loaded) != len(loaded):
            safe_path.write_text(json.dumps(next_loaded, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def _rename_sqlite_session(self, directory: Path, session_id: str, title: str) -> bool:
        for db_path in sqlite_candidates(directory):
            try:
                safe_path = assert_within_profile(db_path, directory)
                connection = sqlite3.connect(f"file:{safe_path.as_posix()}?mode=rw", uri=True)
            except Exception:
                continue
            try:
                connection.row_factory = sqlite3.Row
                schema = inspect_sqlite_schema(connection)
                session_table = choose_session_table(schema.tables)
                if session_table is None:
                    continue
                columns = normalize_columns(schema.tables[session_table])
                id_column = next((columns[key] for key in ID_COLUMNS if key in columns), "")
                title_column = next((columns[key] for key in TITLE_COLUMNS if key in columns), "")
                if not id_column or not title_column:
                    continue
                cursor = connection.execute(
                    (
                        f"update {quote_identifier(session_table)} "
                        f"set {quote_identifier(title_column)} = ? "
                        f"where {quote_identifier(id_column)} = ?"
                    ),
                    (title, session_id),
                )
                connection.commit()
                if cursor.rowcount:
                    return True
            except sqlite3.Error:
                continue
            finally:
                connection.close()
        return False

    def _rename_session_file_session(self, directory: Path, session_id: str, title: str) -> bool:
        sessions_dir = directory / "sessions"
        try:
            safe_sessions_dir = assert_within_profile(sessions_dir, directory)
        except ManagementError:
            return False
        if not safe_sessions_dir.is_dir():
            return False
        for path in sorted(safe_sessions_dir.glob("*.json"), key=lambda item: item.name.lower()):
            try:
                safe_path = assert_within_profile(path, directory)
                payload = json.loads(safe_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ManagementError):
                continue
            if not isinstance(payload, dict):
                continue
            summary = normalize_session_file(payload)
            if summary is None or summary.id != session_id:
                continue
            payload["title"] = title
            safe_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return True
        return False
