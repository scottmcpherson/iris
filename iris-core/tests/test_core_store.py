from __future__ import annotations

import hashlib
import sqlite3

import pytest

from hermes_management_server.core_store import (
    CoreStore,
    draft_session,
    session_id_for_runtime,
    session_from_runtime_summary,
    is_allowed_attachment_mime,
)
from hermes_management_server.models import SessionSummary


def test_core_store_creates_only_core_owned_schema(tmp_path):
    store = CoreStore(tmp_path / "core.sqlite3")
    runtime = store.upsert_runtime(
        {
            "id": "runtime_local_hermes",
            "kind": "hermes",
            "name": "Local Hermes",
            "connection": {"gatewayUrl": "http://127.0.0.1:8642"},
        }
    )

    assert store.health()["schemaVersion"] == 7
    assert store.health()["sourceOfTruthMigration"] == "complete"
    assert runtime["id"] == "runtime_local_hermes"
    assert set(store.tables()) == {
        "schema_meta",
        "devices",
        "runtimes",
        "device_cursors",
        "core_events",
        "client_message_metadata",
        "attachments",
        "message_attachments",
        "projects",
        "project_sessions",
        "session_read_state",
    }


def test_core_store_connections_use_lock_tolerant_sqlite_pragmas(tmp_path):
    store = CoreStore(tmp_path / "core.sqlite3")

    with store.connect() as connection:
        busy_timeout = connection.execute("PRAGMA busy_timeout").fetchone()[0]
        journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        synchronous = connection.execute("PRAGMA synchronous").fetchone()[0]

    assert busy_timeout == 5000
    assert journal_mode == "wal"
    assert synchronous == 1


def test_source_of_truth_migration_drops_duplicate_tables_and_preserves_core_data(tmp_path):
    path = tmp_path / "core.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            create table schema_meta(key text primary key, value text not null);
            insert into schema_meta(key, value) values('schema_version', '1');
            create table devices(
              id text primary key,
              name text not null,
              kind text not null,
              token_hash text not null,
              created_at integer not null,
              last_seen_at integer,
              revoked_at integer,
              metadata_json text not null
            );
            insert into devices values('dev_1', 'Desktop', 'desktop', 'hash', 1, null, null, '{}');
            create table runtimes(
              id text primary key,
              kind text not null,
              name text not null,
              connection_json text not null,
              enabled integer not null,
              created_at integer not null,
              updated_at integer not null,
              last_probe_json text not null
            );
            insert into runtimes values('runtime_local_hermes', 'hermes', 'Local Hermes', '{}', 1, 1, 1, '{}');
            create table agents(id text primary key);
            create table sessions(id text primary key);
            create table session_runtime_links(session_id text primary key);
            create table message_events(cursor integer primary key autoincrement);
            create table session_messages(id text primary key);
            create table automations(id text primary key);
            """
        )

    store = CoreStore(path, auto_migrate=False)
    result = store.migrate_source_of_truth_schema(backup=True)

    assert result["status"] == "complete"
    assert result["backupPath"]
    assert "agents" in result["tablesDropped"]
    assert set(store.tables()) == {
        "schema_meta",
        "devices",
        "runtimes",
        "device_cursors",
        "core_events",
        "client_message_metadata",
        "attachments",
        "message_attachments",
        "projects",
        "project_sessions",
        "session_read_state",
    }
    assert store.list_devices()[0]["id"] == "dev_1"
    assert store.list_runtimes()[0]["id"] == "runtime_local_hermes"


def test_core_store_migrates_legacy_session_overlay_tables(tmp_path):
    path = tmp_path / "core.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            create table projects(
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
            insert into projects values('project_1', 'Iris', 'iris', 'agent_default', '', 1, 1, null, '{}');
            create table project_conversations(
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
              primary key (project_id, conversation_id)
            );
            insert into project_conversations values(
              'project_1', 'session_1', 'agent_default', 'runtime_local_hermes',
              'default', 'external_1', 'chat_1', 1, 2, '{}'
            );
            create table conversation_read_state(
              conversation_id text primary key,
              state text not null,
              created_at integer not null,
              updated_at integer not null,
              metadata_json text not null
            );
            insert into conversation_read_state values('session_1', 'unread', 1, 2, '{}');
            create table attachments(
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
            insert into attachments values(
              'att_1', '', 'runtime_local_hermes', 'default', 'session_1', null,
              'note.txt', 'text/plain', 'document', 10, 'abc', 'local_file',
              '/tmp/note.txt', 1, 1, null, '{}'
            );
            """
        )

    store = CoreStore(path)

    assert "project_conversations" not in store.tables()
    assert "conversation_read_state" not in store.tables()
    assert store.list_project_session_links("project_1")[0]["sessionId"] == "session_1"
    assert store.session_read_state("session_1")["state"] == "unread"
    with store.connect() as connection:
        attachment_columns = {
            str(row["name"])
            for row in connection.execute("pragma table_info(attachments)").fetchall()
        }
    assert "session_id" in attachment_columns
    assert "conversation_id" not in attachment_columns


def test_core_store_project_crud_and_session_links(tmp_path):
    store = CoreStore(tmp_path / "core.sqlite3")
    project = store.create_project(
        name="Iris",
        default_agent_id="agent_default",
        system_prompt="Use repo-local context.",
    )
    renamed = store.update_project(
        project["id"],
        name="Iris",
        default_agent_id="agent_research",
        system_prompt="Use project notes.",
        metadata={"color": "green"},
    )
    session = {
        "id": "session_1",
        "agentId": "agent_default",
        "runtimeId": "runtime_local_hermes",
        "runtimeProfile": "default",
        "externalSessionId": "session-1",
        "externalChatId": "chat-1",
    }
    link = store.link_project_session(project["id"], session)
    real_session = {
        **session,
        "id": "session_2",
        "externalSessionId": "session-2",
    }
    real_link = store.link_project_session(project["id"], real_session)

    assert renamed["name"] == "Iris"
    assert renamed["slug"] == "iris"
    assert renamed["defaultAgentId"] == "agent_research"
    assert renamed["systemPrompt"] == "Use project notes."
    assert renamed["metadata"]["color"] == "green"
    assert link["projectId"] == project["id"]
    assert real_link["projectId"] == project["id"]
    assert store.project_for_session("session_1") is None
    assert store.project_for_session("session_2")["id"] == project["id"]
    assert [item["sessionId"] for item in store.list_project_session_links(project["id"])] == ["session_2"]
    archived = store.archive_project(project["id"])
    assert archived["archivedAt"] is not None
    assert store.list_projects() == []


def test_core_session_summary_prefers_chat_id_for_core_session_identity():
    agent = {
        "id": "agent_default",
        "runtimeId": "runtime_local_hermes",
        "runtimeProfile": "default",
    }
    draft = draft_session(
        agent,
        title="Draft chat",
        external_chat_id="core-chat-1",
    )
    persisted = session_from_runtime_summary(
        agent,
        SessionSummary(
            id="hermes-session-1",
            source="iris",
            model="gpt-5.5",
            title="Persisted chat",
            preview="Hello",
            chatId="core-chat-1",
            origin={},
            startedAt=10,
            endedAt=None,
            lastActiveAt=20,
            messageCount=2,
        ),
    )

    assert draft["id"] == persisted["id"]
    assert persisted["externalSessionId"] == "hermes-session-1"
    assert persisted["externalChatId"] == "core-chat-1"


def test_core_session_summary_falls_back_to_runtime_session_id_without_chat_id():
    agent = {
        "id": "agent_default",
        "runtimeId": "runtime_local_hermes",
        "runtimeProfile": "default",
    }
    persisted = session_from_runtime_summary(
        agent,
        SessionSummary(
            id="legacy-hermes-session-1",
            source="iris",
            model="gpt-5.5",
            title="Legacy chat",
            preview="Hello",
            chatId=None,
            origin={},
            startedAt=10,
            endedAt=None,
            lastActiveAt=20,
            messageCount=2,
        ),
    )

    assert persisted["id"] == session_id_for_runtime(
        "runtime_local_hermes",
        "default",
        "legacy-hermes-session-1",
    )
    assert persisted["externalSessionId"] == "legacy-hermes-session-1"
    assert persisted["externalChatId"] == ""


def test_core_store_session_read_state_is_shared_by_session(tmp_path):
    store = CoreStore(tmp_path / "core.sqlite3")

    unread = store.upsert_session_read_state(
        "session_1",
        "unread",
        metadata={"eventCursor": 12},
    )
    read = store.upsert_session_read_state("session_1", "read")

    assert unread["sessionId"] == "session_1"
    assert unread["state"] == "unread"
    assert unread["metadata"]["eventCursor"] == 12
    assert read["state"] == "read"
    assert store.session_read_states(["session_1"])["session_1"]["state"] == "read"


def test_core_store_rejects_unbounded_session_read_state_queries(tmp_path):
    store = CoreStore(tmp_path / "core.sqlite3")

    with pytest.raises(ValueError, match="At most 500"):
        store.session_read_states([f"session_{index}" for index in range(501)])


def test_core_store_accepts_general_attachment_mime_types(tmp_path):
    store = CoreStore(tmp_path / "core.sqlite3")
    source = tmp_path / "song.mp3"
    content = b"ID3audio"
    source.write_bytes(content)

    attachment = store.create_attachment(
        source_path=source,
        runtime_id="runtime_local_hermes",
        profile="default",
        name="song.mp3",
        mime_type="audio/mpeg",
        kind="audio",
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
    )

    assert attachment["kind"] == "audio"
    assert attachment["mimeType"] == "audio/mpeg"
    assert attachment["previewUrl"] == ""
    assert is_allowed_attachment_mime("video/mp4")
    assert is_allowed_attachment_mime("application/zip")
    assert is_allowed_attachment_mime("application/octet-stream")


def test_client_message_metadata_overlay_drops_ambiguous_content_hashes(tmp_path):
    store = CoreStore(tmp_path / "core.sqlite3")
    runtime_id = "runtime_local_hermes"
    profile = "default"
    chat_id = "chat-1"
    duplicate_content = "write a short 3 paragraph story about AI automation"

    store.upsert_client_message_metadata(
        runtime_id=runtime_id,
        profile=profile,
        chat_id=chat_id,
        message_id="uuid-a",
        content=duplicate_content,
        metadata={"clientMessageId": "uuid-a", "clientContent": duplicate_content},
    )
    store.upsert_client_message_metadata(
        runtime_id=runtime_id,
        profile=profile,
        chat_id=chat_id,
        message_id="uuid-b",
        content=duplicate_content,
        metadata={"clientMessageId": "uuid-b", "clientContent": duplicate_content},
    )
    store.upsert_client_message_metadata(
        runtime_id=runtime_id,
        profile=profile,
        chat_id=chat_id,
        message_id="uuid-unique",
        content="another distinct prompt",
        metadata={"clientMessageId": "uuid-unique", "clientContent": "another distinct prompt"},
    )

    overlay = store.client_message_metadata_for_messages(
        runtime_id=runtime_id,
        profile=profile,
        chat_id=chat_id,
        messages=[
            {"id": "history-user-1", "role": "user", "content": duplicate_content},
            {"id": "history-user-2", "role": "user", "content": duplicate_content},
            {"id": "history-user-3", "role": "user", "content": "another distinct prompt"},
        ],
    )

    assert "uuid-a" in overlay["byMessageId"]
    assert "uuid-b" in overlay["byMessageId"]
    assert "uuid-unique" in overlay["byMessageId"]
    by_content_hash = overlay["byContentHash"]
    assert all(entry.get("clientMessageId") == "uuid-unique" for entry in by_content_hash.values())
    assert len(by_content_hash) == 1
