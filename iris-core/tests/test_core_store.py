from __future__ import annotations

import hashlib
import sqlite3

from hermes_management_server.core_store import CoreStore, is_allowed_attachment_mime


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

    assert store.health()["schemaVersion"] == 4
    assert store.health()["sourceOfTruthMigration"] == "complete"
    assert runtime["id"] == "runtime_local_hermes"
    assert set(store.tables()) == {
        "schema_meta",
        "devices",
        "runtimes",
        "device_cursors",
        "client_message_metadata",
        "attachments",
        "message_attachments",
    }


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
            create table conversations(id text primary key);
            create table conversation_runtime_links(conversation_id text primary key);
            create table message_events(cursor integer primary key autoincrement);
            create table conversation_messages(id text primary key);
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
        "client_message_metadata",
        "attachments",
        "message_attachments",
    }
    assert store.list_devices()[0]["id"] == "dev_1"
    assert store.list_runtimes()[0]["id"] == "runtime_local_hermes"


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
