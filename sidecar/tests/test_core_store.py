from __future__ import annotations

from hermes_management_server.core_store import CoreStore


def test_core_store_creates_schema_and_tracks_runtime_agent_conversation_events(tmp_path):
    store = CoreStore(tmp_path / "core.sqlite3")

    runtime = store.upsert_runtime(
        {
            "id": "runtime_local_hermes",
            "kind": "hermes",
            "name": "Local Hermes",
            "connection": {"gatewayUrl": "http://127.0.0.1:8642"},
        }
    )
    agents = store.sync_agents_from_profiles(runtime, [])

    assert store.health()["schemaVersion"] == 1
    assert store.list_runtimes()[0]["id"] == "runtime_local_hermes"
    assert agents == []


def test_core_store_appends_replayable_events_and_materializes_messages(tmp_path):
    store = CoreStore(tmp_path / "core.sqlite3")
    runtime = store.upsert_runtime(
        {
            "id": "runtime_local_hermes",
            "kind": "hermes",
            "name": "Local Hermes",
            "connection": {},
        }
    )
    agent = {
        "id": "agent_default",
        "runtimeId": runtime["id"],
        "runtimeKind": "hermes",
        "runtimeProfile": "default",
    }
    conversation = store.create_conversation(agent, title="Hello")

    first = store.append_event(
        conversation_id=conversation["id"],
        agent_id=agent["id"],
        runtime_id=runtime["id"],
        event_type="message.user.created",
        role="user",
        content="Hi",
        event_id="evt-hi",
    )
    duplicate = store.append_event(
        conversation_id=conversation["id"],
        agent_id=agent["id"],
        runtime_id=runtime["id"],
        event_type="message.user.created",
        role="user",
        content="Hi again",
        event_id="evt-hi",
    )
    store.upsert_message(
        conversation_id=conversation["id"],
        message_id="msg-hi",
        role="user",
        content="Hi",
        status="completed",
    )

    assert first["cursor"] == duplicate["cursor"]
    assert [event["id"] for event in store.list_events(after=first["cursor"] - 1)] == ["evt-hi"]
    assert store.list_messages(conversation["id"])[0]["content"] == "Hi"
