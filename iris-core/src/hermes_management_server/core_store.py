"""SQLite storage for the Iris Core API."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any

from .models import ConversationMessage, ConversationSummary, ProfileSummary


CORE_SCHEMA_VERSION = 6
DEFAULT_RUNTIME_ID = "runtime_local_hermes"
PROFILE_SLUG_RE = re.compile(r"[^A-Za-z0-9_.-]+")
DEFAULT_MAX_ATTACHMENT_SIZE_MB = 250
MAX_ATTACHMENT_SIZE_BYTES = DEFAULT_MAX_ATTACHMENT_SIZE_MB * 1024 * 1024
MAX_ATTACHMENTS_PER_MESSAGE = 8
ATTACHMENT_KINDS = {"image", "document", "audio", "video", "archive", "code", "file"}
DOCUMENT_ATTACHMENT_MIME_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "application/rtf",
    "application/json",
    "application/xml",
    "application/epub+zip",
    "text/csv",
    "text/html",
}
CODE_ATTACHMENT_MIME_TYPES = {
    "application/javascript",
    "application/typescript",
    "application/toml",
    "application/x-yaml",
    "application/yaml",
    "text/markdown",
}
ARCHIVE_ATTACHMENT_MIME_TYPES = {
    "application/zip",
    "application/x-tar",
    "application/gzip",
    "application/x-gzip",
    "application/x-7z-compressed",
    "application/vnd.rar",
    "application/x-rar-compressed",
}
DUPLICATE_RUNTIME_TABLES = (
    "agents",
    "conversations",
    "conversation_runtime_links",
    "message_events",
    "conversation_messages",
    "automations",
)
CORE_OWNED_TABLES = (
    "schema_meta",
    "devices",
    "runtimes",
    "device_cursors",
    "client_message_metadata",
    "attachments",
    "message_attachments",
    "projects",
    "project_conversations",
    "conversation_read_state",
)
CONVERSATION_READ_STATES = {"read", "unread"}


def default_core_store_path() -> Path:
    return Path.home() / ".iris" / "core.sqlite3"


def legacy_core_store_path() -> Path:
    return Path.home() / ".agent-ui" / "core.sqlite3"


def default_attachment_root() -> Path:
    return Path.home() / ".iris" / "attachments"


def migrate_default_core_store_path() -> Path:
    target = default_core_store_path()
    legacy = legacy_core_store_path()
    if legacy.exists() and not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(legacy, target)
        backup_core_database(legacy, "backup-moved-to-iris")
    return target


def backup_core_database(path: Path, reason: str) -> Path:
    timestamp = time.strftime("%Y%m%d%H%M%S")
    backup_path = path.with_name(f"{path.name}.{reason}-{timestamp}")
    shutil.copy2(path, backup_path)
    return backup_path


def now() -> int:
    return int(time.time())


def dumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def loads(value: str | None, fallback: Any = None) -> Any:
    if not value:
        return {} if fallback is None else fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {} if fallback is None else fallback


def stable_hash(*parts: str, length: int = 18) -> str:
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:length]


def random_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(18).replace('-', '').replace('_', '')[:22]}"


def agent_id_for_profile(runtime_id: str, profile: str) -> str:
    safe_profile = PROFILE_SLUG_RE.sub("_", profile.strip()).strip("._-") or "default"
    return f"agent_{stable_hash(runtime_id, profile, length=10)}_{safe_profile}"


def conversation_id_for_runtime(runtime_id: str, profile: str, external_id: str) -> str:
    return f"conv_{stable_hash(runtime_id, profile, external_id, length=22)}"


def chat_id_for_conversation(conversation_id: str) -> str:
    return f"core-{conversation_id}"


def clamp_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return min(max(number, minimum), maximum)


def max_attachment_size_mb() -> int:
    return clamp_int(
        os.environ.get("IRIS_MAX_ATTACHMENT_SIZE_MB"),
        default=DEFAULT_MAX_ATTACHMENT_SIZE_MB,
        minimum=1,
        maximum=4096,
    )


def max_attachment_size_bytes() -> int:
    return max_attachment_size_mb() * 1024 * 1024


def attachment_size_limit_label() -> str:
    return f"{max_attachment_size_mb()} MB"


class CoreStore:
    def __init__(self, path: str | Path | None = None, *, auto_migrate: bool = True) -> None:
        self.explicit_path = path is not None
        self.path = Path(path).expanduser() if path else migrate_default_core_store_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.attachment_root = self.path.parent / "attachments" if self.explicit_path else default_attachment_root()
        self.migration_warning = ""
        self._initialize(auto_migrate=auto_migrate)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self, *, auto_migrate: bool) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                create table if not exists schema_meta (
                  key text primary key,
                  value text not null
                );

                create table if not exists devices (
                  id text primary key,
                  name text not null,
                  kind text not null,
                  token_hash text not null,
                  created_at integer not null,
                  last_seen_at integer,
                  revoked_at integer,
                  metadata_json text not null
                );

                create unique index if not exists idx_devices_token_hash
                  on devices(token_hash);

                create table if not exists runtimes (
                  id text primary key,
                  kind text not null,
                  name text not null,
                  connection_json text not null,
                  enabled integer not null default 1,
                  created_at integer not null,
                  updated_at integer not null,
                  last_probe_json text not null
                );

                create table if not exists device_cursors (
                  device_id text not null,
                  stream_name text not null,
                  last_cursor integer not null,
                  updated_at integer not null,
                  primary key (device_id, stream_name)
                );

                create table if not exists client_message_metadata (
                  runtime_id text not null,
                  profile text not null,
                  chat_id text not null,
                  message_id text not null,
                  content_hash text not null,
                  metadata_json text not null,
                  created_at integer not null,
                  updated_at integer not null,
                  primary key (runtime_id, profile, chat_id, message_id)
                );

                create index if not exists idx_client_message_metadata_content
                  on client_message_metadata(runtime_id, profile, chat_id, content_hash);

                create table if not exists attachments (
                  id text primary key,
                  owner_device_id text,
                  runtime_id text not null,
                  profile text not null,
                  conversation_id text,
                  message_id text,
                  name text not null,
                  mime_type text not null,
                  kind text not null,
                  size_bytes integer not null,
                  sha256 text not null,
                  storage_kind text not null,
                  storage_path text not null,
                  created_at integer not null,
                  updated_at integer not null,
                  deleted_at integer,
                  metadata_json text not null
                );

                create index if not exists idx_attachments_conversation
                  on attachments(runtime_id, profile, conversation_id);

                create index if not exists idx_attachments_message
                  on attachments(runtime_id, profile, message_id);

                create index if not exists idx_attachments_sha256
                  on attachments(sha256);

                create table if not exists message_attachments (
                  runtime_id text not null,
                  profile text not null,
                  chat_id text not null,
                  message_id text not null,
                  attachment_id text not null,
                  position integer not null,
                  created_at integer not null,
                  primary key (runtime_id, profile, chat_id, message_id, attachment_id)
                );

                create table if not exists projects (
                  id text primary key,
                  name text not null,
                  slug text not null unique,
                  default_agent_id text not null,
                  system_prompt text not null,
                  created_at integer not null,
                  updated_at integer not null,
                  archived_at integer,
                  metadata_json text not null
                );

                create table if not exists project_conversations (
                  project_id text not null,
                  conversation_id text not null,
                  agent_id text not null,
                  runtime_id text not null,
                  runtime_profile text not null,
                  external_session_id text,
                  external_chat_id text,
                  created_at integer not null,
                  updated_at integer not null,
                  metadata_json text not null,
                  primary key (project_id, conversation_id),
                  foreign key (project_id) references projects(id) on delete cascade
                );

                create index if not exists idx_project_conversations_project_updated
                  on project_conversations(project_id, updated_at desc);

                create index if not exists idx_project_conversations_conversation
                  on project_conversations(conversation_id);

                create table if not exists conversation_read_state (
                  conversation_id text primary key,
                  state text not null,
                  created_at integer not null,
                  updated_at integer not null,
                  metadata_json text not null
                );

                create index if not exists idx_conversation_read_state_state
                  on conversation_read_state(state, updated_at desc);
                """
            )
        if auto_migrate:
            self.migrate_source_of_truth_schema(backup=True)
        else:
            with self.connect() as connection:
                connection.execute(
                    "insert or ignore into schema_meta(key, value) values('schema_version', ?)",
                    (str(CORE_SCHEMA_VERSION),),
                )

    def migrate_source_of_truth_schema(self, *, backup: bool = True) -> dict[str, Any]:
        backup_path = None
        existing_tables = self.tables()
        duplicate_tables = [table for table in DUPLICATE_RUNTIME_TABLES if table in existing_tables]
        if backup and self.path.exists() and duplicate_tables:
            backup_path = backup_core_database(self.path, "backup-before-source-of-truth")
        with self.connect() as connection:
            connection.execute(
                "insert or replace into schema_meta(key, value) values('source_of_truth_migration', 'pending')"
            )
            for table in DUPLICATE_RUNTIME_TABLES:
                connection.execute(f"drop table if exists {table}")
            connection.execute(
                "insert or replace into schema_meta(key, value) values('schema_version', ?)",
                (str(CORE_SCHEMA_VERSION),),
            )
            connection.execute(
                "insert or replace into schema_meta(key, value) values('source_of_truth_migration', 'complete')"
            )
        return {
            "path": str(self.path),
            "backupPath": str(backup_path) if backup_path else "",
            "tablesDropped": duplicate_tables,
            "tablesPreserved": [table for table in CORE_OWNED_TABLES if table in self.tables()],
            "status": "complete",
        }

    def tables(self) -> list[str]:
        with self.connect() as connection:
            rows = connection.execute(
                "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name"
            ).fetchall()
        return [str(row["name"]) for row in rows]

    def health(self) -> dict[str, Any]:
        with self.connect() as connection:
            schema_version = connection.execute(
                "select value from schema_meta where key = 'schema_version'"
            ).fetchone()
        return {
            "path": str(self.path),
            "attachmentRoot": str(self.attachment_root),
            "schemaVersion": int(schema_version["value"]) if schema_version else CORE_SCHEMA_VERSION,
            "sourceOfTruthMigration": self.schema_meta_value("source_of_truth_migration") or "",
            "migrationWarning": self.migration_warning,
        }

    def schema_meta_value(self, key: str) -> str | None:
        with self.connect() as connection:
            row = connection.execute("select value from schema_meta where key = ?", (key,)).fetchone()
        return str(row["value"]) if row else None

    def create_project(
        self,
        *,
        name: str,
        default_agent_id: str,
        system_prompt: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("Project name is required.")
        if not default_agent_id.strip():
            raise ValueError("Default agent is required.")
        project_id = random_id("project")
        timestamp = now()
        with self.connect() as connection:
            slug = unique_project_slug(connection, clean_name)
            connection.execute(
                """
                insert into projects(
                  id, name, slug, default_agent_id, system_prompt,
                  created_at, updated_at, archived_at, metadata_json
                ) values(?, ?, ?, ?, ?, ?, ?, null, ?)
                """,
                (
                    project_id,
                    clean_name,
                    slug,
                    default_agent_id.strip(),
                    system_prompt,
                    timestamp,
                    timestamp,
                    dumps(metadata or {}),
                ),
            )
        project = self.get_project(project_id)
        if not project:
            raise ValueError("Project could not be stored.")
        return project

    def list_projects(self, *, include_archived: bool = False) -> list[dict[str, Any]]:
        where = "" if include_archived else "where archived_at is null"
        with self.connect() as connection:
            rows = connection.execute(
                f"select * from projects {where} order by updated_at desc, name collate nocase"
            ).fetchall()
        return [project_from_row(row) for row in rows]

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("select * from projects where id = ?", (project_id,)).fetchone()
        return project_from_row(row) if row else None

    def update_project(
        self,
        project_id: str,
        *,
        name: str | None = None,
        default_agent_id: str | None = None,
        system_prompt: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        existing = self.get_project(project_id)
        if not existing:
            return None
        next_name = existing["name"] if name is None else name.strip()
        next_agent_id = existing["defaultAgentId"] if default_agent_id is None else default_agent_id.strip()
        if not next_name:
            raise ValueError("Project name is required.")
        if not next_agent_id:
            raise ValueError("Default agent is required.")
        timestamp = now()
        with self.connect() as connection:
            slug = existing["slug"]
            if next_name != existing["name"]:
                slug = unique_project_slug(connection, next_name, project_id=project_id)
            connection.execute(
                """
                update projects set
                  name = ?,
                  slug = ?,
                  default_agent_id = ?,
                  system_prompt = ?,
                  metadata_json = ?,
                  updated_at = ?
                where id = ?
                """,
                (
                    next_name,
                    slug,
                    next_agent_id,
                    existing["systemPrompt"] if system_prompt is None else system_prompt,
                    dumps(existing["metadata"] if metadata is None else metadata),
                    timestamp,
                    project_id,
                ),
            )
        return self.get_project(project_id)

    def archive_project(self, project_id: str) -> dict[str, Any] | None:
        if not self.get_project(project_id):
            return None
        timestamp = now()
        with self.connect() as connection:
            connection.execute(
                "update projects set archived_at = ?, updated_at = ? where id = ?",
                (timestamp, timestamp, project_id),
            )
        return self.get_project(project_id)

    def link_project_conversation(
        self,
        project_id: str,
        conversation: dict[str, Any],
        *,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise ValueError("Project was not found.")
        conversation_id = str(conversation.get("id") or "").strip()
        if not conversation_id:
            raise ValueError("Conversation id is required.")
        timestamp = now()
        runtime_id = str(conversation.get("runtimeId") or DEFAULT_RUNTIME_ID)
        runtime_profile = str(conversation.get("runtimeProfile") or "default")
        external_session_id = str(conversation.get("externalSessionId") or "")
        external_chat_id = str(conversation.get("externalChatId") or "")
        with self.connect() as connection:
            existing = connection.execute(
                """
                select created_at from project_conversations
                where project_id = ? and conversation_id = ?
                """,
                (project_id, conversation_id),
            ).fetchone()
            if external_chat_id:
                connection.execute(
                    """
                    delete from project_conversations
                    where project_id = ?
                      and runtime_id = ?
                      and runtime_profile = ?
                      and external_chat_id = ?
                      and conversation_id <> ?
                    """,
                    (project_id, runtime_id, runtime_profile, external_chat_id, conversation_id),
                )
            connection.execute(
                """
                insert into project_conversations(
                  project_id, conversation_id, agent_id, runtime_id, runtime_profile,
                  external_session_id, external_chat_id, created_at, updated_at, metadata_json
                ) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(project_id, conversation_id) do update set
                  agent_id = excluded.agent_id,
                  runtime_id = excluded.runtime_id,
                  runtime_profile = excluded.runtime_profile,
                  external_session_id = excluded.external_session_id,
                  external_chat_id = excluded.external_chat_id,
                  updated_at = excluded.updated_at,
                  metadata_json = excluded.metadata_json
                """,
                (
                    project_id,
                    conversation_id,
                    str(conversation.get("agentId") or ""),
                    runtime_id,
                    runtime_profile,
                    external_session_id,
                    external_chat_id,
                    int(existing["created_at"]) if existing else timestamp,
                    timestamp,
                    dumps(metadata or {}),
                ),
            )
        link = self.project_conversation_link(project_id, conversation_id)
        if not link:
            raise ValueError("Project conversation link could not be stored.")
        return link

    def unlink_project_conversation(self, project_id: str, conversation_id: str) -> None:
        with self.connect() as connection:
            connection.execute(
                "delete from project_conversations where project_id = ? and conversation_id = ?",
                (project_id, conversation_id),
            )

    def list_project_conversation_links(self, project_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                select * from project_conversations
                where project_id = ?
                order by updated_at desc, conversation_id
                """,
                (project_id,),
            ).fetchall()
        return [project_conversation_link_from_row(row) for row in rows]

    def project_conversation_link(self, project_id: str, conversation_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                select * from project_conversations
                where project_id = ? and conversation_id = ?
                """,
                (project_id, conversation_id),
            ).fetchone()
        return project_conversation_link_from_row(row) if row else None

    def project_for_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                select p.* from projects p
                join project_conversations pc on pc.project_id = p.id
                where pc.conversation_id = ? and p.archived_at is null
                order by pc.updated_at desc
                limit 1
                """,
                (conversation_id,),
            ).fetchone()
        return project_from_row(row) if row else None

    def upsert_conversation_read_state(
        self,
        conversation_id: str,
        state: str,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        clean_id = conversation_id.strip()
        clean_state = state.strip().lower()
        if not clean_id:
            raise ValueError("Conversation id is required.")
        if clean_state not in CONVERSATION_READ_STATES:
            raise ValueError("Conversation read state must be read or unread.")
        timestamp = now()
        with self.connect() as connection:
            existing = connection.execute(
                """
                select created_at from conversation_read_state
                where conversation_id = ?
                """,
                (clean_id,),
            ).fetchone()
            connection.execute(
                """
                insert into conversation_read_state(
                  conversation_id, state, created_at, updated_at, metadata_json
                ) values(?, ?, ?, ?, ?)
                on conflict(conversation_id) do update set
                  state = excluded.state,
                  updated_at = excluded.updated_at,
                  metadata_json = excluded.metadata_json
                """,
                (
                    clean_id,
                    clean_state,
                    int(existing["created_at"]) if existing else timestamp,
                    timestamp,
                    dumps(metadata or {}),
                ),
            )
        read_state = self.conversation_read_state(clean_id)
        if not read_state:
            raise ValueError("Conversation read state could not be stored.")
        return read_state

    def conversation_read_state(self, conversation_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "select * from conversation_read_state where conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        return conversation_read_state_from_row(row) if row else None

    def conversation_read_states(self, conversation_ids: list[str]) -> dict[str, dict[str, Any]]:
        clean_ids = sorted({conversation_id for conversation_id in conversation_ids if conversation_id})
        if not clean_ids:
            return {}
        with self.connect() as connection:
            rows = connection.execute(
                f"""
                select * from conversation_read_state
                where conversation_id in ({', '.join('?' for _ in clean_ids)})
                """,
                clean_ids,
            ).fetchall()
        return {
            state["conversationId"]: state
            for state in (conversation_read_state_from_row(row) for row in rows)
        }

    def upsert_runtime(self, runtime: dict[str, Any]) -> dict[str, Any]:
        runtime_id = str(runtime["id"])
        timestamp = now()
        with self.connect() as connection:
            existing = connection.execute("select created_at from runtimes where id = ?", (runtime_id,)).fetchone()
            connection.execute(
                """
                insert into runtimes(
                  id, kind, name, connection_json, enabled, created_at, updated_at, last_probe_json
                ) values(?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(id) do update set
                  kind = excluded.kind,
                  name = excluded.name,
                  connection_json = excluded.connection_json,
                  enabled = excluded.enabled,
                  updated_at = excluded.updated_at
                """,
                (
                    runtime_id,
                    str(runtime.get("kind") or "hermes"),
                    str(runtime.get("name") or "Local Hermes"),
                    dumps(runtime.get("connection") or runtime.get("connection_json") or {}),
                    1 if runtime.get("enabled", True) else 0,
                    int(existing["created_at"]) if existing else timestamp,
                    timestamp,
                    dumps(runtime.get("lastProbe") or runtime.get("last_probe") or {}),
                ),
            )
        return self.get_runtime(runtime_id) or {}

    def list_runtimes(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute("select * from runtimes order by created_at, id").fetchall()
        return [runtime_from_row(row) for row in rows]

    def get_runtime(self, runtime_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("select * from runtimes where id = ?", (runtime_id,)).fetchone()
        return runtime_from_row(row) if row else None

    def upsert_client_message_metadata(
        self,
        *,
        runtime_id: str,
        profile: str,
        chat_id: str,
        message_id: str,
        content: str,
        metadata: dict[str, Any],
    ) -> None:
        if not runtime_id or not profile or not chat_id or not message_id or not metadata:
            return
        timestamp = now()
        content_hash = stable_hash(content, length=32)
        with self.connect() as connection:
            existing = connection.execute(
                """
                select created_at from client_message_metadata
                where runtime_id = ? and profile = ? and chat_id = ? and message_id = ?
                """,
                (runtime_id, profile, chat_id, message_id),
            ).fetchone()
            connection.execute(
                """
                insert into client_message_metadata(
                  runtime_id, profile, chat_id, message_id, content_hash,
                  metadata_json, created_at, updated_at
                ) values(?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(runtime_id, profile, chat_id, message_id) do update set
                  content_hash = excluded.content_hash,
                  metadata_json = excluded.metadata_json,
                  updated_at = excluded.updated_at
                """,
                (
                    runtime_id,
                    profile,
                    chat_id,
                    message_id,
                    content_hash,
                    dumps(metadata),
                    int(existing["created_at"]) if existing else timestamp,
                    timestamp,
                ),
            )

    def client_message_metadata_for_messages(
        self,
        *,
        runtime_id: str,
        profile: str,
        chat_id: str,
        messages: list[dict[str, Any]],
    ) -> dict[str, Any]:
        message_ids = sorted({str(message.get("id") or "") for message in messages if message.get("id")})
        content_hashes = sorted({
            hash_value
            for message in messages
            for hash_value in message_content_hash_candidates(str(message.get("content") or ""))
        })
        needs_attachment_fallbacks = any(
            str(message.get("role") or "") == "user" and
            is_transformed_voice_message_content(str(message.get("content") or ""))
            for message in messages
        )
        if not runtime_id or not profile or not chat_id:
            return {"byMessageId": {}, "byContentHash": {}, "attachmentFallbacks": []}
        if not message_ids and not content_hashes:
            if not needs_attachment_fallbacks:
                return {"byMessageId": {}, "byContentHash": {}, "attachmentFallbacks": []}
        clauses: list[str] = []
        values: list[Any] = [runtime_id, profile, chat_id]
        if message_ids:
            clauses.append(f"message_id in ({', '.join('?' for _ in message_ids)})")
            values.extend(message_ids)
        if content_hashes:
            clauses.append(f"content_hash in ({', '.join('?' for _ in content_hashes)})")
            values.extend(content_hashes)
        rows = []
        fallback_rows = []
        with self.connect() as connection:
            if clauses:
                rows = connection.execute(
                    f"""
                    select message_id, content_hash, metadata_json from client_message_metadata
                    where runtime_id = ? and profile = ? and chat_id = ? and ({' or '.join(clauses)})
                    """,
                    values,
                ).fetchall()
            if needs_attachment_fallbacks:
                fallback_rows = connection.execute(
                    """
                    select message_id, metadata_json from client_message_metadata
                    where runtime_id = ? and profile = ? and chat_id = ?
                    order by created_at, message_id
                    """,
                    (runtime_id, profile, chat_id),
                ).fetchall()
        by_message_id: dict[str, dict[str, Any]] = {}
        by_content_hash: dict[str, dict[str, Any]] = {}
        for row in rows:
            metadata = loads(row["metadata_json"])
            if isinstance(metadata, dict):
                by_message_id[str(row["message_id"])] = metadata
                by_content_hash[str(row["content_hash"])] = metadata
        attachment_fallbacks: list[dict[str, Any]] = []
        for row in fallback_rows:
            metadata = loads(row["metadata_json"])
            if isinstance(metadata, dict) and isinstance(metadata.get("attachments"), list):
                attachment_fallbacks.append({"messageId": str(row["message_id"]), "metadata": metadata})
        return {
            "byMessageId": by_message_id,
            "byContentHash": by_content_hash,
            "attachmentFallbacks": attachment_fallbacks,
        }

    def create_attachment(
        self,
        *,
        source_path: Path,
        runtime_id: str,
        profile: str,
        name: str,
        mime_type: str,
        kind: str,
        size_bytes: int,
        sha256: str,
        owner_device_id: str = "",
        conversation_id: str = "",
        message_id: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not runtime_id or not profile:
            raise ValueError("runtime_id and profile are required.")
        if size_bytes < 0 or size_bytes > max_attachment_size_bytes():
            raise ValueError(f"Attachment exceeds the {attachment_size_limit_label()} limit.")
        normalized_mime = normalize_attachment_mime_type(mime_type)
        if not is_allowed_attachment_mime(normalized_mime):
            raise ValueError(f"Unsupported attachment type: {normalized_mime}.")
        normalized_kind = normalize_attachment_kind(kind, normalized_mime)
        attachment_id = random_id("att")
        blob_path = self.blob_path_for_sha256(sha256)
        blob_path.parent.mkdir(parents=True, exist_ok=True)
        if not blob_path.exists():
            shutil.move(str(source_path), str(blob_path))
        else:
            source_path.unlink(missing_ok=True)
        timestamp = now()
        with self.connect() as connection:
            connection.execute(
                """
                insert into attachments(
                  id, owner_device_id, runtime_id, profile, conversation_id, message_id,
                  name, mime_type, kind, size_bytes, sha256, storage_kind, storage_path,
                  created_at, updated_at, deleted_at, metadata_json
                ) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)
                """,
                (
                    attachment_id,
                    owner_device_id or "",
                    runtime_id,
                    profile,
                    conversation_id or None,
                    message_id or None,
                    name.strip() or "attachment",
                    normalized_mime,
                    normalized_kind,
                    size_bytes,
                    sha256,
                    "local_file",
                    str(blob_path),
                    timestamp,
                    timestamp,
                    dumps(metadata or {}),
                ),
            )
        attachment = self.get_attachment(attachment_id)
        if not attachment:
            raise ValueError("Attachment could not be stored.")
        return attachment

    def create_attachment_from_path(
        self,
        *,
        source_path: Path,
        runtime_id: str,
        profile: str,
        conversation_id: str,
        message_id: str,
        name: str = "",
        kind: str = "",
        mime_type: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        source = Path(source_path).expanduser()
        if not source.is_absolute():
            raise ValueError("Generated attachment path must be absolute.")
        if not source.is_file():
            raise ValueError("Generated attachment was not found.")
        size_bytes = source.stat().st_size
        if size_bytes <= 0:
            raise ValueError("Generated attachment is empty.")
        if size_bytes > max_attachment_size_bytes():
            raise ValueError(f"Attachment exceeds the {attachment_size_limit_label()} limit.")

        sha256 = hashlib.sha256()
        with source.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                sha256.update(chunk)

        filename = name.strip() or source.name or "attachment"
        normalized_mime = normalize_attachment_mime_type(
            mime_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        )
        normalized_kind = normalize_attachment_kind(kind, normalized_mime)
        temp_path = self.tmp_attachment_path()
        try:
            shutil.copy2(source, temp_path)
            return self.create_attachment(
                source_path=temp_path,
                runtime_id=runtime_id,
                profile=profile,
                conversation_id=conversation_id,
                message_id=message_id,
                name=filename,
                mime_type=normalized_mime,
                kind=normalized_kind,
                size_bytes=size_bytes,
                sha256=sha256.hexdigest(),
                metadata=metadata,
            )
        finally:
            temp_path.unlink(missing_ok=True)

    def blob_path_for_sha256(self, sha256: str) -> Path:
        safe_hash = re.sub(r"[^a-fA-F0-9]", "", sha256).lower()
        if len(safe_hash) != 64:
            raise ValueError("Invalid attachment hash.")
        return self.attachment_root / "blobs" / safe_hash[:2] / safe_hash

    def tmp_attachment_path(self) -> Path:
        directory = self.attachment_root / "tmp"
        directory.mkdir(parents=True, exist_ok=True)
        return directory / f"upload-{random_id('tmp')}"

    def get_attachment(self, attachment_id: str, *, include_storage: bool = False) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "select * from attachments where id = ? and deleted_at is null",
                (attachment_id,),
            ).fetchone()
        return attachment_from_row(row, include_storage=include_storage) if row else None

    def attachment_content_path(self, attachment_id: str) -> Path:
        attachment = self.get_attachment(attachment_id, include_storage=True)
        if not attachment:
            raise ValueError("Attachment was not found.")
        path = Path(str(attachment.get("storagePath") or ""))
        resolved_path = path.resolve()
        try:
            resolved_path.relative_to(self.attachment_root.resolve())
        except ValueError as exc:
            raise ValueError("Attachment storage path is invalid.") from exc
        if not resolved_path.is_file():
            raise ValueError("Attachment content is missing.")
        return resolved_path

    def resolve_message_attachments(
        self,
        *,
        runtime_id: str,
        profile: str,
        conversation_id: str,
        chat_id: str,
        message_id: str,
        refs: list[Any],
    ) -> list[dict[str, Any]]:
        if len(refs) > MAX_ATTACHMENTS_PER_MESSAGE:
            raise ValueError(f"Messages may include at most {MAX_ATTACHMENTS_PER_MESSAGE} attachments.")
        resolved: list[dict[str, Any]] = []
        timestamp = now()
        with self.connect() as connection:
            for position, ref in enumerate(refs):
                if not isinstance(ref, dict):
                    raise ValueError("Attachment references must be objects.")
                attachment_id = str(ref.get("id") or "").strip()
                if not attachment_id:
                    raise ValueError("Attachment id is required.")
                row = connection.execute(
                    """
                    select * from attachments
                    where id = ? and runtime_id = ? and profile = ? and deleted_at is null
                    """,
                    (attachment_id, runtime_id, profile),
                ).fetchone()
                if not row:
                    raise ValueError("Attachment was not found for this profile.")
                if row["conversation_id"] and str(row["conversation_id"]) != conversation_id:
                    raise ValueError("Attachment belongs to a different conversation.")
                connection.execute(
                    """
                    update attachments
                    set conversation_id = coalesce(conversation_id, ?),
                        message_id = coalesce(message_id, ?),
                        updated_at = ?
                    where id = ?
                    """,
                    (conversation_id, message_id, timestamp, attachment_id),
                )
                connection.execute(
                    """
                    insert or replace into message_attachments(
                      runtime_id, profile, chat_id, message_id, attachment_id, position, created_at
                    ) values(?, ?, ?, ?, ?, ?, ?)
                    """,
                    (runtime_id, profile, chat_id, message_id, attachment_id, position, timestamp),
                )
                resolved.append(attachment_from_row(row, include_storage=True))
        return resolved

    def link_message_attachments(
        self,
        *,
        runtime_id: str,
        profile: str,
        chat_id: str,
        message_id: str,
        attachments: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if len(attachments) > MAX_ATTACHMENTS_PER_MESSAGE:
            raise ValueError(f"Messages may include at most {MAX_ATTACHMENTS_PER_MESSAGE} attachments.")
        timestamp = now()
        linked: list[dict[str, Any]] = []
        with self.connect() as connection:
            for position, attachment in enumerate(attachments):
                attachment_id = str(attachment.get("id") or "").strip()
                if not attachment_id:
                    continue
                row = connection.execute(
                    """
                    select * from attachments
                    where id = ? and runtime_id = ? and profile = ? and deleted_at is null
                    """,
                    (attachment_id, runtime_id, profile),
                ).fetchone()
                if not row:
                    continue
                connection.execute(
                    """
                    insert or replace into message_attachments(
                      runtime_id, profile, chat_id, message_id, attachment_id, position, created_at
                    ) values(?, ?, ?, ?, ?, ?, ?)
                    """,
                    (runtime_id, profile, chat_id, message_id, attachment_id, position, timestamp),
                )
                linked.append(attachment_from_row(row, include_storage=True))
        return linked

    def update_runtime_probe(self, runtime_id: str, probe: dict[str, Any]) -> None:
        with self.connect() as connection:
            connection.execute(
                "update runtimes set last_probe_json = ?, updated_at = ? where id = ?",
                (dumps(probe), now(), runtime_id),
            )

    def create_device(
        self,
        *,
        name: str,
        kind: str,
        token_hash: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        timestamp = now()
        device_id = random_id("dev")
        with self.connect() as connection:
            connection.execute(
                """
                insert into devices(
                  id, name, kind, token_hash, created_at, last_seen_at, revoked_at, metadata_json
                ) values(?, ?, ?, ?, ?, null, null, ?)
                """,
                (
                    device_id,
                    name.strip() or "Iris device",
                    kind.strip() or "desktop",
                    token_hash,
                    timestamp,
                    dumps(metadata or {}),
                ),
            )
        return self.get_device(device_id) or {}

    def list_devices(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "select * from devices order by revoked_at is not null, created_at desc, id"
            ).fetchall()
        return [device_from_row(row) for row in rows]

    def get_device(self, device_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("select * from devices where id = ?", (device_id,)).fetchone()
        return device_from_row(row) if row else None

    def active_device_for_token_hash(self, token_hash: str) -> dict[str, Any] | None:
        if not token_hash:
            return None
        with self.connect() as connection:
            row = connection.execute(
                """
                select * from devices
                where token_hash = ? and revoked_at is null
                limit 1
                """,
                (token_hash,),
            ).fetchone()
        return device_from_row(row) if row else None

    def touch_device(self, device_id: str) -> None:
        with self.connect() as connection:
            connection.execute(
                "update devices set last_seen_at = ? where id = ? and revoked_at is null",
                (now(), device_id),
            )

    def revoke_device(self, device_id: str) -> dict[str, Any] | None:
        timestamp = now()
        with self.connect() as connection:
            connection.execute(
                "update devices set revoked_at = coalesce(revoked_at, ?) where id = ?",
                (timestamp, device_id),
            )
        return self.get_device(device_id)

    def upsert_device_cursor(self, device_id: str, stream_name: str, last_cursor: int) -> dict[str, Any]:
        timestamp = now()
        stream = stream_name.strip() or "global"
        cursor = clamp_int(last_cursor, default=0, minimum=0, maximum=9_223_372_036_854_775_807)
        with self.connect() as connection:
            connection.execute(
                """
                insert into device_cursors(device_id, stream_name, last_cursor, updated_at)
                values(?, ?, ?, ?)
                on conflict(device_id, stream_name) do update set
                  last_cursor = max(device_cursors.last_cursor, excluded.last_cursor),
                  updated_at = excluded.updated_at
                """,
                (device_id, stream, cursor, timestamp),
            )
            row = connection.execute(
                """
                select device_id, stream_name, last_cursor, updated_at
                from device_cursors
                where device_id = ? and stream_name = ?
                """,
                (device_id, stream),
            ).fetchone()
        return {
            "deviceId": str(row["device_id"]),
            "streamName": str(row["stream_name"]),
            "lastCursor": int(row["last_cursor"]),
            "updatedAt": int(row["updated_at"]),
        }

def runtime_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "kind": str(row["kind"]),
        "name": str(row["name"]),
        "connection": loads(row["connection_json"]),
        "enabled": bool(row["enabled"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
        "lastProbe": loads(row["last_probe_json"]),
    }


def device_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": str(row["name"]),
        "kind": str(row["kind"]),
        "createdAt": int(row["created_at"]),
        "lastSeenAt": int(row["last_seen_at"]) if row["last_seen_at"] is not None else None,
        "revokedAt": int(row["revoked_at"]) if row["revoked_at"] is not None else None,
        "metadata": loads(row["metadata_json"]),
    }


def conversation_read_state_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "conversationId": str(row["conversation_id"]),
        "state": str(row["state"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
        "metadata": loads(row["metadata_json"]),
    }


def normalize_attachment_mime_type(value: str) -> str:
    mime_type = str(value or "").split(";", 1)[0].strip().lower()
    if mime_type == "image/jpg":
        return "image/jpeg"
    return mime_type or "application/octet-stream"


def is_allowed_attachment_mime(mime_type: str) -> bool:
    normalized = normalize_attachment_mime_type(mime_type)
    if normalized == "application/octet-stream":
        return True
    if normalized.startswith(("image/", "audio/", "video/", "text/")):
        return True
    return normalized in (
        DOCUMENT_ATTACHMENT_MIME_TYPES
        | CODE_ATTACHMENT_MIME_TYPES
        | ARCHIVE_ATTACHMENT_MIME_TYPES
    )


def normalize_attachment_kind(kind: str, mime_type: str) -> str:
    value = str(kind or "").strip().lower()
    if value in ATTACHMENT_KINDS:
        return value
    normalized_mime = normalize_attachment_mime_type(mime_type)
    if normalized_mime.startswith("image/"):
        return "image"
    if normalized_mime.startswith("audio/"):
        return "audio"
    if normalized_mime.startswith("video/"):
        return "video"
    if normalized_mime.startswith("text/") or normalized_mime in CODE_ATTACHMENT_MIME_TYPES:
        return "code"
    if normalized_mime in DOCUMENT_ATTACHMENT_MIME_TYPES:
        return "document"
    if normalized_mime in ARCHIVE_ATTACHMENT_MIME_TYPES:
        return "archive"
    return "file"


def message_content_hash_candidates(content: str) -> set[str]:
    value = str(content or "")
    if not value:
        return set()
    candidates = {stable_hash(value, length=32)}
    stripped = strip_attachment_summary(value)
    if stripped and stripped != value:
        candidates.add(stable_hash(stripped, length=32))
    stripped_generated_markers = strip_generated_file_marker_lines(value)
    if stripped_generated_markers and stripped_generated_markers != value:
        candidates.add(stable_hash(stripped_generated_markers, length=32))
    return candidates


def is_transformed_voice_message_content(content: str) -> bool:
    normalized = str(content or "").strip().lower()
    return (
        normalized.startswith("[the user sent a voice message") or
        normalized.startswith("transcription of voice message:")
    )


def strip_attachment_summary(content: str) -> str:
    return re.sub(r"\n\nAttached files:\n[\s\S]*$", "", content).strip()


def strip_generated_file_marker_lines(content: str) -> str:
    marker = re.compile(
        r"^\s*(?:Generated\s+file:\s*)?(?:[^\w\s/\\.:~-]+\s*)?(?:MEDIA|Media|Image|File):\s*(?:file://(?:localhost)?/|/).+?\s*$"
    )
    return "\n".join(
        line for line in str(content or "").splitlines()
        if not marker.match(line)
    ).strip()


def attachment_from_row(row: sqlite3.Row, *, include_storage: bool = False) -> dict[str, Any]:
    attachment = {
        "id": str(row["id"]),
        "runtimeId": str(row["runtime_id"]),
        "profile": str(row["profile"]),
        "conversationId": str(row["conversation_id"] or ""),
        "messageId": str(row["message_id"] or ""),
        "name": str(row["name"]),
        "kind": str(row["kind"]),
        "mimeType": str(row["mime_type"]),
        "size": int(row["size_bytes"]),
        "sha256": str(row["sha256"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
        "previewUrl": f"/v1/attachments/{row['id']}/preview" if str(row["kind"]) == "image" else "",
        "downloadUrl": f"/v1/attachments/{row['id']}/content",
        "metadata": loads(row["metadata_json"]),
    }
    if include_storage:
        attachment.update({
            "storageKind": str(row["storage_kind"]),
            "storagePath": str(row["storage_path"]),
        })
    return attachment


def client_attachment_payload(attachment: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "id": str(attachment.get("id") or ""),
        "name": str(attachment.get("name") or "attachment"),
        "kind": normalize_attachment_kind(
            str(attachment.get("kind") or ""),
            str(attachment.get("mimeType") or ""),
        ),
        "mimeType": str(attachment.get("mimeType") or ""),
        "size": int(attachment.get("size") if isinstance(attachment.get("size"), int) else -1),
        "sha256": str(attachment.get("sha256") or ""),
        "previewUrl": str(attachment.get("previewUrl") or ""),
        "downloadUrl": str(attachment.get("downloadUrl") or ""),
    }
    return payload


def project_slug(value: str) -> str:
    slug = PROFILE_SLUG_RE.sub("-", value.strip().lower()).strip(".-_")
    return slug or "project"


def unique_project_slug(connection: sqlite3.Connection, name: str, *, project_id: str = "") -> str:
    base = project_slug(name)
    for index in range(1, 1000):
        candidate = base if index == 1 else f"{base}-{index}"
        row = connection.execute(
            "select id from projects where slug = ?",
            (candidate,),
        ).fetchone()
        if not row or str(row["id"]) == project_id:
            return candidate
    return f"{base}-{stable_hash(name, str(time.time_ns()), length=8)}"


def project_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": str(row["name"]),
        "slug": str(row["slug"]),
        "defaultAgentId": str(row["default_agent_id"]),
        "systemPrompt": str(row["system_prompt"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
        "archivedAt": int(row["archived_at"]) if row["archived_at"] is not None else None,
        "metadata": loads(row["metadata_json"]),
    }


def project_conversation_link_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "projectId": str(row["project_id"]),
        "conversationId": str(row["conversation_id"]),
        "agentId": str(row["agent_id"]),
        "runtimeId": str(row["runtime_id"]),
        "runtimeProfile": str(row["runtime_profile"]),
        "externalSessionId": str(row["external_session_id"] or ""),
        "externalChatId": str(row["external_chat_id"] or ""),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
        "metadata": loads(row["metadata_json"]),
    }


def core_message_from_hermes(message: ConversationMessage) -> dict[str, Any]:
    return {
        "id": message.id,
        "conversationId": message.sessionId,
        "role": message.role,
        "content": message.content,
        "status": "completed",
        "createdAt": int(message.timestamp or 0),
        "updatedAt": int(message.timestamp or 0),
        "metadata": {
            "sessionId": message.sessionId,
            "toolName": message.toolName,
            "toolCallId": message.toolCallId,
            "toolCalls": message.toolCalls,
        },
    }


def agent_from_profile_summary(runtime: dict[str, Any], profile: ProfileSummary, active_profile: str) -> dict[str, Any]:
    timestamp = now()
    metadata = {
        "path": profile.path,
        "exists": profile.exists,
        "provider": profile.provider,
        "model": profile.model,
        "memoryBytes": profile.memoryBytes,
        "memoryUpdatedAt": profile.memoryUpdatedAt,
        "skillCount": profile.skillCount,
        "gatewayRunning": profile.gatewayRunning,
        "runtimeProfile": profile.name,
    }
    return {
        "id": agent_id_for_profile(str(runtime["id"]), profile.name),
        "runtimeId": str(runtime["id"]),
        "runtimeKind": str(runtime.get("kind") or "hermes"),
        "displayName": profile.name,
        "runtimeProfile": profile.name,
        "isDefault": profile.name == active_profile,
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "metadata": metadata,
    }


def conversation_from_runtime_summary(agent: dict[str, Any], conversation: ConversationSummary) -> dict[str, Any]:
    runtime_id = str(agent["runtimeId"])
    profile = str(agent["runtimeProfile"])
    external_session_id = conversation.id
    external_chat_id = conversation.chatId or str((conversation.origin or {}).get("chat_id") or "")
    external_id = external_session_id or external_chat_id
    timestamp = int(conversation.lastActiveAt or conversation.endedAt or conversation.startedAt or now())
    created_at = int(conversation.startedAt or timestamp)
    metadata = {
        "source": conversation.source,
        "model": conversation.model,
        "preview": conversation.preview,
        "messageCount": conversation.messageCount,
        "startedAt": conversation.startedAt,
        "endedAt": conversation.endedAt,
        "lastActiveAt": conversation.lastActiveAt,
        "runtimeProfile": profile,
    }
    return {
        "id": conversation_id_for_runtime(runtime_id, profile, external_id),
        "agentId": str(agent["id"]),
        "title": conversation.title or conversation.preview or "Untitled session",
        "summary": conversation.preview or "",
        "createdAt": created_at,
        "updatedAt": timestamp,
        "archivedAt": None,
        "metadata": metadata,
        "runtimeId": runtime_id,
        "runtimeProfile": profile,
        "externalSessionId": external_session_id,
        "externalChatId": external_chat_id,
        "externalThreadId": "",
        "origin": conversation.origin or {},
    }


def draft_conversation(
    agent: dict[str, Any],
    *,
    title: str,
    external_chat_id: str,
    external_session_id: str = "",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    timestamp = now()
    runtime_id = str(agent["runtimeId"])
    profile = str(agent["runtimeProfile"])
    chat_id = external_chat_id or f"core-{secrets.token_urlsafe(18)}"
    external_id = external_session_id or chat_id
    draft_metadata = {
        "draft": True,
        "createdBy": "iris-core",
        **(metadata or {}),
    }
    return {
        "id": conversation_id_for_runtime(runtime_id, profile, external_id),
        "agentId": str(agent["id"]),
        "title": title or "New conversation",
        "summary": "",
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "archivedAt": None,
        "metadata": draft_metadata,
        "runtimeId": runtime_id,
        "runtimeProfile": profile,
        "externalSessionId": external_session_id,
        "externalChatId": chat_id,
        "externalThreadId": "",
        "origin": {"createdBy": draft_metadata.get("createdBy") or "iris-core", "chat_id": chat_id},
    }
