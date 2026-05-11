"""Read-only access to Hermes profile metadata."""

from __future__ import annotations

import base64
import ctypes
import json
import os
import re
import shutil
import sqlite3
import time
from pathlib import Path
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


PROFILE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


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


def validate_profile_name(value: str) -> str:
    name = value.strip()
    if not PROFILE_NAME_RE.fullmatch(name):
        raise ManagementError(
            "Profile names may use letters, numbers, dots, dashes, and underscores.",
            status_code=400,
        )
    return name


def profile_dir(root: Path, profile: str) -> Path:
    name = validate_profile_name(profile)
    return root if name == "default" else root / "profiles" / name


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


def _is_safe_profile_dir_name(name: str) -> bool:
    return bool(PROFILE_NAME_RE.fullmatch(name))


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
    model = str(model_config.get("model") or model_config.get("name") or config.get("model") or "")
    if isinstance(config.get("model"), str):
        model = str(config.get("model") or "")
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


def memory_file_path(directory: Path, file_key: str) -> Path:
    normalized = file_key.strip().lower()
    if normalized in {"memory", "memory.md"}:
        return directory / "memories" / "MEMORY.md"
    if normalized in {"user", "user.md"}:
        return directory / "memories" / "USER.md"
    raise ManagementError("Memory writes are limited to MEMORY.md and USER.md.", status_code=400)


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
    )


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
        metadata=metadata,
    )


class HermesStore:
    def __init__(self, hermes_home: str | os.PathLike[str] | None = None) -> None:
        self.root = normalize_hermes_home(hermes_home)

    @property
    def profiles_root(self) -> Path:
        return self.root / "profiles"

    def active_profile_name(self) -> str:
        active_path = self.root / "active_profile"
        try:
            value = active_path.read_text(encoding="utf-8").strip()
        except OSError:
            return "default"
        if not value:
            return "default"
        try:
            return validate_profile_name(value)
        except ManagementError:
            return "default"

    def profile_directory(self, profile: str) -> Path:
        return assert_profile_directory(self.root, profile_dir(self.root, profile))

    def discover_profile_names(self) -> list[str]:
        names = ["default"]
        if self.profiles_root.is_dir():
            for entry in sorted(self.profiles_root.iterdir(), key=lambda item: item.name.lower()):
                if entry.is_dir() and _is_safe_profile_dir_name(entry.name):
                    names.append(entry.name)
        active = self.active_profile_name()
        if active not in names:
            names.append(active)
        return names

    def profile_summary(self, profile: str) -> ProfileSummary:
        name = validate_profile_name(profile)
        active = name == self.active_profile_name()
        directory = self.profile_directory(name)
        config = read_config(directory / "config.yaml", directory)
        provider, model = model_summary(config)
        memory_bytes, memory_updated_at = memory_file_stats(directory)
        return ProfileSummary(
            name=name,
            path=str(directory),
            active=active,
            exists=directory.is_dir(),
            provider=provider,
            model=model,
            memoryBytes=memory_bytes,
            memoryUpdatedAt=memory_updated_at,
            skillCount=count_skills(directory / "skills", directory),
            gatewayRunning=gateway_running(directory),
        )

    def profiles(self) -> list[ProfileSummary]:
        return [self.profile_summary(name) for name in self.discover_profile_names()]

    def create_profile(self, profile: str) -> ProfileSummary:
        name = validate_profile_name(profile)
        directory = self.profile_directory(name)
        if directory.exists():
            raise ManagementError(f"Profile '{name}' already exists.", status_code=400)
        profile_scaffold(directory)
        return self.profile_summary(name)

    def clone_profile(self, source_profile: str, profile: str) -> ProfileSummary:
        source_name = validate_profile_name(source_profile)
        name = validate_profile_name(profile)
        source = self.profile_directory(source_name)
        destination = self.profile_directory(name)
        if not source.exists():
            raise ManagementError(f"Source profile '{source_name}' does not exist.", status_code=404)
        if destination.exists():
            raise ManagementError(f"Profile '{name}' already exists.", status_code=400)
        shutil.copytree(source, destination, ignore=clone_ignore(source_name))
        return self.profile_summary(name)

    def rename_profile(self, source_profile: str, profile: str) -> ProfileSummary:
        source_name = validate_profile_name(source_profile)
        name = validate_profile_name(profile)
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
            (self.root / "active_profile").write_text(name, encoding="utf-8")
        return self.profile_summary(name)

    def activate_profile(self, profile: str) -> ProfileSummary:
        name = validate_profile_name(profile)
        directory = self.profile_directory(name)
        if not directory.exists():
            raise ManagementError(f"Profile '{name}' does not exist.", status_code=404)
        (self.root / "active_profile").write_text(name, encoding="utf-8")
        return self.profile_summary(name)

    def delete_profile(self, profile: str) -> str:
        name = validate_profile_name(profile)
        if name == "default":
            raise ManagementError("The default profile cannot be deleted.", status_code=400)
        directory = self.profile_directory(name)
        if not directory.exists():
            raise ManagementError(f"Profile '{name}' does not exist.", status_code=404)
        shutil.rmtree(directory)
        if self.active_profile_name() == name:
            (self.root / "active_profile").write_text("default", encoding="utf-8")
        return "default" if self.active_profile_name() == "default" else self.active_profile_name()

    def memory_files(self, profile: str) -> tuple[FileContent, FileContent]:
        directory = self.profile_directory(validate_profile_name(profile))
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
    ) -> tuple[FileContent, FileContent]:
        directory = self.profile_directory(validate_profile_name(profile))
        path = memory_file_path(directory, file_key)
        current_updated_at = file_payload(path, directory).updatedAt
        if expected_updated_at is not None and current_updated_at != expected_updated_at:
            raise ManagementError(
                "Memory changed on disk. Refresh before saving so you do not overwrite newer notes.",
                status_code=409,
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return self.memory_files(profile)

    def reset_memory_file(self, profile: str, file_key: str) -> tuple[FileContent, FileContent]:
        directory = self.profile_directory(validate_profile_name(profile))
        targets = ["memory", "user"] if file_key.strip().lower() == "all" else [file_key]
        for target in targets:
            path = memory_file_path(directory, target)
            if path.exists():
                path.unlink()
        return self.memory_files(profile)

    def skills(self, profile: str) -> list[SkillSummary]:
        directory = self.profile_directory(validate_profile_name(profile))
        skills_dir = directory / "skills"
        rows: list[SkillSummary] = []
        for path in skill_entrypoint_paths(skills_dir, directory):
            rows.append(skill_payload(path, directory, skills_dir.resolve()))
        return rows

    def skill_detail(self, profile: str, skill_id: str) -> tuple[SkillSummary, str]:
        directory = self.profile_directory(validate_profile_name(profile))
        skills_dir = directory / "skills"
        path, _relative_path = safe_skill_path(skills_dir, directory, skill_id)
        if not path.is_file():
            raise ManagementError("Skill was not found.", status_code=404)
        summary = skill_payload(path, directory, skills_dir.resolve())
        return summary, safe_read_text(path, directory)

    def save_skill(self, profile: str, payload: dict[str, Any], skill_id: str = "") -> tuple[SkillSummary, str]:
        directory = self.profile_directory(validate_profile_name(profile))
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

    def sessions(self, profile: str, limit: int | None = 80) -> SessionDiscovery:
        directory = self.profile_directory(validate_profile_name(profile))
        return discover_sessions(directory, limit)

    def session_detail(self, profile: str, session_id: str) -> SessionDetail:
        directory = self.profile_directory(validate_profile_name(profile))
        return discover_session_detail(directory, session_id)

    def session_summaries(
        self,
        profile: str,
        *,
        session_ids: set[str] | None = None,
        chat_ids: set[str] | None = None,
    ) -> list[Any]:
        directory = self.profile_directory(validate_profile_name(profile))
        return discover_session_summaries(directory, session_ids=session_ids, chat_ids=chat_ids)

    def rename_session(self, profile: str, session_id: str, title: str) -> SessionDetail:
        directory = self.profile_directory(validate_profile_name(profile))
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
        directory = self.profile_directory(validate_profile_name(profile))
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
