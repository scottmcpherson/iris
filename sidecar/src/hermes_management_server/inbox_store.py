"""Small SQLite-backed inbox for Hermes-to-Iris deliveries."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from .security import ManagementError


def default_inbox_path() -> Path:
    return Path.home() / ".agent-ui" / "inbox.sqlite3"


class InboxStore:
    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path).expanduser() if path else default_inbox_path()

    def health(self) -> dict[str, Any]:
        self._ensure_schema()
        return {"ok": True, "path": str(self.path), "checkedAt": int(time.time())}

    def create_message(self, payload: dict[str, Any]) -> dict[str, Any]:
        content = str(payload.get("content") or "").strip()
        if not content:
            raise ManagementError("Message content is required.", status_code=400)

        message_id = str(payload.get("id") or uuid.uuid4())
        source = safe_text(payload.get("source"), "hermes-cron", 80)
        chat_id = safe_text(payload.get("chatId") or payload.get("chat_id"), "agentui", 120)
        platform = safe_text(payload.get("platform"), "agentui", 80)
        created_at = int(payload.get("createdAt") or payload.get("created_at") or time.time())
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        profile = safe_text(payload.get("profile") or metadata.get("profile"), "default", 80)

        self._ensure_schema()
        with sqlite3.connect(self.path) as connection:
            cursor = connection.execute(
                """
                insert into inbox_messages
                  (id, source, platform, profile, chat_id, content, metadata_json, created_at, acknowledged_at)
                values (?, ?, ?, ?, ?, ?, ?, ?, null)
                on conflict(id) do update set
                  source=excluded.source,
                  platform=excluded.platform,
                  profile=excluded.profile,
                  chat_id=excluded.chat_id,
                  content=excluded.content,
                  metadata_json=excluded.metadata_json,
                  created_at=excluded.created_at
                """,
                (
                    message_id,
                    source,
                    platform,
                    profile,
                    chat_id,
                    content,
                    json.dumps(metadata, ensure_ascii=False, sort_keys=True),
                    created_at,
                ),
            )
            rowid = int(cursor.lastrowid or 0)
            row = connection.execute(
                message_select_sql("where id = ?"),
                (message_id,),
            ).fetchone()
        return row_to_message(row, rowid)

    def list_messages(self, after: int | None = None, limit: int = 50, profile: str | None = None) -> dict[str, Any]:
        self._ensure_schema()
        bounded_limit = min(max(int(limit or 50), 1), 200)
        cursor_after = max(int(after or 0), 0)
        normalized_profile = str(profile or "").strip()
        with sqlite3.connect(self.path) as connection:
            if normalized_profile:
                rows = connection.execute(
                    message_select_sql("where rowid > ? and profile = ? order by rowid asc limit ?"),
                    (cursor_after, normalized_profile, bounded_limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    message_select_sql("where rowid > ? order by rowid asc limit ?"),
                    (cursor_after, bounded_limit),
                ).fetchall()
        messages = [row_to_message(row) for row in rows]
        next_cursor = messages[-1]["cursor"] if messages else cursor_after
        return {"ok": True, "messages": messages, "cursor": next_cursor}

    def acknowledge_message(self, message_id: str) -> dict[str, Any]:
        normalized_id = str(message_id or "").strip()
        if not normalized_id:
            raise ManagementError("Message id is required.", status_code=400)

        acknowledged_at = int(time.time())
        self._ensure_schema()
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                "update inbox_messages set acknowledged_at = ? where id = ?",
                (acknowledged_at, normalized_id),
            )
            row = connection.execute(
                message_select_sql("where id = ?"),
                (normalized_id,),
            ).fetchone()
        if row is None:
            raise ManagementError("Inbox message was not found.", status_code=404)
        return {"ok": True, "message": row_to_message(row)}

    def _ensure_schema(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.path) as connection:
            connection.execute(
                """
                create table if not exists inbox_messages (
                  id text primary key,
                  source text not null,
                  platform text not null,
                  profile text not null default 'default',
                  chat_id text not null,
                  content text not null,
                  metadata_json text not null default '{}',
                  created_at integer not null,
                  acknowledged_at integer
                )
                """
            )
            connection.execute(
                "create index if not exists inbox_messages_created_idx on inbox_messages(created_at)"
            )
            columns = {row[1] for row in connection.execute("pragma table_info(inbox_messages)").fetchall()}
            if "profile" not in columns:
                connection.execute("alter table inbox_messages add column profile text not null default 'default'")
            connection.execute(
                "create index if not exists inbox_messages_profile_created_idx on inbox_messages(profile, created_at)"
            )


def row_to_message(row: tuple[Any, ...], fallback_cursor: int = 0) -> dict[str, Any]:
    cursor = int(row[0] or fallback_cursor)
    metadata: dict[str, Any] = {}
    try:
        loaded = json.loads(row[7] or "{}")
        if isinstance(loaded, dict):
            metadata = loaded
    except json.JSONDecodeError:
        metadata = {}
    return {
        "cursor": cursor,
        "id": str(row[1]),
        "source": str(row[2]),
        "platform": str(row[3]),
        "profile": str(row[4] or "default"),
        "chatId": str(row[5]),
        "content": str(row[6]),
        "metadata": metadata,
        "createdAt": int(row[8]),
        "acknowledgedAt": int(row[9]) if row[9] is not None else None,
    }


def message_select_sql(clause: str) -> str:
    return f"""
        select rowid, id, source, platform, profile, chat_id, content, metadata_json, created_at, acknowledged_at
        from inbox_messages
        {clause}
    """


def safe_text(value: object, fallback: str, limit: int) -> str:
    text = str(value or "").strip() or fallback
    return text[:limit]
