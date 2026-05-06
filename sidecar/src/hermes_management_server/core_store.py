"""SQLite storage for the Iris Core API."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any

from .models import ConversationMessage, ConversationSummary, ProfileSummary


CORE_SCHEMA_VERSION = 1
DEFAULT_RUNTIME_ID = "runtime_local_hermes"
PROFILE_SLUG_RE = re.compile(r"[^A-Za-z0-9_.-]+")


def default_core_store_path() -> Path:
    return Path.home() / ".agent-ui" / "core.sqlite3"


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
    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path).expanduser() if path else default_core_store_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self) -> None:
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

                create table if not exists agents (
                  id text primary key,
                  runtime_id text not null,
                  runtime_kind text not null,
                  display_name text not null,
                  runtime_profile text not null,
                  is_default integer not null default 0,
                  created_at integer not null,
                  updated_at integer not null,
                  metadata_json text not null,
                  unique(runtime_id, runtime_profile)
                );

                create table if not exists conversations (
                  id text primary key,
                  agent_id text not null,
                  title text not null,
                  summary text not null default '',
                  created_at integer not null,
                  updated_at integer not null,
                  archived_at integer,
                  metadata_json text not null
                );

                create table if not exists conversation_runtime_links (
                  conversation_id text not null,
                  runtime_id text not null,
                  runtime_profile text not null,
                  external_session_id text,
                  external_chat_id text,
                  external_thread_id text,
                  origin_json text not null,
                  created_at integer not null,
                  updated_at integer not null,
                  primary key (conversation_id, runtime_id)
                );

                create index if not exists idx_conversation_links_session
                  on conversation_runtime_links(runtime_id, runtime_profile, external_session_id);
                create index if not exists idx_conversation_links_chat
                  on conversation_runtime_links(runtime_id, runtime_profile, external_chat_id);

                create table if not exists message_events (
                  cursor integer primary key autoincrement,
                  id text unique not null,
                  conversation_id text not null,
                  agent_id text not null,
                  runtime_id text,
                  type text not null,
                  role text,
                  content text not null default '',
                  parent_event_id text,
                  external_message_id text,
                  idempotency_key text,
                  created_at integer not null,
                  metadata_json text not null
                );

                create index if not exists idx_message_events_conversation_cursor
                  on message_events(conversation_id, cursor);

                create table if not exists conversation_messages (
                  id text primary key,
                  conversation_id text not null,
                  role text not null,
                  content text not null,
                  status text not null,
                  created_at integer not null,
                  updated_at integer not null,
                  metadata_json text not null
                );

                create index if not exists idx_conversation_messages_conversation
                  on conversation_messages(conversation_id, created_at, id);

                create table if not exists automations (
                  id text primary key,
                  agent_id text not null,
                  runtime_id text not null,
                  external_job_id text,
                  name text not null,
                  schedule_text text not null,
                  prompt text not null,
                  deliver_to_conversation_id text,
                  status text not null,
                  created_at integer not null,
                  updated_at integer not null,
                  last_run_at integer,
                  next_run_at integer,
                  metadata_json text not null
                );

                create unique index if not exists idx_automations_external_job
                  on automations(runtime_id, external_job_id)
                  where external_job_id is not null and external_job_id != '';

                create table if not exists device_cursors (
                  device_id text not null,
                  stream_name text not null,
                  last_cursor integer not null,
                  updated_at integer not null,
                  primary key (device_id, stream_name)
                );
                """
            )
            connection.execute(
                "insert or replace into schema_meta(key, value) values('schema_version', ?)",
                (str(CORE_SCHEMA_VERSION),),
            )

    def health(self) -> dict[str, Any]:
        with self.connect() as connection:
            schema_version = connection.execute(
                "select value from schema_meta where key = 'schema_version'"
            ).fetchone()
        return {
            "path": str(self.path),
            "schemaVersion": int(schema_version["value"]) if schema_version else CORE_SCHEMA_VERSION,
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

    def sync_agents_from_profiles(self, runtime: dict[str, Any], profiles: list[ProfileSummary]) -> list[dict[str, Any]]:
        timestamp = now()
        runtime_id = runtime["id"]
        runtime_kind = runtime["kind"]
        active_profile = next((profile.name for profile in profiles if profile.active), "default")
        with self.connect() as connection:
            for profile in profiles:
                agent_id = agent_id_for_profile(runtime_id, profile.name)
                existing = connection.execute("select created_at from agents where id = ?", (agent_id,)).fetchone()
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
                connection.execute(
                    """
                    insert into agents(
                      id, runtime_id, runtime_kind, display_name, runtime_profile, is_default,
                      created_at, updated_at, metadata_json
                    ) values(?, ?, ?, ?, ?, ?, ?, ?, ?)
                    on conflict(id) do update set
                      runtime_id = excluded.runtime_id,
                      runtime_kind = excluded.runtime_kind,
                      display_name = excluded.display_name,
                      runtime_profile = excluded.runtime_profile,
                      is_default = excluded.is_default,
                      updated_at = excluded.updated_at,
                      metadata_json = excluded.metadata_json
                    """,
                    (
                        agent_id,
                        runtime_id,
                        runtime_kind,
                        profile.name,
                        profile.name,
                        1 if profile.name == active_profile else 0,
                        int(existing["created_at"]) if existing else timestamp,
                        timestamp,
                        dumps(metadata),
                    ),
                )
        return self.list_agents()

    def list_agents(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "select * from agents order by is_default desc, lower(display_name), id"
            ).fetchall()
        return [agent_from_row(row) for row in rows]

    def get_agent(self, agent_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("select * from agents where id = ?", (agent_id,)).fetchone()
        return agent_from_row(row) if row else None

    def agent_for_profile(self, runtime_id: str, profile: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "select * from agents where runtime_id = ? and runtime_profile = ?",
                (runtime_id, profile),
            ).fetchone()
        return agent_from_row(row) if row else None

    def upsert_runtime_conversation(
        self,
        agent: dict[str, Any],
        conversation: ConversationSummary,
    ) -> dict[str, Any]:
        runtime_id = agent["runtimeId"]
        profile = agent["runtimeProfile"]
        external_session_id = conversation.id
        external_chat_id = conversation.chatId or ""
        existing_id = self.resolve_conversation_id(runtime_id, profile, external_session_id, external_chat_id)
        conversation_id = existing_id or conversation_id_for_runtime(
            runtime_id,
            profile,
            external_chat_id or external_session_id,
        )
        created_at = int(conversation.startedAt or conversation.lastActiveAt or now())
        updated_at = int(conversation.lastActiveAt or conversation.endedAt or conversation.startedAt or now())
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
        with self.connect() as connection:
            current = connection.execute(
                "select created_at from conversations where id = ?",
                (conversation_id,),
            ).fetchone()
            connection.execute(
                """
                insert into conversations(id, agent_id, title, summary, created_at, updated_at, archived_at, metadata_json)
                values(?, ?, ?, ?, ?, ?, null, ?)
                on conflict(id) do update set
                  agent_id = excluded.agent_id,
                  title = excluded.title,
                  summary = excluded.summary,
                  updated_at = max(conversations.updated_at, excluded.updated_at),
                  metadata_json = excluded.metadata_json
                """,
                (
                    conversation_id,
                    agent["id"],
                    conversation.title or conversation.preview or "Untitled session",
                    conversation.preview or "",
                    int(current["created_at"]) if current else created_at,
                    updated_at,
                    dumps(metadata),
                ),
            )
            link_created_at = connection.execute(
                """
                select created_at from conversation_runtime_links
                where conversation_id = ? and runtime_id = ?
                """,
                (conversation_id, runtime_id),
            ).fetchone()
            connection.execute(
                """
                insert into conversation_runtime_links(
                  conversation_id, runtime_id, runtime_profile, external_session_id,
                  external_chat_id, external_thread_id, origin_json, created_at, updated_at
                ) values(?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(conversation_id, runtime_id) do update set
                  runtime_profile = excluded.runtime_profile,
                  external_session_id = coalesce(excluded.external_session_id, conversation_runtime_links.external_session_id),
                  external_chat_id = coalesce(nullif(excluded.external_chat_id, ''), conversation_runtime_links.external_chat_id),
                  external_thread_id = excluded.external_thread_id,
                  origin_json = excluded.origin_json,
                  updated_at = excluded.updated_at
                """,
                (
                    conversation_id,
                    runtime_id,
                    profile,
                    external_session_id,
                    external_chat_id,
                    "",
                    dumps(conversation.origin or {}),
                    int(link_created_at["created_at"]) if link_created_at else now(),
                    updated_at,
                ),
            )
        return self.get_conversation(conversation_id) or {}

    def resolve_conversation_id(
        self,
        runtime_id: str,
        profile: str,
        external_session_id: str = "",
        external_chat_id: str = "",
    ) -> str | None:
        with self.connect() as connection:
            if external_session_id:
                row = connection.execute(
                    """
                    select conversation_id from conversation_runtime_links
                    where runtime_id = ? and runtime_profile = ? and external_session_id = ?
                    limit 1
                    """,
                    (runtime_id, profile, external_session_id),
                ).fetchone()
                if row:
                    return str(row["conversation_id"])
            if external_chat_id:
                row = connection.execute(
                    """
                    select conversation_id from conversation_runtime_links
                    where runtime_id = ? and runtime_profile = ? and external_chat_id = ?
                    limit 1
                    """,
                    (runtime_id, profile, external_chat_id),
                ).fetchone()
                if row:
                    return str(row["conversation_id"])
        return None

    def create_conversation(
        self,
        agent: dict[str, Any],
        title: str = "",
        external_chat_id: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        timestamp = now()
        conversation_id = random_id("conv")
        chat_id = external_chat_id or chat_id_for_conversation(conversation_id)
        with self.connect() as connection:
            connection.execute(
                """
                insert into conversations(id, agent_id, title, summary, created_at, updated_at, archived_at, metadata_json)
                values(?, ?, ?, '', ?, ?, null, ?)
                """,
                (
                    conversation_id,
                    agent["id"],
                    title or "New conversation",
                    timestamp,
                    timestamp,
                    dumps(metadata or {}),
                ),
            )
            connection.execute(
                """
                insert into conversation_runtime_links(
                  conversation_id, runtime_id, runtime_profile, external_session_id,
                  external_chat_id, external_thread_id, origin_json, created_at, updated_at
                ) values(?, ?, ?, null, ?, null, ?, ?, ?)
                """,
                (
                    conversation_id,
                    agent["runtimeId"],
                    agent["runtimeProfile"],
                    chat_id,
                    dumps({"createdBy": "agentui-core"}),
                    timestamp,
                    timestamp,
                ),
            )
        self.append_event(
            conversation_id=conversation_id,
            agent_id=agent["id"],
            runtime_id=agent["runtimeId"],
            event_type="conversation.created",
            content=title or "New conversation",
            metadata={"title": title or "New conversation"},
        )
        return self.get_conversation(conversation_id) or {}

    def list_conversations(self, agent_id: str | None = None, limit: int = 80) -> list[dict[str, Any]]:
        limit = clamp_int(limit, default=80, minimum=1, maximum=200)
        query = (
            """
            select c.*, l.runtime_id, l.runtime_profile, l.external_session_id, l.external_chat_id,
                   l.external_thread_id, l.origin_json
            from conversations c
            left join conversation_runtime_links l on l.conversation_id = c.id
            where c.archived_at is null
            """
        )
        params: list[Any] = []
        if agent_id:
            query += " and c.agent_id = ?"
            params.append(agent_id)
        query += " order by c.updated_at desc, c.id limit ?"
        params.append(limit)
        with self.connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [conversation_from_row(row) for row in rows]

    def get_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                select c.*, l.runtime_id, l.runtime_profile, l.external_session_id, l.external_chat_id,
                       l.external_thread_id, l.origin_json
                from conversations c
                left join conversation_runtime_links l on l.conversation_id = c.id
                where c.id = ?
                """,
                (conversation_id,),
            ).fetchone()
        return conversation_from_row(row) if row else None

    def update_conversation_link(
        self,
        conversation_id: str,
        *,
        external_session_id: str | None = None,
        external_chat_id: str | None = None,
    ) -> None:
        current = self.get_conversation(conversation_id)
        if not current:
            return
        with self.connect() as connection:
            connection.execute(
                """
                update conversation_runtime_links set
                  external_session_id = coalesce(?, external_session_id),
                  external_chat_id = coalesce(?, external_chat_id),
                  updated_at = ?
                where conversation_id = ? and runtime_id = ?
                """,
                (external_session_id, external_chat_id, now(), conversation_id, current["runtimeId"]),
            )

    def append_event(
        self,
        *,
        conversation_id: str,
        agent_id: str,
        runtime_id: str | None,
        event_type: str,
        role: str | None = None,
        content: str = "",
        parent_event_id: str | None = None,
        external_message_id: str | None = None,
        idempotency_key: str | None = None,
        metadata: dict[str, Any] | None = None,
        event_id: str | None = None,
    ) -> dict[str, Any]:
        timestamp = now()
        event_id = event_id or random_id("evt")
        with self.connect() as connection:
            try:
                cursor = connection.execute(
                    """
                    insert into message_events(
                      id, conversation_id, agent_id, runtime_id, type, role, content,
                      parent_event_id, external_message_id, idempotency_key, created_at, metadata_json
                    ) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event_id,
                        conversation_id,
                        agent_id,
                        runtime_id,
                        event_type,
                        role,
                        content,
                        parent_event_id,
                        external_message_id,
                        idempotency_key,
                        timestamp,
                        dumps(metadata or {}),
                    ),
                ).lastrowid
            except sqlite3.IntegrityError:
                row = connection.execute("select * from message_events where id = ?", (event_id,)).fetchone()
                return event_from_row(row)
            connection.execute(
                "update conversations set updated_at = ? where id = ?",
                (timestamp, conversation_id),
            )
            row = connection.execute("select * from message_events where cursor = ?", (cursor,)).fetchone()
        return event_from_row(row)

    def upsert_message(
        self,
        *,
        conversation_id: str,
        message_id: str,
        role: str,
        content: str,
        status: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        timestamp = now()
        with self.connect() as connection:
            existing = connection.execute(
                "select created_at from conversation_messages where id = ?",
                (message_id,),
            ).fetchone()
            connection.execute(
                """
                insert into conversation_messages(
                  id, conversation_id, role, content, status, created_at, updated_at, metadata_json
                ) values(?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(id) do update set
                  conversation_id = excluded.conversation_id,
                  role = excluded.role,
                  content = excluded.content,
                  status = excluded.status,
                  updated_at = excluded.updated_at,
                  metadata_json = excluded.metadata_json
                """,
                (
                    message_id,
                    conversation_id,
                    role,
                    content,
                    status,
                    int(existing["created_at"]) if existing else timestamp,
                    timestamp,
                    dumps(metadata or {}),
                ),
            )
            row = connection.execute(
                "select * from conversation_messages where id = ?",
                (message_id,),
            ).fetchone()
        return message_from_row(row)

    def list_messages(self, conversation_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                select * from conversation_messages
                where conversation_id = ?
                order by created_at, id
                """,
                (conversation_id,),
            ).fetchall()
        return [message_from_row(row) for row in rows]

    def list_events(
        self,
        *,
        after: int = 0,
        limit: int = 200,
        conversation_id: str | None = None,
        agent_id: str | None = None,
    ) -> list[dict[str, Any]]:
        after = clamp_int(after, default=0, minimum=0, maximum=9_223_372_036_854_775_807)
        limit = clamp_int(limit, default=200, minimum=1, maximum=500)
        query = "select * from message_events where cursor > ?"
        params: list[Any] = [after]
        if conversation_id:
            query += " and conversation_id = ?"
            params.append(conversation_id)
        if agent_id:
            query += " and agent_id = ?"
            params.append(agent_id)
        query += " order by cursor asc limit ?"
        params.append(limit)
        with self.connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [event_from_row(row) for row in rows]

    def latest_event_cursor(self, conversation_id: str | None = None, agent_id: str | None = None) -> int:
        query = "select coalesce(max(cursor), 0) as cursor from message_events where 1 = 1"
        params: list[Any] = []
        if conversation_id:
            query += " and conversation_id = ?"
            params.append(conversation_id)
        if agent_id:
            query += " and agent_id = ?"
            params.append(agent_id)
        with self.connect() as connection:
            row = connection.execute(query, params).fetchone()
        return int(row["cursor"] or 0)

    def list_automations(self, agent_id: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        limit = clamp_int(limit, default=200, minimum=1, maximum=500)
        query = "select * from automations where 1 = 1"
        params: list[Any] = []
        if agent_id:
            query += " and agent_id = ?"
            params.append(agent_id)
        query += " order by coalesce(next_run_at, updated_at) asc, created_at desc, id limit ?"
        params.append(limit)
        with self.connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [automation_from_row(row) for row in rows]

    def get_automation(self, automation_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("select * from automations where id = ?", (automation_id,)).fetchone()
        return automation_from_row(row) if row else None

    def upsert_automation(self, automation: dict[str, Any]) -> dict[str, Any]:
        timestamp = now()
        automation_id = str(automation.get("id") or random_id("auto"))
        external_job_id = str(automation.get("externalJobId") or automation.get("external_job_id") or "")
        metadata = automation.get("metadata") if isinstance(automation.get("metadata"), dict) else {}
        with self.connect() as connection:
            existing = None
            if external_job_id:
                existing = connection.execute(
                    """
                    select id, created_at from automations
                    where runtime_id = ? and external_job_id = ?
                    """,
                    (str(automation["runtimeId"]), external_job_id),
                ).fetchone()
            if existing:
                automation_id = str(existing["id"])
            else:
                existing = connection.execute(
                    "select id, created_at from automations where id = ?",
                    (automation_id,),
                ).fetchone()
            connection.execute(
                """
                insert into automations(
                  id, agent_id, runtime_id, external_job_id, name, schedule_text, prompt,
                  deliver_to_conversation_id, status, created_at, updated_at,
                  last_run_at, next_run_at, metadata_json
                ) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(id) do update set
                  agent_id = excluded.agent_id,
                  runtime_id = excluded.runtime_id,
                  external_job_id = coalesce(nullif(excluded.external_job_id, ''), automations.external_job_id),
                  name = excluded.name,
                  schedule_text = excluded.schedule_text,
                  prompt = excluded.prompt,
                  deliver_to_conversation_id = excluded.deliver_to_conversation_id,
                  status = excluded.status,
                  updated_at = excluded.updated_at,
                  last_run_at = excluded.last_run_at,
                  next_run_at = excluded.next_run_at,
                  metadata_json = excluded.metadata_json
                """,
                (
                    automation_id,
                    str(automation["agentId"]),
                    str(automation["runtimeId"]),
                    external_job_id,
                    str(automation.get("name") or "Untitled automation"),
                    str(automation.get("schedule") or automation.get("scheduleText") or ""),
                    str(automation.get("prompt") or ""),
                    str(automation.get("deliverToConversationId") or ""),
                    str(automation.get("status") or "active"),
                    int(existing["created_at"]) if existing else int(automation.get("createdAt") or timestamp),
                    int(automation.get("updatedAt") or timestamp),
                    optional_int(automation.get("lastRunAt")),
                    optional_int(automation.get("nextRunAt")),
                    dumps(metadata),
                ),
            )
        return self.get_automation(automation_id) or {}

    def update_automation(self, automation_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        current = self.get_automation(automation_id)
        if not current:
            return None
        merged = {
            **current,
            **updates,
            "id": automation_id,
            "agentId": updates.get("agentId") or current["agentId"],
            "runtimeId": updates.get("runtimeId") or current["runtimeId"],
            "metadata": {**current.get("metadata", {}), **updates.get("metadata", {})}
            if isinstance(updates.get("metadata"), dict)
            else current.get("metadata", {}),
        }
        return self.upsert_automation(merged)

    def delete_automation(self, automation_id: str) -> bool:
        with self.connect() as connection:
            cursor = connection.execute("delete from automations where id = ?", (automation_id,))
        return cursor.rowcount > 0


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


def agent_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "runtimeId": str(row["runtime_id"]),
        "runtimeKind": str(row["runtime_kind"]),
        "displayName": str(row["display_name"]),
        "runtimeProfile": str(row["runtime_profile"]),
        "isDefault": bool(row["is_default"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
        "metadata": loads(row["metadata_json"]),
    }


def conversation_from_row(row: sqlite3.Row) -> dict[str, Any]:
    metadata = loads(row["metadata_json"])
    return {
        "id": str(row["id"]),
        "agentId": str(row["agent_id"]),
        "title": str(row["title"]),
        "summary": str(row["summary"] or ""),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
        "archivedAt": int(row["archived_at"]) if row["archived_at"] is not None else None,
        "metadata": metadata,
        "runtimeId": str(row["runtime_id"] or ""),
        "runtimeProfile": str(row["runtime_profile"] or ""),
        "externalSessionId": str(row["external_session_id"] or ""),
        "externalChatId": str(row["external_chat_id"] or ""),
        "externalThreadId": str(row["external_thread_id"] or ""),
        "origin": loads(row["origin_json"]),
    }


def event_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "cursor": int(row["cursor"]),
        "id": str(row["id"]),
        "conversationId": str(row["conversation_id"]),
        "agentId": str(row["agent_id"]),
        "runtimeId": str(row["runtime_id"] or ""),
        "type": str(row["type"]),
        "role": str(row["role"] or ""),
        "content": str(row["content"] or ""),
        "parentEventId": str(row["parent_event_id"] or ""),
        "externalMessageId": str(row["external_message_id"] or ""),
        "idempotencyKey": str(row["idempotency_key"] or ""),
        "createdAt": int(row["created_at"]),
        "metadata": loads(row["metadata_json"]),
    }


def message_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "conversationId": str(row["conversation_id"]),
        "role": str(row["role"]),
        "content": str(row["content"] or ""),
        "status": str(row["status"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
        "metadata": loads(row["metadata_json"]),
    }


def automation_from_row(row: sqlite3.Row) -> dict[str, Any]:
    metadata = loads(row["metadata_json"])
    return {
        "id": str(row["id"]),
        "agentId": str(row["agent_id"]),
        "runtimeId": str(row["runtime_id"]),
        "externalJobId": str(row["external_job_id"] or ""),
        "name": str(row["name"]),
        "schedule": str(row["schedule_text"]),
        "prompt": str(row["prompt"]),
        "deliverToConversationId": str(row["deliver_to_conversation_id"] or ""),
        "status": str(row["status"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
        "lastRunAt": int(row["last_run_at"]) if row["last_run_at"] is not None else None,
        "nextRunAt": int(row["next_run_at"]) if row["next_run_at"] is not None else None,
        "metadata": metadata,
    }


def optional_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


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
