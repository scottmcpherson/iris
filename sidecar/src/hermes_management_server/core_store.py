"""SQLite storage for the Iris Core API."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any

from .models import ConversationMessage, ConversationSummary, ProfileSummary


CORE_SCHEMA_VERSION = 2
DEFAULT_RUNTIME_ID = "runtime_local_hermes"
PROFILE_SLUG_RE = re.compile(r"[^A-Za-z0-9_.-]+")
DUPLICATE_RUNTIME_TABLES = (
    "agents",
    "conversations",
    "conversation_runtime_links",
    "message_events",
    "conversation_messages",
    "automations",
)
CORE_OWNED_TABLES = ("schema_meta", "devices", "runtimes", "device_cursors")


def default_core_store_path() -> Path:
    return Path.home() / ".iris" / "core.sqlite3"


def legacy_core_store_path() -> Path:
    return Path.home() / ".agent-ui" / "core.sqlite3"


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


class CoreStore:
    def __init__(self, path: str | Path | None = None, *, auto_migrate: bool = True) -> None:
        self.explicit_path = path is not None
        self.path = Path(path).expanduser() if path else migrate_default_core_store_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
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
            "schemaVersion": int(schema_version["value"]) if schema_version else CORE_SCHEMA_VERSION,
            "sourceOfTruthMigration": self.schema_meta_value("source_of_truth_migration") or "",
            "migrationWarning": self.migration_warning,
        }

    def schema_meta_value(self, key: str) -> str | None:
        with self.connect() as connection:
            row = connection.execute("select value from schema_meta where key = ?", (key,)).fetchone()
        return str(row["value"]) if row else None

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
