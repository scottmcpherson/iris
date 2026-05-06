from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from hermes_management_server.conversations import discover_conversations
from hermes_management_server.main import Settings, create_app


def make_client(root: Path) -> TestClient:
    return TestClient(create_app(Settings(hermes_home=str(root))))


def create_observed_state_db(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        create table schema_version (version integer not null);
        insert into schema_version values (11);

        create table sessions (
            id text primary key,
            source text not null,
            model text,
            started_at real not null,
            ended_at real,
            message_count integer default 0,
            title text
        );

        create table messages (
            id integer primary key autoincrement,
            session_id text not null,
            role text not null,
            content text,
            tool_call_id text,
            tool_calls text,
            tool_name text,
            timestamp real not null
        );
        """
    )
    connection.execute(
        "insert into sessions (id, source, model, started_at, ended_at, message_count, title) values (?, ?, ?, ?, ?, ?, ?)",
        ("older", "cli", "gpt-5.4", 1000, 1010, 2, "Explicit title"),
    )
    connection.execute(
        "insert into sessions (id, source, model, started_at, ended_at, message_count, title) values (?, ?, ?, ?, ?, ?, ?)",
        ("newer", "api_server", "gpt-5.5", 2000, None, 2, None),
    )
    connection.executemany(
        "insert into messages (session_id, role, content, timestamp) values (?, ?, ?, ?)",
        [
            ("older", "user", "Old question", 1001),
            ("older", "assistant", "Old answer", 1009),
            ("newer", "user", "How do I list profiles?", 2001),
            ("newer", "assistant", "Use the profiles endpoint.", 2005),
        ],
    )
    connection.commit()
    connection.close()


def test_conversations_from_observed_sqlite_schema(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    create_observed_state_db(root / "state.db")

    result = discover_conversations(root, limit=80)

    assert result.path == str(root / "state.db")
    assert result.schema_version == 11
    assert result.warning is None
    assert [item.id for item in result.conversations] == ["newer", "older"]
    newer = result.conversations[0]
    assert newer.source == "api_server"
    assert newer.model == "gpt-5.5"
    assert newer.title == "How do I list profiles?"
    assert newer.preview == "Use the profiles endpoint."
    assert newer.startedAt == 2000
    assert newer.endedAt is None
    assert newer.lastActiveAt == 2005
    assert newer.messageCount == 2


def test_conversations_hide_cron_runner_sessions(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    create_observed_state_db(root / "state.db")
    with sqlite3.connect(root / "state.db") as connection:
        connection.execute(
            "insert into sessions (id, source, model, started_at, ended_at, message_count, title) values (?, ?, ?, ?, ?, ?, ?)",
            ("cron_job_1", "cron", "gpt-5.5", 3000, 3010, 1, "Cron runner transcript"),
        )
        connection.execute(
            "insert into messages (session_id, role, content, timestamp) values (?, ?, ?, ?)",
            ("cron_job_1", "user", "[IMPORTANT: You are running as a scheduled cron job.]", 3001),
        )

    result = discover_conversations(root, limit=80)
    detail_response = make_client(root).get("/v1/profiles/default/conversations/cron_job_1")

    assert [item.id for item in result.conversations] == ["newer", "older"]
    assert detail_response.status_code == 404


def test_conversations_endpoint_clamps_limit(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    connection = sqlite3.connect(root / "state.db")
    connection.executescript(
        """
        create table sessions (
            id text primary key,
            source text not null,
            model text,
            started_at real not null,
            message_count integer default 0
        );
        """
    )
    connection.executemany(
        "insert into sessions (id, source, model, started_at, message_count) values (?, ?, ?, ?, ?)",
        [(f"session-{index}", "api_server", "gpt-5.5", index, 0) for index in range(205)],
    )
    connection.commit()
    connection.close()

    response = make_client(root).get("/v1/profiles/default/conversations?limit=999")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert len(body["conversations"]) == 200
    assert body["conversations"][0]["id"] == "session-204"


def test_conversation_detail_endpoint_reads_messages(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    create_observed_state_db(root / "state.db")

    response = make_client(root).get("/v1/profiles/default/conversations/newer")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["source"] == "hermes-management"
    assert body["conversation"]["id"] == "newer"
    assert body["conversation"]["title"] == "How do I list profiles?"
    assert [message["role"] for message in body["messages"]] == ["user", "assistant"]
    assert body["messages"][0]["sessionId"] == "newer"
    assert body["messages"][1]["content"] == "Use the profiles endpoint."


def test_conversation_detail_orders_timestamp_ties_by_message_id(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    connection = sqlite3.connect(root / "state.db")
    connection.executescript(
        """
        create table sessions (
            id text primary key,
            source text not null,
            started_at real not null
        );

        create table messages (
            message_id text not null,
            session_id text not null,
            role text not null,
            content text,
            timestamp real not null
        );
        """
    )
    connection.execute(
        "insert into sessions (id, source, started_at) values (?, ?, ?)",
        ("tied", "api_server", 1000),
    )
    connection.executemany(
        "insert into messages (message_id, session_id, role, content, timestamp) values (?, ?, ?, ?, ?)",
        [
            ("m2", "tied", "assistant", "Second", 1001),
            ("m1", "tied", "user", "First", 1001),
            ("m3", "tied", "assistant", "Third", 1001),
        ],
    )
    connection.commit()
    connection.close()

    response = make_client(root).get("/v1/profiles/default/conversations/tied")

    assert response.status_code == 200
    body = response.json()
    assert [message["id"] for message in body["messages"]] == ["m1", "m2", "m3"]
    assert [message["content"] for message in body["messages"]] == ["First", "Second", "Third"]


def test_conversation_detail_endpoint_includes_tool_call_metadata(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    create_observed_state_db(root / "state.db")
    tool_calls = [
        {
            "id": "call_1",
            "call_id": "call_1",
            "type": "function",
            "function": {
                "name": "terminal",
                "arguments": "{\"command\":\"echo hello\",\"timeout\":20}",
            },
        }
    ]
    with sqlite3.connect(root / "state.db") as connection:
        connection.execute(
            "insert into messages (session_id, role, content, tool_calls, timestamp) values (?, ?, ?, ?, ?)",
            ("newer", "assistant", "", json.dumps(tool_calls), 2006),
        )
        connection.execute(
            "insert into messages (session_id, role, content, tool_call_id, timestamp) values (?, ?, ?, ?, ?)",
            ("newer", "tool", "{\"output\":\"hello\",\"exit_code\":0}", "call_1", 2007),
        )

    response = make_client(root).get("/v1/profiles/default/conversations/newer")

    assert response.status_code == 200
    body = response.json()
    assistant_call = body["messages"][2]
    tool_result = body["messages"][3]
    assert assistant_call["toolCalls"][0]["function"]["name"] == "terminal"
    assert tool_result["toolCallId"] == "call_1"


def test_conversation_detail_endpoint_returns_404_for_missing_session(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    create_observed_state_db(root / "state.db")

    response = make_client(root).get("/v1/profiles/default/conversations/missing")

    assert response.status_code == 404
    assert response.json()["error"] == "Conversation was not found."


def test_conversations_falls_back_to_session_json_files(tmp_path):
    root = tmp_path / ".hermes"
    sessions = root / "sessions"
    sessions.mkdir(parents=True)
    sqlite3.connect(root / "state.db").execute("create table unrelated (id text)").connection.close()
    (sessions / "session_1.json").write_text(
        json.dumps(
            {
                "session_id": "file-session",
                "platform": "api_server",
                "model": "gpt-5.5",
                "session_start": "2026-05-03T10:00:00",
                "last_updated": "2026-05-03T10:05:00",
                "messages": [
                    {"role": "user", "content": "Summarize this"},
                    {"role": "assistant", "content": "Short summary"},
                ],
            }
        ),
        encoding="utf-8",
    )

    result = discover_conversations(root, limit=80)

    assert result.path == str(sessions)
    assert result.schema_version is None
    assert "session JSON" in (result.warning or "")
    assert len(result.conversations) == 1
    assert result.conversations[0].id == "file-session"
    assert result.conversations[0].title == "Summarize this"
    assert result.conversations[0].preview == "Short summary"
    assert result.conversations[0].messageCount == 2


def test_conversation_detail_falls_back_to_session_json_file(tmp_path):
    root = tmp_path / ".hermes"
    sessions = root / "sessions"
    sessions.mkdir(parents=True)
    sqlite3.connect(root / "state.db").execute("create table unrelated (id text)").connection.close()
    (sessions / "session_1.json").write_text(
        json.dumps(
            {
                "session_id": "file-session",
                "platform": "api_server",
                "model": "gpt-5.5",
                "session_start": "2026-05-03T10:00:00",
                "last_updated": "2026-05-03T10:05:00",
                "messages": [
                    {"id": "u1", "role": "user", "content": "Summarize this"},
                    {"id": "a1", "role": "assistant", "content": "Short summary"},
                ],
            }
        ),
        encoding="utf-8",
    )

    response = make_client(root).get("/v1/profiles/default/conversations/file-session")

    assert response.status_code == 200
    body = response.json()
    assert body["conversation"]["id"] == "file-session"
    assert [message["id"] for message in body["messages"]] == ["u1", "a1"]
    assert body["messages"][1]["content"] == "Short summary"


def test_conversations_unknown_store_returns_warning(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir()
    sqlite3.connect(root / "state.db").execute("create table unrelated (id text)").connection.close()

    response = make_client(root).get("/v1/profiles/default/conversations")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["conversations"] == []
    assert "No supported Hermes conversation store" in body["warning"]


def test_conversation_file_fallback_rejects_symlink_escape(tmp_path):
    root = tmp_path / ".hermes"
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "session.json").write_text("{}", encoding="utf-8")
    root.mkdir()
    (root / "sessions").symlink_to(outside)

    result = discover_conversations(root, limit=80)

    assert result.conversations == []
    assert "inside the selected Hermes profile directory" in (result.warning or "")
