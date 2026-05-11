"""Session discovery for Hermes profile stores."""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from ..models import SessionMessage, SessionSummary
from ..security import ManagementError


SQLITE_SUFFIXES = {".db", ".sqlite", ".sqlite3"}
SQLITE_CANDIDATE_NAMES = (
    "state.db",
    "sessions.db",
    "sessions.db",
    "responses.db",
    "history.db",
)
ID_COLUMNS = ("id", "session_id", "session_id", "thread_id")
CHAT_ID_COLUMNS = ("chat_id", "chatId", "external_chat_id", "conversation_id")
SOURCE_COLUMNS = ("source", "platform", "client")
MODEL_COLUMNS = ("model", "model_name", "model_id")
TITLE_COLUMNS = ("title", "name", "summary")
START_COLUMNS = ("started_at", "session_start", "created_at", "created", "start_time", "timestamp")
END_COLUMNS = ("ended_at", "session_end", "completed_at", "finished_at", "end_time")
ACTIVE_COLUMNS = ("last_active_at", "last_updated", "updated_at", "modified_at")
COUNT_COLUMNS = ("message_count", "messages_count", "message_total", "count")
CONTENT_COLUMNS = ("content", "text", "body", "message", "prompt", "response")
ROLE_COLUMNS = ("role", "author", "speaker")
MESSAGE_TIME_COLUMNS = ("timestamp", "created_at", "created", "time", "sent_at")
MESSAGE_ID_COLUMNS = ("id", "message_id")
TOOL_COLUMNS = ("tool_name", "tool", "name")
TOOL_CALL_ID_COLUMNS = ("tool_call_id", "toolCallId", "call_id")
TOOL_CALLS_COLUMNS = ("tool_calls", "toolCalls")


@dataclass(frozen=True)
class SessionDiscovery:
    path: str
    schema_version: int | None
    sessions: list[SessionSummary]
    warning: str | None = None


@dataclass(frozen=True)
class SqliteSchema:
    tables: dict[str, list[str]]
    schema_version: int | None


@dataclass(frozen=True)
class MessageRow:
    role: str
    content: str
    timestamp: int | None
    id: str = ""
    tool_name: str = ""
    tool_call_id: str = ""
    tool_calls: list[dict[str, Any]] | None = None


@dataclass(frozen=True)
class SessionDetail:
    path: str
    schema_version: int | None
    session: SessionSummary
    messages: list[SessionMessage]
    warning: str | None = None


def clamp_limit(limit: int | None) -> int:
    try:
        value = int(limit if limit is not None else 80)
    except (TypeError, ValueError):
        value = 80
    return min(max(value, 1), 200)


def discover_sessions(profile_root: Path, limit: int | None = 80) -> SessionDiscovery:
    clamped_limit = clamp_limit(limit)
    warnings: list[str] = []

    for db_path in sqlite_candidates(profile_root):
        result = read_sqlite_sessions(db_path, profile_root, clamped_limit)
        if result.sessions:
            return result
        if result.warning:
            warnings.append(result.warning)

    file_result = read_session_file_sessions(profile_root, clamped_limit)
    if file_result.sessions:
        if warnings and not file_result.warning:
            return SessionDiscovery(
                path=file_result.path,
                schema_version=None,
                sessions=file_result.sessions,
                warning="No supported SQLite session schema found; using session JSON files.",
            )
        return file_result
    if file_result.warning:
        warnings.append(file_result.warning)

    warning = "No supported Hermes session store was found for this profile."
    if warnings:
        warning = f"{warning} {' '.join(warnings[:2])}"
    return SessionDiscovery(
        path=str(profile_root),
        schema_version=None,
        sessions=[],
        warning=warning,
    )


def discover_session_detail(profile_root: Path, session_id: str) -> SessionDetail:
    normalized_id = session_id.strip()
    if not normalized_id:
        raise ManagementError("Session id is required.", status_code=400)

    for db_path in sqlite_candidates(profile_root):
        result = read_sqlite_session_detail(db_path, profile_root, normalized_id)
        if result is not None:
            return result

    file_result = read_session_file_session_detail(profile_root, normalized_id)
    if file_result is not None:
        return file_result

    raise ManagementError("Session was not found.", status_code=404)


def discover_session_summaries(
    profile_root: Path,
    *,
    session_ids: set[str] | None = None,
    chat_ids: set[str] | None = None,
) -> list[SessionSummary]:
    normalized_session_ids = {item.strip() for item in (session_ids or set()) if item.strip()}
    normalized_chat_ids = {item.strip() for item in (chat_ids or set()) if item.strip()}
    if not normalized_session_ids and not normalized_chat_ids:
        return []

    for db_path in sqlite_candidates(profile_root):
        summaries = read_sqlite_session_summaries(
            db_path,
            profile_root,
            session_ids=normalized_session_ids,
            chat_ids=normalized_chat_ids,
        )
        if summaries:
            return summaries

    return read_session_file_session_summaries(
        profile_root,
        session_ids=normalized_session_ids,
        chat_ids=normalized_chat_ids,
    )


def sqlite_candidates(profile_root: Path) -> list[Path]:
    if not profile_root.is_dir():
        return []
    candidates: list[Path] = []
    seen: set[Path] = set()

    for name in SQLITE_CANDIDATE_NAMES:
        candidate = profile_root / name
        if candidate.is_file():
            safe_add_candidate(candidate, profile_root, candidates, seen)

    for candidate in sorted(profile_root.iterdir(), key=lambda item: item.name.lower()):
        if candidate.is_file() and candidate.suffix.lower() in SQLITE_SUFFIXES:
            safe_add_candidate(candidate, profile_root, candidates, seen)

    return candidates


def safe_add_candidate(candidate: Path, profile_root: Path, candidates: list[Path], seen: set[Path]) -> None:
    try:
        safe_path = assert_within_profile(candidate, profile_root)
    except ManagementError:
        return
    if safe_path not in seen:
        candidates.append(safe_path)
        seen.add(safe_path)


def read_sqlite_sessions(db_path: Path, profile_root: Path, limit: int) -> SessionDiscovery:
    try:
        safe_path = assert_within_profile(db_path, profile_root)
        connection = sqlite3.connect(f"file:{safe_path.as_posix()}?mode=ro", uri=True)
    except Exception as exc:
        return SessionDiscovery(
            path=str(db_path),
            schema_version=None,
            sessions=[],
            warning=f"Could not open SQLite session store {db_path.name}: {exc}",
        )

    try:
        connection.row_factory = sqlite3.Row
        schema = inspect_sqlite_schema(connection)
        session_table = choose_session_table(schema.tables)
        if session_table is None:
            return SessionDiscovery(
                path=str(safe_path),
                schema_version=schema.schema_version,
                sessions=[],
                warning=f"{safe_path.name} does not contain a supported sessions table.",
            )
        message_table = choose_message_table(schema.tables, session_table)
        sessions = normalize_sqlite_sessions(connection, schema, session_table, message_table)
        enrich_session_origins(sessions, profile_root)
        sessions.sort(key=lambda item: item.lastActiveAt or item.startedAt or 0, reverse=True)
        return SessionDiscovery(
            path=str(safe_path),
            schema_version=schema.schema_version,
            sessions=sessions[:limit],
        )
    except sqlite3.Error as exc:
        return SessionDiscovery(
            path=str(db_path),
            schema_version=None,
            sessions=[],
            warning=f"Could not inspect SQLite session store {db_path.name}: {exc}",
        )
    finally:
        connection.close()


def read_sqlite_session_detail(
    db_path: Path,
    profile_root: Path,
    session_id: str,
) -> SessionDetail | None:
    try:
        safe_path = assert_within_profile(db_path, profile_root)
        connection = sqlite3.connect(f"file:{safe_path.as_posix()}?mode=ro", uri=True)
    except Exception:
        return None

    try:
        connection.row_factory = sqlite3.Row
        schema = inspect_sqlite_schema(connection)
        session_table = choose_session_table(schema.tables)
        if session_table is None:
            return None
        session_columns = normalize_columns(schema.tables[session_table])
        id_column = first_column(session_columns, ID_COLUMNS)
        if id_column is None:
            return None
        session = connection.execute(
            f"select * from {quote_identifier(session_table)} where {quote_identifier(id_column)} = ? limit 1",
            (session_id,),
        ).fetchone()
        if session is None:
            return None
        message_table = choose_message_table(schema.tables, session_table)
        messages = read_sqlite_messages(connection, schema, message_table, session_id)
        summary = normalize_session_row(dict(session), session_columns, messages, default_source="sqlite")
        if summary is None or not is_visible_chat_session(summary):
            return None
        enrich_session_origins([summary], profile_root)
        return SessionDetail(
            path=str(safe_path),
            schema_version=schema.schema_version,
            session=summary,
            messages=session_messages(session_id, messages),
        )
    except sqlite3.Error:
        return None
    finally:
        connection.close()


def read_sqlite_session_summaries(
    db_path: Path,
    profile_root: Path,
    *,
    session_ids: set[str],
    chat_ids: set[str],
) -> list[SessionSummary]:
    try:
        safe_path = assert_within_profile(db_path, profile_root)
        connection = sqlite3.connect(f"file:{safe_path.as_posix()}?mode=ro", uri=True)
    except Exception:
        return []

    try:
        connection.row_factory = sqlite3.Row
        schema = inspect_sqlite_schema(connection)
        session_table = choose_session_table(schema.tables)
        if session_table is None:
            return []
        session_columns = normalize_columns(schema.tables[session_table])
        id_column = first_column(session_columns, ID_COLUMNS)
        if id_column is None:
            return []
        chat_column = first_column(session_columns, CHAT_ID_COLUMNS)
        ids_to_fetch = set(session_ids)
        if chat_ids:
            origins = session_origins_by_id(profile_root)
            ids_to_fetch.update(
                session_id
                for session_id, origin in origins.items()
                if value_as_text(origin.get("chat_id")) in chat_ids
            )

        rows: list[sqlite3.Row] = []
        for chunk in chunk_values(sorted(ids_to_fetch)):
            placeholders = ", ".join("?" for _ in chunk)
            rows.extend(
                connection.execute(
                    f"""
                    select * from {quote_identifier(session_table)}
                    where {quote_identifier(id_column)} in ({placeholders})
                    """,
                    tuple(chunk),
                ).fetchall()
            )
        if chat_ids and chat_column:
            for chunk in chunk_values(sorted(chat_ids)):
                placeholders = ", ".join("?" for _ in chunk)
                rows.extend(
                    connection.execute(
                        f"""
                        select * from {quote_identifier(session_table)}
                        where {quote_identifier(chat_column)} in ({placeholders})
                        """,
                        tuple(chunk),
                    ).fetchall()
                )

        if not rows:
            return []
        message_table = choose_message_table(schema.tables, session_table)
        summaries = normalize_sqlite_session_rows(connection, schema, session_table, message_table, rows)
        enrich_session_origins(summaries, profile_root)
        seen: set[str] = set()
        filtered: list[SessionSummary] = []
        for summary in summaries:
            if summary.id in seen:
                continue
            if summary.id not in session_ids and value_as_text(summary.chatId) not in chat_ids:
                continue
            seen.add(summary.id)
            filtered.append(summary)
        return filtered
    except sqlite3.Error:
        return []
    finally:
        connection.close()


def inspect_sqlite_schema(connection: sqlite3.Connection) -> SqliteSchema:
    tables: dict[str, list[str]] = {}
    rows = connection.execute(
        "select name from sqlite_master where type in ('table', 'view') order by name"
    ).fetchall()
    for row in rows:
        table = str(row["name"])
        if skip_sqlite_table(table):
            continue
        table_info = connection.execute(f"pragma table_info({quote_identifier(table)})").fetchall()
        columns = [str(column["name"]) for column in table_info]
        if columns:
            tables[table] = columns
    return SqliteSchema(tables=tables, schema_version=read_schema_version(connection, tables))


def read_schema_version(connection: sqlite3.Connection, tables: dict[str, list[str]]) -> int | None:
    if "schema_version" in tables and "version" in normalize_columns(tables["schema_version"]):
        try:
            row = connection.execute("select version from schema_version limit 1").fetchone()
            return int(row["version"]) if row and row["version"] is not None else None
        except (sqlite3.Error, TypeError, ValueError):
            return None
    if "state_meta" in tables:
        normalized = normalize_columns(tables["state_meta"])
        if {"key", "value"}.issubset(normalized):
            try:
                row = connection.execute(
                    "select value from state_meta where key in ('schema_version', 'version') limit 1"
                ).fetchone()
                return int(row["value"]) if row and row["value"] is not None else None
            except (sqlite3.Error, TypeError, ValueError):
                return None
    return None


def skip_sqlite_table(table: str) -> bool:
    lowered = table.lower()
    return lowered.startswith("sqlite_") or "_fts" in lowered or lowered.endswith("_fts")


def choose_session_table(tables: dict[str, list[str]]) -> str | None:
    best: tuple[int, str] | None = None
    for table, columns in tables.items():
        normalized = normalize_columns(columns)
        id_column = first_column(normalized, ID_COLUMNS)
        if id_column is None:
            continue
        lowered = table.lower()
        score = 0
        if lowered == "sessions":
            score += 10
        if any(word in lowered for word in ("session", "session", "chat", "thread", "response")):
            score += 5
        if first_column(normalized, START_COLUMNS):
            score += 3
        if first_column(normalized, TITLE_COLUMNS):
            score += 2
        if first_column(normalized, COUNT_COLUMNS):
            score += 2
        if score <= 0:
            continue
        candidate = (score, table)
        if best is None or candidate[0] > best[0]:
            best = candidate
    return best[1] if best else None


def choose_message_table(tables: dict[str, list[str]], session_table: str) -> str | None:
    session_columns = normalize_columns(tables[session_table])
    session_id = first_column(session_columns, ID_COLUMNS)
    if session_id is None:
        return None

    best: tuple[int, str] | None = None
    for table, columns in tables.items():
        if table == session_table:
            continue
        normalized = normalize_columns(columns)
        link_column = first_message_link_column(normalized)
        content_column = first_column(normalized, CONTENT_COLUMNS)
        if link_column is None or content_column is None:
            continue
        lowered = table.lower()
        score = 0
        if lowered == "messages":
            score += 10
        if any(word in lowered for word in ("message", "turn", "event", "response")):
            score += 5
        if first_column(normalized, MESSAGE_TIME_COLUMNS):
            score += 2
        candidate = (score, table)
        if score > 0 and (best is None or candidate[0] > best[0]):
            best = candidate
    return best[1] if best else None


def normalize_sqlite_sessions(
    connection: sqlite3.Connection,
    schema: SqliteSchema,
    session_table: str,
    message_table: str | None,
) -> list[SessionSummary]:
    query = f"select * from {quote_identifier(session_table)}"
    rows = connection.execute(query).fetchall()
    return normalize_sqlite_session_rows(connection, schema, session_table, message_table, rows)


def normalize_sqlite_session_rows(
    connection: sqlite3.Connection,
    schema: SqliteSchema,
    session_table: str,
    message_table: str | None,
    rows: list[sqlite3.Row],
) -> list[SessionSummary]:
    session_columns = normalize_columns(schema.tables[session_table])
    session_ids: list[str] = []
    normalized_rows: list[tuple[dict[str, Any], str]] = []
    for row in rows:
        session = dict(row)
        session_id = value_as_text(first_value(session, ID_COLUMNS))
        if not session_id:
            continue
        normalized_rows.append((session, session_id))
        session_ids.append(session_id)
    messages_by_session = read_sqlite_messages_for_sessions(
        connection,
        schema,
        message_table,
        set(session_ids),
    )
    sessions: list[SessionSummary] = []
    for session, session_id in normalized_rows:
        messages = messages_by_session.get(session_id, [])
        summary = normalize_session_row(session, session_columns, messages, default_source="sqlite")
        if summary is not None and is_visible_chat_session(summary):
            sessions.append(summary)
    return sessions


def read_sqlite_messages_for_sessions(
    connection: sqlite3.Connection,
    schema: SqliteSchema,
    message_table: str | None,
    session_ids: set[str],
) -> dict[str, list[MessageRow]]:
    if message_table is None or not session_ids:
        return {}
    columns = normalize_columns(schema.tables[message_table])
    link_column = first_message_link_column(columns)
    content_column = first_column(columns, CONTENT_COLUMNS)
    if link_column is None or content_column is None:
        return {}
    role_column = first_column(columns, ROLE_COLUMNS)
    timestamp_column = first_column(columns, MESSAGE_TIME_COLUMNS)
    message_id_column = first_column(columns, MESSAGE_ID_COLUMNS)
    tool_column = first_column(columns, TOOL_COLUMNS)
    tool_call_id_column = first_column(columns, TOOL_CALL_ID_COLUMNS)
    tool_calls_column = first_column(columns, TOOL_CALLS_COLUMNS)
    select_columns = [link_column, content_column]
    if role_column:
        select_columns.append(role_column)
    if timestamp_column:
        select_columns.append(timestamp_column)
    if message_id_column and message_id_column not in select_columns:
        select_columns.append(message_id_column)
    if tool_column and tool_column not in select_columns:
        select_columns.append(tool_column)
    if tool_call_id_column and tool_call_id_column not in select_columns:
        select_columns.append(tool_call_id_column)
    if tool_calls_column and tool_calls_column not in select_columns:
        select_columns.append(tool_calls_column)
    if timestamp_column and message_id_column:
        order_by = (
            f" order by {quote_identifier(timestamp_column)} asc, "
            f"{quote_identifier(message_id_column)} asc"
        )
    elif timestamp_column:
        order_by = f" order by {quote_identifier(timestamp_column)} asc"
    else:
        order_by = ""

    messages_by_session: dict[str, list[MessageRow]] = {}
    for chunk in chunk_values(sorted(session_ids)):
        placeholders = ", ".join("?" for _ in chunk)
        query = (
            f"select {', '.join(quote_identifier(column) for column in select_columns)} "
            f"from {quote_identifier(message_table)} "
            f"where {quote_identifier(link_column)} in ({placeholders})"
            f"{order_by}"
        )
        try:
            rows = connection.execute(query, tuple(chunk)).fetchall()
        except sqlite3.Error:
            continue
        for row in rows:
            item = dict(row)
            session_id = value_as_text(item.get(link_column))
            messages_by_session.setdefault(session_id, []).append(
                MessageRow(
                    role=value_as_text(item.get(role_column or "")),
                    content=content_to_text(item.get(content_column)),
                    timestamp=normalize_timestamp(item.get(timestamp_column or "")),
                    id=value_as_text(item.get(message_id_column or "")),
                    tool_name=value_as_text(item.get(tool_column or "")),
                    tool_call_id=value_as_text(item.get(tool_call_id_column or "")),
                    tool_calls=parse_tool_calls(item.get(tool_calls_column or "")),
                )
            )
    return messages_by_session


def read_sqlite_messages(
    connection: sqlite3.Connection,
    schema: SqliteSchema,
    message_table: str | None,
    session_id: str,
) -> list[MessageRow]:
    return read_sqlite_messages_for_sessions(
        connection,
        schema,
        message_table,
        {session_id},
    ).get(session_id, [])


def chunk_values(values: list[str], size: int = 900) -> list[list[str]]:
    return [values[index:index + size] for index in range(0, len(values), size)]



def normalize_session_row(
    row: dict[str, Any],
    columns: dict[str, str],
    messages: list[MessageRow],
    *,
    default_source: str,
) -> SessionSummary | None:
    session_id = value_as_text(first_value(row, ID_COLUMNS))
    if not session_id:
        return None

    explicit_title = compact_text(value_as_text(first_value(row, TITLE_COLUMNS)), 120)
    first_user = first_message_text(messages, preferred_role="user")
    first_any = first_message_text(messages)
    latest_any = last_message_text(messages)
    preview = compact_text(latest_any or first_user or first_any or explicit_title, 220)
    title = compact_text(explicit_title or first_user or first_any or "Untitled session", 120)
    started_at = first_timestamp(row, START_COLUMNS)
    ended_at = first_timestamp(row, END_COLUMNS)
    row_active_at = first_timestamp(row, ACTIVE_COLUMNS)
    message_active_at = max((message.timestamp or 0 for message in messages), default=0) or None
    last_active_at = max_present(row_active_at, ended_at, message_active_at, started_at)
    message_count = first_int(row, COUNT_COLUMNS)
    if message_count is None or (messages and message_count < len(messages)):
        message_count = len(messages)
    origin = origin_payload(first_value(row, ("origin",)))
    chat_id = value_as_text(origin.get("chat_id") or first_value(row, ("chat_id",)))

    return SessionSummary(
        id=session_id,
        source=value_as_text(first_value(row, SOURCE_COLUMNS)) or default_source,
        model=value_as_text(first_value(row, MODEL_COLUMNS)),
        title=title,
        preview=preview,
        chatId=chat_id or None,
        origin=origin,
        startedAt=started_at,
        endedAt=ended_at,
        lastActiveAt=last_active_at,
        messageCount=message_count or 0,
    )


def read_session_file_sessions(profile_root: Path, limit: int) -> SessionDiscovery:
    sessions_dir = profile_root / "sessions"
    try:
        safe_sessions_dir = assert_within_profile(sessions_dir, profile_root)
    except ManagementError as exc:
        return SessionDiscovery(path=str(sessions_dir), schema_version=None, sessions=[], warning=exc.error)
    if not safe_sessions_dir.is_dir():
        return SessionDiscovery(
            path=str(safe_sessions_dir),
            schema_version=None,
            sessions=[],
            warning="No session JSON directory was found for this profile.",
        )

    sessions: list[SessionSummary] = []
    for path in sorted(safe_sessions_dir.glob("*.json"), key=lambda item: item.name.lower()):
        try:
            safe_path = assert_within_profile(path, profile_root)
            payload = json.loads(safe_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ManagementError):
            continue
        if isinstance(payload, dict):
            summary = normalize_session_file(payload)
            if summary is not None and is_visible_chat_session(summary):
                sessions.append(summary)

    sessions.sort(key=lambda item: item.lastActiveAt or item.startedAt or 0, reverse=True)
    return SessionDiscovery(
        path=str(safe_sessions_dir),
        schema_version=None,
        sessions=sessions[:limit],
    )


def enrich_session_origins(sessions: list[SessionSummary], profile_root: Path) -> None:
    origins = session_origins_by_id(profile_root)
    if not origins:
        return
    for session in sessions:
        origin = origins.get(session.id)
        if not origin:
            continue
        session.origin = origin
        chat_id = value_as_text(origin.get("chat_id"))
        if chat_id:
            session.chatId = chat_id


def session_origins_by_id(profile_root: Path) -> dict[str, dict[str, Any]]:
    path = profile_root / "sessions" / "sessions.json"
    if not path.exists():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(loaded, dict):
        return {}
    origins: dict[str, dict[str, Any]] = {}
    for entry in loaded.values():
        if not isinstance(entry, dict):
            continue
        session_id = value_as_text(entry.get("session_id"))
        origin = origin_payload(entry.get("origin"))
        if session_id and origin:
            origins[session_id] = origin
    return origins


def read_session_file_session_detail(profile_root: Path, session_id: str) -> SessionDetail | None:
    sessions_dir = profile_root / "sessions"
    try:
        safe_sessions_dir = assert_within_profile(sessions_dir, profile_root)
    except ManagementError:
        return None
    if not safe_sessions_dir.is_dir():
        return None

    for path in sorted(safe_sessions_dir.glob("*.json"), key=lambda item: item.name.lower()):
        try:
            safe_path = assert_within_profile(path, profile_root)
            payload = json.loads(safe_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ManagementError):
            continue
        if not isinstance(payload, dict):
            continue
        summary = normalize_session_file(payload)
        if summary is None or summary.id != session_id or not is_visible_chat_session(summary):
            continue
        messages = normalize_file_messages(payload.get("messages"))
        return SessionDetail(
            path=str(safe_path),
            schema_version=None,
            session=summary,
            messages=session_messages(session_id, messages),
        )
    return None


def read_session_file_session_summaries(
    profile_root: Path,
    *,
    session_ids: set[str],
    chat_ids: set[str],
) -> list[SessionSummary]:
    sessions_dir = profile_root / "sessions"
    try:
        safe_sessions_dir = assert_within_profile(sessions_dir, profile_root)
    except ManagementError:
        return []
    if not safe_sessions_dir.is_dir():
        return []

    candidates: list[SessionSummary] = []
    for path in sorted(safe_sessions_dir.glob("*.json"), key=lambda item: item.name.lower()):
        try:
            safe_path = assert_within_profile(path, profile_root)
            payload = json.loads(safe_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ManagementError):
            continue
        if not isinstance(payload, dict):
            continue
        summary = normalize_session_file(payload)
        if summary is None or not is_visible_chat_session(summary):
            continue
        candidates.append(summary)
    enrich_session_origins(candidates, profile_root)
    return [
        summary
        for summary in candidates
        if summary.id in session_ids or value_as_text(summary.chatId) in chat_ids
    ]


def normalize_session_file(payload: dict[str, Any]) -> SessionSummary | None:
    messages = normalize_file_messages(payload.get("messages"))
    row = {
        "id": payload.get("id") or payload.get("session_id") or payload.get("session_id"),
        "source": payload.get("source") or payload.get("platform"),
        "model": payload.get("model") or payload.get("model_name"),
        "title": payload.get("title") or payload.get("name") or payload.get("summary"),
        "session_start": payload.get("session_start") or payload.get("started_at") or payload.get("created_at"),
        "ended_at": payload.get("ended_at") or payload.get("session_end"),
        "last_updated": payload.get("last_updated") or payload.get("updated_at"),
        "message_count": payload.get("message_count"),
    }
    return normalize_session_row(row, normalize_columns(row.keys()), messages, default_source="session-file")


def is_visible_chat_session(summary: SessionSummary) -> bool:
    source = summary.source.strip().lower()
    return source != "cron" and not summary.id.startswith("cron_")


def normalize_file_messages(value: Any) -> list[MessageRow]:
    if not isinstance(value, list):
        return []
    messages: list[MessageRow] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        messages.append(
            MessageRow(
                role=value_as_text(item.get("role") or item.get("author") or item.get("speaker")),
                content=content_to_text(item.get("content") or item.get("text") or item.get("message")),
                timestamp=normalize_timestamp(
                    item.get("timestamp")
                    or item.get("created_at")
                    or item.get("created")
                    or item.get("time")
                    or item.get("sent_at")
                ),
                id=value_as_text(item.get("id") or item.get("message_id")),
                tool_name=value_as_text(item.get("toolName") or item.get("tool_name") or item.get("tool")),
                tool_call_id=value_as_text(item.get("toolCallId") or item.get("tool_call_id") or item.get("call_id")),
                tool_calls=parse_tool_calls(item.get("toolCalls") or item.get("tool_calls")),
            )
        )
    return messages


def session_messages(session_id: str, messages: list[MessageRow]) -> list[SessionMessage]:
    rows: list[SessionMessage] = []
    for index, message in enumerate(messages):
        rows.append(
            SessionMessage(
                id=message.id or f"{session_id}-{index}",
                sessionId=session_id,
                role=safe_role(message.role),
                content=message.content,
                toolName=message.tool_name,
                toolCallId=message.tool_call_id,
                toolCalls=message.tool_calls or [],
                timestamp=message.timestamp,
            )
        )
    return rows


def safe_role(value: str) -> str:
    role = value_as_text(value).lower()
    return role if role in {"system", "user", "assistant", "tool"} else "assistant"


def assert_within_profile(path: Path, profile_root: Path) -> Path:
    resolved_root = profile_root.resolve()
    resolved_path = path.resolve()
    try:
        resolved_path.relative_to(resolved_root)
    except ValueError as exc:
        raise ManagementError(
            "Session store paths must stay inside the selected Hermes profile directory.",
            status_code=400,
        ) from exc
    return resolved_path


def normalize_columns(columns: Any) -> dict[str, str]:
    return {str(column).lower(): str(column) for column in columns}


def first_column(columns: dict[str, str], candidates: tuple[str, ...]) -> str | None:
    for candidate in candidates:
        if candidate in columns:
            return columns[candidate]
    return None


def first_message_link_column(columns: dict[str, str]) -> str | None:
    for candidate in ("session_id", "session_id", "thread_id", "chat_id", "parent_session_id"):
        if candidate in columns:
            return columns[candidate]
    return None


def first_value(row: dict[str, Any], candidates: tuple[str, ...]) -> Any:
    normalized = {key.lower(): key for key in row}
    for candidate in candidates:
        key = normalized.get(candidate)
        if key is not None:
            return row.get(key)
    return None


def origin_payload(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def first_timestamp(row: dict[str, Any], candidates: tuple[str, ...]) -> int | None:
    return normalize_timestamp(first_value(row, candidates))


def first_int(row: dict[str, Any], candidates: tuple[str, ...]) -> int | None:
    value = first_value(row, candidates)
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_timestamp(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return normalize_numeric_timestamp(float(value))
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"-?\d+(\.\d+)?", text):
        try:
            return normalize_numeric_timestamp(float(text))
        except ValueError:
            return None
    try:
        normalized = text.replace("Z", "+00:00")
        return int(datetime.fromisoformat(normalized).timestamp())
    except ValueError:
        return None


def normalize_numeric_timestamp(value: float) -> int | None:
    if value <= 0:
        return None
    if value > 1_000_000_000_000_000:
        value = value / 1_000_000
    elif value > 1_000_000_000_000:
        value = value / 1_000
    return int(value)


def max_present(*values: int | None) -> int | None:
    present = [value for value in values if value is not None]
    return max(present) if present else None


def value_as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def parse_tool_calls(value: Any) -> list[dict[str, Any]]:
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


def content_to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return " ".join(content_to_text(item) for item in value).strip()
    if isinstance(value, dict):
        for key in ("text", "content", "message", "value"):
            if key in value:
                return content_to_text(value[key])
        return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


def first_message_text(messages: list[MessageRow], preferred_role: str | None = None) -> str:
    for message in messages:
        if preferred_role and message.role.lower() != preferred_role:
            continue
        if message.content:
            return message.content
    return ""


def last_message_text(messages: list[MessageRow]) -> str:
    for message in reversed(messages):
        if message.content:
            return message.content
    return ""


def compact_text(value: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", value).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "..."


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'
