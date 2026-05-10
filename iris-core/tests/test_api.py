from __future__ import annotations

import json
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from hermes_management_server.main import LiveDeliveryBus, Settings, coalesce_core_messages, create_app
from hermes_management_server.runtime_adapters import hermes as hermes_adapter

PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR"
    b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"
    b"\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x01\x01\x01\x00\x18\xdd\x8d\xb0"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


def make_client(root):
    app = create_app(Settings(hermes_home=str(root), core_store_path=str(root.parent / "core.sqlite3")))
    return TestClient(app)


def agent_for_profile(client, profile):
    response = client.get("/v1/agents")
    assert response.status_code == 200
    for agent in response.json()["agents"]:
        if agent["runtimeProfile"] == profile:
            return agent
    raise AssertionError(f"Agent for profile {profile} was not found.")


def create_core_history_db(path, *, session_id, title, user_text, assistant_text, chat_id):
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.executescript(
        """
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
            message_id text primary key,
            session_id text not null,
            role text not null,
            content text,
            timestamp real not null
        );
        """
    )
    connection.execute(
        "insert into sessions (id, source, model, started_at, ended_at, message_count, title) values (?, ?, ?, ?, ?, ?, ?)",
        (session_id, "agentui", "gpt-5.5", 1000, 1010, 2, title),
    )
    connection.executemany(
        "insert into messages (message_id, session_id, role, content, timestamp) values (?, ?, ?, ?, ?)",
        [
            (f"{session_id}-user", session_id, "user", user_text, 1001),
            (f"{session_id}-assistant", session_id, "assistant", assistant_text, 1009),
        ],
    )
    sessions_dir = path.parent / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    (sessions_dir / "sessions.json").write_text(
        (
            f'{{"{session_id}":{{"session_id":"{session_id}",'
            f'"origin":{{"platform":"agentui","chat_id":"{chat_id}","user_id":"agentui-user"}}}}}}'
        ),
        encoding="utf-8",
    )
    connection.commit()
    connection.close()


def test_live_delivery_bus_assigns_unique_cursors_under_concurrent_publish():
    bus = LiveDeliveryBus(max_events=2000)

    def publish(index):
        return bus.publish({
            "sessionId": "session_1",
            "agentId": "agent_1",
            "content": f"message {index}",
        })

    with ThreadPoolExecutor(max_workers=16) as executor:
        events = list(executor.map(publish, range(300)))

    cursors = [event["cursor"] for event in events]
    assert len(cursors) == len(set(cursors))
    assert sorted(cursors) == list(range(1, 301))


def test_live_delivery_bus_deduplicates_event_ids_under_concurrent_publish():
    bus = LiveDeliveryBus(max_events=2000)

    with ThreadPoolExecutor(max_workers=16) as executor:
        events = list(executor.map(lambda _: bus.publish({"id": "evt_shared", "content": "same"}), range(100)))

    assert {event["cursor"] for event in events} == {1}
    assert [event["id"] for event in bus.list_events()] == ["evt_shared"]


def test_health_and_status(tmp_path):
    root = tmp_path / ".hermes"
    (root / "profiles" / "research").mkdir(parents=True)
    (root / "active_profile").write_text("research", encoding="utf-8")
    client = make_client(root)

    health = client.get("/health")
    status = client.get("/v1/status")

    assert health.status_code == 200
    assert health.json()["profilesRootExists"] is True
    assert status.status_code == 200
    assert status.json()["activeProfile"] == "research"
    assert status.json()["profileCount"] == 2


def test_core_cors_preflight_allows_idempotency_key(tmp_path):
    root = tmp_path / ".hermes"
    app = create_app(
        Settings(
            hermes_home=str(root),
            core_store_path=str(tmp_path / "core.sqlite3"),
            cors_origins=("tauri://localhost",),
        )
    )
    client = TestClient(app)

    response = client.options(
        "/v1/sessions/session_test/messages",
        headers={
            "Origin": "tauri://localhost",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,idempotency-key",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "tauri://localhost"
    assert "Idempotency-Key" in response.headers["access-control-allow-headers"]


def test_agent_memory_and_skills_endpoints(tmp_path):
    root = tmp_path / ".hermes"
    profile = root / "profiles" / "research"
    memories = profile / "memories"
    memories.mkdir(parents=True)
    (memories / "MEMORY.md").write_text("remember this", encoding="utf-8")
    (memories / "USER.md").write_text("user facts", encoding="utf-8")
    skill = profile / "skills" / "analysis" / "summarize" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("# Summarize\n\nCondense notes.", encoding="utf-8")
    client = make_client(root)
    agent = agent_for_profile(client, "research")
    agent_id = agent["id"]

    agent_response = client.get(f"/v1/agents/{agent_id}")
    memory_response = client.get(f"/v1/agents/{agent_id}/memory")
    skills_response = client.get(f"/v1/agents/{agent_id}/skills")
    skill_id = skills_response.json()["skills"][0]["id"]
    detail_response = client.get(f"/v1/agents/{agent_id}/skills/{skill_id}")

    assert agent_response.status_code == 200
    assert agent_response.json()["agent"]["metadata"]["skillCount"] == 1
    assert memory_response.status_code == 200
    assert memory_response.json()["memory"]["content"] == "remember this"
    assert memory_response.json()["user"]["content"] == "user facts"
    assert skills_response.status_code == 200
    assert skills_response.json()["skills"][0]["name"] == "Summarize"
    assert detail_response.status_code == 200
    assert detail_response.json()["content"] == "# Summarize\n\nCondense notes."


def test_agent_scoped_memory_skills_and_profile_actions(tmp_path):
    root = tmp_path / ".hermes"
    memories = root / "memories"
    memories.mkdir(parents=True)
    (memories / "MEMORY.md").write_text("default memory", encoding="utf-8")
    client = make_client(root)

    agents_response = client.get("/v1/agents")
    default_agent_id = agents_response.json()["agents"][0]["id"]

    memory_response = client.get(f"/v1/agents/{default_agent_id}/memory")
    save_memory_response = client.put(
        f"/v1/agents/{default_agent_id}/memory/memory",
        json={"content": "updated memory", "expectedUpdatedAt": memory_response.json()["memory"]["updatedAt"]},
    )
    create_skill_response = client.post(
        f"/v1/agents/{default_agent_id}/skills",
        json={"name": "Route Core", "category": "personal", "content": "# Route Core\n"},
    )
    skills_response = client.get(f"/v1/agents/{default_agent_id}/skills")
    skill_id = skills_response.json()["skills"][0]["id"]
    save_skill_response = client.put(
        f"/v1/agents/{default_agent_id}/skills/{skill_id}",
        json={"name": "Route Core", "category": "personal", "content": "# Route Core\n\nUpdated.\n"},
    )
    create_agent_response = client.post("/v1/agents", json={"name": "research"})
    clone_agent_response = client.post(
        f"/v1/agents/{default_agent_id}/clone",
        json={"name": "default-copy"},
    )
    activate_agent_response = client.post(f"/v1/agents/{create_agent_response.json()['agent']['id']}/activate")
    rename_agent_response = client.patch(
        f"/v1/agents/{create_agent_response.json()['agent']['id']}",
        json={"name": "research-renamed"},
    )

    assert save_memory_response.status_code == 200
    assert save_memory_response.json()["memory"]["memory"]["content"] == "updated memory"
    assert create_skill_response.status_code == 200
    assert save_skill_response.status_code == 200
    assert save_skill_response.json()["skill"]["content"] == "# Route Core\n\nUpdated.\n"
    assert create_agent_response.status_code == 200
    assert clone_agent_response.status_code == 200
    assert (root / "profiles" / "default-copy" / "memories" / "MEMORY.md").read_text(encoding="utf-8") == "updated memory"
    assert activate_agent_response.status_code == 200
    assert rename_agent_response.status_code == 200
    assert (root / "profiles" / "research-renamed").is_dir()
    assert (root / "active_profile").read_text(encoding="utf-8") == "research-renamed"
    delete_agent_response = client.delete(f"/v1/agents/{clone_agent_response.json()['agent']['id']}")
    assert delete_agent_response.status_code == 200
    assert not (root / "profiles" / "default-copy").exists()


def test_profile_summary_accepts_json_gateway_pid(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir(parents=True)
    (root / "gateway.pid").write_text(f'{{"pid": {os.getpid()}, "kind": "hermes-gateway"}}', encoding="utf-8")
    client = make_client(root)

    response = client.get("/v1/agents")

    assert response.status_code == 200
    assert response.json()["agents"][0]["metadata"]["gatewayRunning"] is True


def test_agent_management_endpoints_create_clone_delete(tmp_path):
    root = tmp_path / ".hermes"
    default_memories = root / "memories"
    default_memories.mkdir(parents=True)
    (default_memories / "MEMORY.md").write_text("default memory", encoding="utf-8")
    (root / "profiles" / "existing").mkdir(parents=True)
    client = make_client(root)
    default_agent_id = agent_for_profile(client, "default")["id"]

    create_response = client.post("/v1/agents", json={"name": "research"})
    clone_response = client.post(f"/v1/agents/{default_agent_id}/clone", json={"name": "default-copy"})

    assert create_response.status_code == 200
    assert create_response.json()["agent"]["runtimeProfile"] == "research"
    assert (root / "profiles" / "research" / "memories").is_dir()
    assert clone_response.status_code == 200
    assert clone_response.json()["agent"]["runtimeProfile"] == "default-copy"
    assert (root / "profiles" / "default-copy" / "memories" / "MEMORY.md").read_text(encoding="utf-8") == "default memory"
    assert not (root / "profiles" / "default-copy" / "profiles").exists()

    delete_response = client.delete(f"/v1/agents/{create_response.json()['agent']['id']}")
    default_delete_response = client.delete(f"/v1/agents/{default_agent_id}")

    assert delete_response.status_code == 200
    assert not (root / "profiles" / "research").exists()
    assert default_delete_response.status_code == 400
    assert "default profile cannot be deleted" in default_delete_response.json()["error"].lower()


def test_removed_profile_routes_return_structured_404(tmp_path):
    client = make_client(tmp_path / ".hermes")

    response = client.get("/v1/profiles/bad$name")

    assert response.status_code == 404
    assert response.json()["ok"] is False
    assert response.json()["error"] == "Not Found"


def test_inbox_accepts_lists_and_acknowledges_messages_without_sqlite(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    root = tmp_path / ".hermes"
    (root / "profiles" / "health").mkdir(parents=True)
    app = create_app(
        Settings(
            hermes_home=str(root),
            inbox_token="inbox-token",
            core_store_path=str(tmp_path / "core.sqlite3"),
        )
    )
    client = TestClient(app)

    health = client.get("/v1/inbox/health", headers={"Authorization": "Bearer inbox-token"})
    unauthorized = client.post("/v1/inbox/messages", json={"content": "hello"})
    created = client.post(
        "/v1/inbox/messages",
        headers={"Authorization": "Bearer inbox-token"},
        json={
            "source": "hermes-cron",
            "platform": "agentui",
            "profile": "health",
            "chatId": "desktop",
            "content": "test delivery",
            "metadata": {"jobId": "job-1"},
        },
    )
    client.post(
        "/v1/inbox/messages",
        headers={"Authorization": "Bearer inbox-token"},
        json={
            "source": "hermes-cron",
            "platform": "agentui",
            "profile": "default",
            "chatId": "desktop",
            "content": "default delivery",
        },
    )
    listed = client.get("/v1/inbox/messages?profile=health", headers={"Authorization": "Bearer inbox-token"})
    message_id = created.json()["message"]["id"]
    acknowledged = client.post(
        f"/v1/inbox/messages/{message_id}/ack",
        headers={"Authorization": "Bearer inbox-token"},
    )

    assert health.status_code == 200
    assert health.json()["storage"] == "memory"
    assert health.json()["path"] == ""
    assert unauthorized.status_code == 401
    assert created.status_code == 200
    assert created.json()["message"]["profile"] == "health"
    assert created.json()["message"]["content"] == "test delivery"
    assert listed.status_code == 200
    assert len(listed.json()["messages"]) == 1
    assert listed.json()["messages"][0]["metadata"]["jobId"] == "job-1"
    assert acknowledged.status_code == 200
    assert acknowledged.json()["message"]["acknowledgedAt"] is not None
    assert not (home / ".iris" / "inbox.sqlite3").exists()


def test_inbox_auth_accepts_configured_hermes_env_agentui_token(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir(parents=True)
    (root / ".env").write_text("AGENTUI_TOKEN=agentui-env-token\n", encoding="utf-8")
    app = create_app(
        Settings(
            hermes_home=str(root),
            core_store_path=str(tmp_path / "core.sqlite3"),
        )
    )
    client = TestClient(app)

    invalid = client.post(
        "/v1/inbox/messages",
        headers={"Authorization": "Bearer nope"},
        json={"content": "blocked"},
    )
    created = client.post(
        "/v1/inbox/messages",
        headers={"Authorization": "Bearer agentui-env-token"},
        json={"content": "accepted from platform token"},
    )

    assert invalid.status_code == 401
    assert created.status_code == 200
    assert created.json()["message"]["content"] == "accepted from platform token"


def test_inbox_preserves_stream_update_events_append_only(tmp_path):
    root = tmp_path / ".hermes"
    (root / "profiles" / "health").mkdir(parents=True)
    app = create_app(
        Settings(
            hermes_home=str(root),
            inbox_token="inbox-token",
            core_store_path=str(tmp_path / "core.sqlite3"),
        )
    )
    client = TestClient(app)
    headers = {"Authorization": "Bearer inbox-token"}

    first = client.post(
        "/v1/inbox/messages",
        headers=headers,
        json={
            "id": "stream-1",
            "source": "hermes-gateway-stream",
            "platform": "agentui",
            "profile": "health",
            "chatId": "desktop-health",
            "content": "Hel",
            "metadata": {
                "streamMessageId": "stream-1",
                "streaming": True,
                "finalize": False,
            },
        },
    )
    update = client.post(
        "/v1/inbox/messages",
        headers=headers,
        json={
            "id": "stream-1:edit:1",
            "source": "hermes-gateway-stream",
            "platform": "agentui",
            "profile": "health",
            "chatId": "desktop-health",
            "content": "Hello",
            "metadata": {
                "streamMessageId": "stream-1",
                "streaming": False,
                "finalize": True,
            },
        },
    )

    listed = client.get("/v1/inbox/messages?profile=health", headers=headers)
    messages = listed.json()["messages"]

    assert first.status_code == 200
    assert first.json()["message"]["id"] == "stream-1"
    assert update.status_code == 200
    assert listed.status_code == 200
    assert [message["id"] for message in messages] == ["stream-1", "stream-1:edit:1"]
    assert {message["metadata"]["streamMessageId"] for message in messages} == {"stream-1"}
    assert messages[-1]["metadata"]["finalize"] is True


def test_legacy_inbox_delivery_publishes_live_event_without_core_transcript(tmp_path):
    root = tmp_path / ".hermes"
    app = create_app(
        Settings(
            hermes_home=str(root),
            inbox_token="inbox-token",
            core_store_path=str(tmp_path / "core.sqlite3"),
        )
    )
    client = TestClient(app)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Legacy inbox delivery"},
    ).json()["session"]

    delivered = client.post(
        "/v1/inbox/messages",
        headers={"Authorization": "Bearer inbox-token"},
        json={
            "source": "hermes-cron",
            "platform": "agentui",
            "profile": "default",
            "chatId": session["externalChatId"],
            "content": "Legacy inbox delivery through Core",
            "metadata": {"jobId": "job-legacy"},
        },
    )
    events = client.get(f"/v1/sessions/{session['id']}/events?after=0")

    assert delivered.status_code == 200
    assert [event["type"] for event in events.json()["events"]] == ["message.assistant.completed"]
    assert events.json()["events"][0]["content"] == "Legacy inbox delivery through Core"
    assert events.json()["events"][0]["metadata"]["jobId"] == "job-legacy"
    assert "session_messages" not in client.app.state.core_store.tables()


def test_core_session_create_can_link_existing_runtime_chat(tmp_path):
    client = make_client(tmp_path / ".hermes")
    agent = client.get("/v1/agents").json()["agents"][0]

    created = client.post(
        "/v1/sessions",
        json={
            "agentId": agent["id"],
            "title": "Linked legacy chat",
            "externalChatId": "legacy-chat-1",
            "externalSessionId": "legacy-session-1",
            "metadata": {"createdBy": "desktop-legacy-link"},
        },
    )

    session = created.json()["session"]
    assert created.status_code == 200
    assert session["externalChatId"] == "legacy-chat-1"
    assert session["externalSessionId"] == "legacy-session-1"
    assert session["metadata"]["createdBy"] == "desktop-legacy-link"


def test_project_endpoints_create_link_and_archive_without_transcript_tables(tmp_path):
    client = make_client(tmp_path / ".hermes")
    agent = client.get("/v1/agents").json()["agents"][0]

    created_project = client.post(
        "/v1/projects",
        json={
            "name": "AgentUI",
            "defaultAgentId": agent["id"],
            "systemPrompt": "Prefer repo-local evidence.",
        },
    )
    project = created_project.json()["project"]
    created_session = client.post(
        "/v1/sessions",
        json={
            "title": "Project chat",
            "projectId": project["id"],
            "metadata": {"model": "gpt-test"},
        },
    )
    session = created_session.json()["session"]
    listed = client.get(f"/v1/projects/{project['id']}/sessions")
    updated = client.patch(
        f"/v1/projects/{project['id']}",
        json={
            "name": "Iris",
            "defaultAgentId": agent["id"],
            "systemPrompt": "Use the updated project brief.",
        },
    )
    archived = client.delete(f"/v1/projects/{project['id']}")

    assert created_project.status_code == 200
    assert project["slug"] == "agentui"
    assert created_session.status_code == 200
    assert session["agentId"] == agent["id"]
    assert session["metadata"]["project"]["id"] == project["id"]
    assert listed.status_code == 200
    assert listed.json()["sessions"][0]["id"] == session["id"]
    assert listed.json()["sessions"][0]["metadata"]["project"]["name"] == "AgentUI"
    assert updated.status_code == 200
    assert updated.json()["project"]["name"] == "Iris"
    assert updated.json()["project"]["defaultAgentId"] == agent["id"]
    assert updated.json()["project"]["systemPrompt"] == "Use the updated project brief."
    assert archived.status_code == 200
    assert "session_messages" not in client.app.state.core_store.tables()


def test_project_sessions_deduplicate_stale_draft_links_by_chat_id(tmp_path):
    root = tmp_path / ".hermes"
    create_core_history_db(
        root / "state.db",
        session_id="session-real",
        title="The Lantern on Briar Lane",
        user_text="write a short story",
        assistant_text="The lantern at the end of Briar Lane only lit when someone was lost.",
        chat_id="chat-1",
    )
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    project = client.post(
        "/v1/projects",
        json={"name": "Pirate", "defaultAgentId": agent["id"]},
    ).json()["project"]
    real_session = client.get(f"/v1/sessions?agentId={agent['id']}").json()["sessions"][0]

    with client.app.state.core_store.connect() as connection:
        connection.executemany(
            """
            insert into project_sessions(
              project_id, session_id, agent_id, runtime_id, runtime_profile,
              external_session_id, external_chat_id, created_at, updated_at, metadata_json
            ) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    project["id"],
                    "session_stale_draft",
                    agent["id"],
                    "runtime_local_hermes",
                    "default",
                    "",
                    "chat-1",
                    1,
                    1,
                    "{}",
                ),
                (
                    project["id"],
                    real_session["id"],
                    agent["id"],
                    real_session["runtimeId"],
                    real_session["runtimeProfile"],
                    real_session["externalSessionId"],
                    real_session["externalChatId"],
                    2,
                    2,
                    "{}",
                ),
            ],
        )

    listed = client.get(f"/v1/projects/{project['id']}/sessions")
    matches = [
        session
        for session in listed.json()["sessions"]
        if session["externalChatId"] == "chat-1"
    ]

    assert listed.status_code == 200
    assert [session["id"] for session in matches] == [real_session["id"]]


def test_core_session_delete_removes_sqlite_session_and_core_overlays(tmp_path):
    root = tmp_path / ".hermes"
    create_core_history_db(
        root / "state.db",
        session_id="delete-session",
        title="Delete me",
        user_text="remove this",
        assistant_text="gone",
        chat_id="delete-chat",
    )
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = next(
        item
        for item in client.get(f"/v1/sessions?agentId={agent['id']}").json()["sessions"]
        if item["externalSessionId"] == "delete-session"
    )
    project = client.post(
        "/v1/projects",
        json={"name": "Cleanup", "defaultAgentId": agent["id"]},
    ).json()["project"]
    client.post(f"/v1/projects/{project['id']}/sessions", json={"sessionId": session["id"]})
    client.patch(f"/v1/sessions/{session['id']}/read-state", json={"state": "unread"})

    deleted = client.delete(f"/v1/sessions/{session['id']}")
    listed = client.get(f"/v1/sessions?agentId={agent['id']}")
    detail = client.get(f"/v1/sessions/{session['id']}")

    assert deleted.status_code == 200
    assert listed.json()["sessions"] == []
    assert detail.status_code == 404
    with sqlite3.connect(root / "state.db") as connection:
        assert connection.execute("select count(*) from sessions").fetchone()[0] == 0
        assert connection.execute("select count(*) from messages").fetchone()[0] == 0
    assert client.app.state.core_store.project_session_link(project["id"], session["id"]) is None
    assert client.app.state.core_store.session_read_state(session["id"]) is None


def test_core_session_delete_removes_session_json_file_and_origin(tmp_path):
    root = tmp_path / ".hermes"
    sessions = root / "sessions"
    sessions.mkdir(parents=True)
    (sessions / "session_1.json").write_text(
        json.dumps(
            {
                "session_id": "file-delete-session",
                "source": "agentui",
                "title": "File delete",
                "session_start": "2026-05-03T10:00:00",
                "messages": [{"role": "user", "content": "delete file"}],
            }
        ),
        encoding="utf-8",
    )
    (sessions / "sessions.json").write_text(
        json.dumps(
            {
                "file-delete-session": {
                    "session_id": "file-delete-session",
                    "origin": {"platform": "agentui", "chat_id": "file-delete-chat"},
                }
            }
        ),
        encoding="utf-8",
    )
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.get(f"/v1/sessions?agentId={agent['id']}").json()["sessions"][0]

    deleted = client.delete(f"/v1/sessions/{session['id']}")

    assert deleted.status_code == 200
    assert not (sessions / "session_1.json").exists()
    assert json.loads((sessions / "sessions.json").read_text(encoding="utf-8")) == {}
    assert client.get(f"/v1/sessions?agentId={agent['id']}").json()["sessions"] == []


def test_session_read_state_is_shared_core_state(tmp_path):
    client = make_client(tmp_path / ".hermes")
    agent = client.get("/v1/agents").json()["agents"][0]
    project = client.post(
        "/v1/projects",
        json={"name": "Read State Project", "defaultAgentId": agent["id"]},
    ).json()["project"]
    created = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "projectId": project["id"], "title": "Read state"},
    )
    session = created.json()["session"]

    default_state = client.get(f"/v1/sessions/{session['id']}/read-state")
    unread = client.patch(
        f"/v1/sessions/{session['id']}/read-state",
        json={"state": "unread", "metadata": {"eventCursor": 7}},
    )
    listed = client.get(f"/v1/projects/{project['id']}/sessions")
    projectless_detail = client.get(f"/v1/sessions/{session['id']}")
    read = client.patch(
        f"/v1/sessions/{session['id']}/read-state",
        json={"state": "read"},
    )

    assert default_state.status_code == 200
    assert default_state.json()["readState"]["state"] == "read"
    assert unread.status_code == 200
    assert unread.json()["readState"]["state"] == "unread"
    assert unread.json()["readState"]["metadata"]["eventCursor"] == 7
    assert listed.json()["sessions"][0]["readState"]["state"] == "unread"
    assert projectless_detail.json()["session"]["readState"]["state"] == "unread"
    assert read.json()["readState"]["state"] == "read"


def test_legacy_inbox_stream_and_completed_replays_remain_live_only(tmp_path):
    root = tmp_path / ".hermes"
    app = create_app(
        Settings(
            hermes_home=str(root),
            inbox_token="inbox-token",
            core_store_path=str(tmp_path / "core.sqlite3"),
        )
    )
    client = TestClient(app)
    headers = {"Authorization": "Bearer inbox-token"}
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Gateway replay"},
    ).json()["session"]

    client.post(
        "/v1/inbox/messages",
        headers=headers,
        json={
            "id": "assistant-stream-1",
            "source": "hermes-gateway",
            "platform": "agentui",
            "profile": "default",
            "chatId": session["externalChatId"],
            "content": "Hi! What can I help you with today?",
            "metadata": {},
        },
    )
    client.post(
        "/v1/inbox/messages",
        headers=headers,
        json={
            "id": "assistant-stream-1:edit:1",
            "source": "hermes-gateway-stream",
            "platform": "agentui",
            "profile": "default",
            "chatId": session["externalChatId"],
            "content": "Hi! What can I help you with today?",
            "metadata": {"streamMessageId": "assistant-stream-1", "streaming": False, "finalize": True},
        },
    )
    client.post(
        "/v1/inbox/messages",
        headers=headers,
        json={
            "id": "assistant-stream-1:edit:2",
            "source": "hermes-gateway-stream",
            "platform": "agentui",
            "profile": "default",
            "chatId": session["externalChatId"],
            "content": "Hi! What can I help you with today?",
            "metadata": {"streamMessageId": "assistant-stream-1", "streaming": True, "finalize": False},
        },
    )
    client.post(
        "/v1/inbox/messages",
        headers=headers,
        json={
            "id": "assistant-completed-1",
            "source": "hermes-gateway",
            "platform": "agentui",
            "profile": "default",
            "chatId": session["externalChatId"],
            "content": "Hi! What can I help you with today?",
            "metadata": {"replyTo": "user-message-1"},
        },
    )
    client.post(
        "/v1/inbox/messages",
        headers=headers,
        json={
            "id": "assistant-completed-2",
            "source": "hermes-gateway",
            "platform": "agentui",
            "profile": "default",
            "chatId": session["externalChatId"],
            "content": "Hi! What can I help you with today?",
            "metadata": {"replyTo": "user-message-1"},
        },
    )

    events = client.get(f"/v1/sessions/{session['id']}/events?after=0").json()["events"]

    assert len([event for event in events if event["type"].startswith("message.assistant")]) == 5
    assert all(event["sessionId"] == session["id"] for event in events)
    assert client.get(f"/v1/sessions/{session['id']}/messages").json()["messages"] == []


def test_core_message_read_coalesces_existing_gateway_replay_rows():
    messages = [
        {
            "id": "user-1",
            "role": "user",
            "content": "Hi",
            "status": "completed",
            "metadata": {},
        },
        {
            "id": "stream-1",
            "role": "assistant",
            "content": "Hi! What can I help you with today?",
            "status": "streaming",
            "metadata": {"source": "hermes-gateway-stream", "streamMessageId": "stream-1"},
        },
        {
            "id": "completed-1",
            "role": "assistant",
            "content": "Hi! What can I help you with today?",
            "status": "completed",
            "metadata": {"source": "hermes-gateway", "replyTo": "user-1"},
        },
        {
            "id": "completed-2",
            "role": "assistant",
            "content": "Hi! What can I help you with today?",
            "status": "completed",
            "metadata": {"source": "hermes-gateway", "replyTo": "user-1"},
        },
    ]

    coalesced = coalesce_core_messages(messages)

    assert [message["id"] for message in coalesced] == ["user-1", "stream-1"]
    assert coalesced[1]["status"] == "completed"


def test_core_message_coalescing_merges_attachment_metadata():
    messages = [
        {
            "id": "stream-1",
            "role": "assistant",
            "content": "Done",
            "status": "streaming",
            "metadata": {"source": "hermes-gateway-stream", "streamMessageId": "stream-1"},
        },
        {
            "id": "completed-1",
            "role": "assistant",
            "content": "Done",
            "status": "completed",
            "metadata": {
                "source": "hermes-gateway",
                "replyTo": "user-1",
                "attachments": [
                    {
                        "id": "att_1",
                        "name": "image.png",
                        "kind": "image",
                        "mimeType": "image/png",
                        "size": 10,
                        "downloadUrl": "/v1/attachments/att_1/content",
                    }
                ],
            },
        },
    ]

    coalesced = coalesce_core_messages(messages)

    assert [message["id"] for message in coalesced] == ["stream-1"]
    assert coalesced[0]["status"] == "completed"
    assert coalesced[0]["metadata"]["attachments"][0]["id"] == "att_1"


def test_core_lists_runtimes_agents_and_backfilled_sessions(tmp_path):
    root = tmp_path / ".hermes"
    profile = root / "profiles" / "research"
    profile.mkdir(parents=True)
    client = make_client(root)

    runtimes = client.get("/v1/runtimes")
    agents = client.get("/v1/agents")
    agent = next(row for row in agents.json()["agents"] if row["runtimeProfile"] == "research")
    sessions = client.get(f"/v1/sessions?agentId={agent['id']}")

    assert runtimes.status_code == 200
    assert runtimes.json()["runtimes"][0]["id"] == "runtime_local_hermes"
    assert agents.status_code == 200
    assert agent["displayName"] == "research"
    assert sessions.status_code == 200
    assert sessions.json()["sessions"] == []


def test_core_runtime_delivery_is_live_replay_not_transcript_storage(tmp_path):
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    created = client.post("/v1/sessions", json={"agentId": agent["id"], "title": "Core chat"})
    session_id = created.json()["session"]["id"]

    delivery = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": created.json()["session"]["externalChatId"],
            "messageId": "assistant-stream-1",
            "replyTo": "client-message-1",
            "content": "Hello from Hermes",
            "metadata": {"streamMessageId": "assistant-stream-1", "streaming": False, "finalize": True},
        },
    )
    events = client.get("/v1/events?after=0&limit=10")

    assert created.status_code == 200
    assert delivery.status_code == 200
    assert delivery.json()["sessionId"] == session_id
    assert [event["type"] for event in events.json()["events"]] == ["message.assistant.completed"]
    assert events.json()["events"][0]["content"] == "Hello from Hermes"
    assert client.get(f"/v1/sessions/{session_id}/messages").json()["messages"] == []


def test_runtime_delivery_imports_generated_image_attachment(tmp_path):
    generated = tmp_path / "red_hue_relief.png"
    generated.write_bytes(PNG_BYTES)
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Generated image"},
    ).json()["session"]

    delivery = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": session["externalChatId"],
            "messageId": "assistant-image-1",
            "replyTo": "user-message-1",
            "content": f"Done\n\nMEDIA:{generated}",
            "metadata": {},
        },
    )
    event = client.get("/v1/events?after=0&limit=10").json()["events"][-1]
    attachment = event["metadata"]["attachments"][0]
    preview = client.get(attachment["previewUrl"])
    content = client.get(attachment["downloadUrl"])

    assert delivery.status_code == 200
    assert event["content"] == "Done"
    assert attachment["name"] == "red_hue_relief.png"
    assert attachment["kind"] == "image"
    assert attachment["mimeType"] == "image/png"
    assert attachment["downloadUrl"].startswith("/v1/attachments/att_")
    assert preview.status_code == 200
    assert preview.headers["content-type"].startswith("image/png")
    assert content.status_code == 200
    assert content.content == PNG_BYTES
    assert generated.exists()


def test_runtime_delivery_missing_generated_file_preserves_marker_with_warning(tmp_path):
    missing = tmp_path / "missing.png"
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Missing generated image"},
    ).json()["session"]

    delivery = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": session["externalChatId"],
            "messageId": "assistant-image-1",
            "replyTo": "user-message-1",
            "content": f"Done\n\nMEDIA:{missing}",
            "metadata": {},
        },
    )
    event = client.get("/v1/events?after=0&limit=10").json()["events"][-1]

    assert delivery.status_code == 200
    assert event["content"] == f"Done\n\nMEDIA:{missing}"
    assert "attachments" not in event["metadata"]
    assert event["metadata"]["generatedFileImportWarnings"][0]["path"] == str(missing)


def test_runtime_delivery_imports_non_image_without_preview_url(tmp_path):
    generated = tmp_path / "notes.txt"
    generated.write_text("hello from a generated file", encoding="utf-8")
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Generated doc"},
    ).json()["session"]

    client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": session["externalChatId"],
            "messageId": "assistant-file-1",
            "content": f"File: {generated}",
            "metadata": {},
        },
    )
    event = client.get("/v1/events?after=0&limit=10").json()["events"][-1]
    attachment = event["metadata"]["attachments"][0]
    preview = client.get(f"/v1/attachments/{attachment['id']}/preview")
    content = client.get(attachment["downloadUrl"])

    assert event["content"] == ""
    assert attachment["name"] == "notes.txt"
    assert attachment["kind"] == "code"
    assert attachment["previewUrl"] == ""
    assert preview.status_code == 415
    assert content.content == b"hello from a generated file"


def test_core_marks_late_model_switch_replies_hidden(tmp_path):
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    created = client.post("/v1/sessions", json={"agentId": agent["id"], "title": "Core chat"})
    session_id = created.json()["session"]["id"]

    delivery = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": created.json()["session"]["externalChatId"],
            "messageId": "model-switch-reply-1",
            "replyTo": "client-message-1-model",
            "content": "Model switched to `gpt-5.4-mini`",
            "metadata": {},
        },
    )
    event = client.get("/v1/events?after=0&limit=10").json()["events"][-1]

    assert delivery.status_code == 200
    assert event["metadata"]["hidden"] is True
    assert event["metadata"]["kind"] == "model-switch"
    assert client.get(f"/v1/sessions/{session_id}/messages").json()["messages"] == []


def test_core_backfills_hermes_sessions_and_fetches_messages(tmp_path):
    root = tmp_path / ".hermes"
    create_core_history_db(
        root / "state.db",
        session_id="default-session",
        title="Default history",
        user_text="Default question",
        assistant_text="Default answer",
        chat_id="default-chat",
    )
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]

    listed = client.get(f"/v1/sessions?agentId={agent['id']}")
    session = listed.json()["sessions"][0]
    messages = client.get(f"/v1/sessions/{session['id']}/messages")

    assert listed.status_code == 200
    assert session["title"] == "Default history"
    assert session["externalSessionId"] == "default-session"
    assert session["externalChatId"] == "default-chat"
    assert messages.status_code == 200
    assert [message["content"] for message in messages.json()["messages"]] == [
        "Default question",
        "Default answer",
    ]


def test_core_renames_hermes_session_title(tmp_path):
    root = tmp_path / ".hermes"
    create_core_history_db(
        root / "state.db",
        session_id="default-session",
        title="Default history",
        user_text="Default question",
        assistant_text="Default answer",
        chat_id="default-chat",
    )
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.get(f"/v1/sessions?agentId={agent['id']}").json()["sessions"][0]

    rename = client.patch(
        f"/v1/sessions/{session['id']}",
        json={"title": "Pinned planning"},
    )
    listed = client.get(f"/v1/sessions?agentId={agent['id']}")

    assert rename.status_code == 200
    assert rename.json()["session"]["title"] == "Pinned planning"
    assert listed.json()["sessions"][0]["title"] == "Pinned planning"


def test_core_merges_client_attachment_metadata_into_hermes_history(tmp_path):
    root = tmp_path / ".hermes"
    create_core_history_db(
        root / "state.db",
        session_id="default-session",
        title="Attachment history",
        user_text="Look at this\n\nAttached files:\n1. image.png (image/png, 12 KB)",
        assistant_text="ok",
        chat_id="default-chat",
    )
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.get(f"/v1/sessions?agentId={agent['id']}").json()["sessions"][0]

    client.app.state.core_store.upsert_client_message_metadata(
        runtime_id=agent["runtimeId"],
        profile=agent["runtimeProfile"],
        chat_id="default-chat",
        message_id="client-message-1",
        content="Look at this\n\nAttached files:\n1. image.png (image/png, 12 KB)",
        metadata={
            "attachments": [
                {
                    "id": "attachment-1",
                    "name": "image.png",
                    "kind": "image",
                    "mimeType": "image/png",
                    "size": 12_000,
                    "lastModified": 0,
                    "path": "/tmp/image.png",
                }
            ]
        },
    )

    messages = client.get(f"/v1/sessions/{session['id']}/messages")

    assert messages.status_code == 200
    user_message = messages.json()["messages"][0]
    assert user_message["content"] == "Look at this\n\nAttached files:\n1. image.png (image/png, 12 KB)"
    assert user_message["metadata"]["attachments"][0]["name"] == "image.png"


def test_core_prefers_client_audio_attachment_over_hermes_voice_placeholder(tmp_path):
    root = tmp_path / ".hermes"
    create_core_history_db(
        root / "state.db",
        session_id="default-session",
        title="[The user sent a voice message]",
        user_text='[The user sent a voice message. Here is the transcription: "0 p"]',
        assistant_text="Could you clarify?",
        chat_id="default-chat",
    )
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.get(f"/v1/sessions?agentId={agent['id']}").json()["sessions"][0]

    client.app.state.core_store.upsert_client_message_metadata(
        runtime_id=agent["runtimeId"],
        profile=agent["runtimeProfile"],
        chat_id="default-chat",
        message_id="client-voice-1",
        content="",
        metadata={
            "clientContent": "",
            "attachments": [
                {
                    "id": "att_voice_1",
                    "name": "dictation.webm",
                    "kind": "audio",
                    "mimeType": "audio/webm",
                    "size": 36_000,
                    "downloadUrl": "/v1/attachments/att_voice_1/content",
                }
            ],
        },
    )

    messages = client.get(f"/v1/sessions/{session['id']}/messages")

    assert messages.status_code == 200
    user_message = messages.json()["messages"][0]
    assert user_message["content"] == ""
    assert user_message["metadata"]["attachments"][0]["name"] == "dictation.webm"
    assert user_message["metadata"]["attachments"][0]["mimeType"] == "audio/webm"


def test_core_merges_assistant_attachment_metadata_into_hermes_history(tmp_path):
    generated = tmp_path / "history-image.png"
    generated.write_bytes(PNG_BYTES)
    root = tmp_path / ".hermes"
    create_core_history_db(
        root / "state.db",
        session_id="default-session",
        title="Assistant attachment history",
        user_text="Create an image",
        assistant_text=f"Done\n\nMEDIA:{generated}",
        chat_id="default-chat",
    )
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.get(f"/v1/sessions?agentId={agent['id']}").json()["sessions"][0]

    delivered = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": "default-chat",
            "messageId": "assistant-delivery-image",
            "content": f"Done\n\nMEDIA:{generated}",
            "metadata": {},
        },
    )
    messages = client.get(f"/v1/sessions/{session['id']}/messages")

    assert delivered.status_code == 200
    assistant_message = messages.json()["messages"][1]
    assert assistant_message["content"] == "Done"
    assert assistant_message["metadata"]["attachments"][0]["name"] == "history-image.png"
    assert assistant_message["metadata"]["attachments"][0]["kind"] == "image"


def test_core_imports_generated_pdf_marker_from_hermes_history(tmp_path):
    generated = tmp_path / "20260410_SUBSIDY_redacted.pdf"
    generated.write_bytes(b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n")
    root = tmp_path / ".hermes"
    create_core_history_db(
        root / "state.db",
        session_id="default-session",
        title="PDF attachment history",
        user_text="redact the addresses and names and give me a new pdf",
        assistant_text=f"Done - I created a new PDF:\n\nMEDIA:{generated}",
        chat_id="default-chat",
    )
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.get(f"/v1/sessions?agentId={agent['id']}").json()["sessions"][0]

    messages = client.get(f"/v1/sessions/{session['id']}/messages")
    assistant_message = messages.json()["messages"][1]
    attachment = assistant_message["metadata"]["attachments"][0]
    preview = client.get(attachment["previewUrl"] or f"/v1/attachments/{attachment['id']}/preview")
    content = client.get(attachment["downloadUrl"])

    assert messages.status_code == 200
    assert assistant_message["content"] == "Done - I created a new PDF:"
    assert attachment["name"] == "20260410_SUBSIDY_redacted.pdf"
    assert attachment["kind"] == "document"
    assert attachment["mimeType"] == "application/pdf"
    assert attachment["previewUrl"] == ""
    assert preview.status_code == 415
    assert content.status_code == 200
    assert content.content.startswith(b"%PDF-1.4")


def test_core_sessions_and_events_are_profile_isolated(tmp_path):
    root = tmp_path / ".hermes"
    (root / "profiles" / "health").mkdir(parents=True)
    client = make_client(root)
    agents = client.get("/v1/agents").json()["agents"]
    default_agent = next(agent for agent in agents if agent["runtimeProfile"] == "default")
    health_agent = next(agent for agent in agents if agent["runtimeProfile"] == "health")
    default_session = client.post(
        "/v1/sessions",
        json={"agentId": default_agent["id"], "title": "Default core"},
    ).json()["session"]

    health_delivery = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "health",
            "chatId": default_session["externalChatId"],
            "messageId": "health-delivery-1",
            "content": "Health-only answer",
            "metadata": {"streamMessageId": "health-delivery-1", "finalize": True},
        },
    )
    default_events = client.get(f"/v1/events?after=0&agentId={default_agent['id']}").json()["events"]
    health_events = client.get(f"/v1/events?after=0&agentId={health_agent['id']}").json()["events"]
    default_messages = client.get(f"/v1/sessions/{default_session['id']}/messages").json()["messages"]

    assert health_delivery.status_code == 200
    assert health_delivery.json()["sessionId"] != default_session["id"]
    assert default_events == []
    assert {event["agentId"] for event in health_events} == {health_agent["id"]}
    assert default_messages == []


def test_core_events_cursor_replay_and_sse_stream(tmp_path):
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "SSE core"},
    ).json()["session"]
    first_cursor = client.get("/v1/events?after=0").json()["cursor"]
    client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": session["externalChatId"],
            "messageId": "sse-delivery-1",
            "content": "SSE answer",
            "metadata": {"streamMessageId": "sse-delivery-1", "finalize": True},
        },
    )

    replay = client.get(f"/v1/events?after={first_cursor}")
    session_replay = client.get(f"/v1/sessions/{session['id']}/events?after={first_cursor}")
    stream = client.get(f"/v1/events/stream?after={first_cursor}&agentId={agent['id']}&live=false")
    read_state = client.get(f"/v1/sessions/{session['id']}/read-state")
    stream_text = stream.text

    assert [event["content"] for event in replay.json()["events"]] == ["SSE answer"]
    assert [event["content"] for event in session_replay.json()["events"]] == ["SSE answer"]
    assert read_state.json()["readState"]["state"] == "unread"
    assert stream.status_code == 200
    assert stream.headers["content-type"].startswith("text/event-stream")
    assert "event: message.assistant.completed" in stream_text
    assert "id: 1" in stream_text
    assert '"content":"SSE answer"' in stream_text


def test_core_runtime_deliveries_publish_stream_events_without_materializing(tmp_path):
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Materialized stream"},
    ).json()["session"]
    cursor = client.get("/v1/events?after=0").json()["cursor"]

    first = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": session["externalChatId"],
            "messageId": "stream-message-1",
            "replyTo": "user-message-1",
            "content": "Hel",
            "metadata": {"streamMessageId": "assistant-stream-1", "streaming": True, "finalize": False},
        },
    )
    final = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": session["externalChatId"],
            "messageId": "stream-message-1:edit:1",
            "replyTo": "user-message-1",
            "content": "Hello",
            "metadata": {"streamMessageId": "assistant-stream-1", "streaming": False, "finalize": True},
        },
    )
    media = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": session["externalChatId"],
            "messageId": "media-message-1",
            "replyTo": "user-message-1",
            "source": "hermes-gateway",
            "content": "File: /tmp/test.txt",
            "metadata": {},
        },
    )
    replay = client.get(f"/v1/events?after={cursor}")
    messages = client.get(f"/v1/sessions/{session['id']}/messages").json()["messages"]

    assert first.status_code == 200
    assert final.status_code == 200
    assert media.status_code == 200
    assert [event["type"] for event in replay.json()["events"]] == [
        "message.assistant.delta",
        "message.assistant.completed",
        "message.assistant.completed",
    ]
    assert messages == []


def test_core_automations_create_list_control_and_delete_hermes_jobs(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / ".env").write_text("API_SERVER_KEY=hermes-job-token\n", encoding="utf-8")
    seen = []
    jobs = [
        {
            "id": "external-job-existing",
            "name": "Existing reminder",
            "prompt": "Reply exactly: existing",
            "schedule_display": "once in 5m",
            "state": "scheduled",
            "deliver": "iris:desktop",
        }
    ]

    def fake_http_json(url, *, method, token, body=None):
        seen.append({"url": url, "method": method, "token": token, "body": body})
        if method == "GET":
            assert "include_disabled=true" in url
            return {
                "ok": True,
                "status": 200,
                "url": url,
                "json": {
                    "ok": True,
                    "jobs": jobs,
                },
            }
        if method == "POST" and url.endswith("/api/jobs"):
            jobs.append(
                {
                    "id": "external-job-created",
                    "name": body["name"],
                    "prompt": body["prompt"],
                    "schedule_display": f"once in {body['schedule']}",
                    "state": "scheduled",
                    "deliver": body.get("deliver"),
                    "repeat": {"times": body.get("repeat"), "completed": 0},
                }
            )
            return {
                "ok": True,
                "status": 200,
                "url": url,
                "json": {
                    "ok": True,
                    "job": jobs[-1],
                },
            }
        if method == "PATCH" and url.endswith("/api/jobs/external-job-created"):
            jobs[-1] = {
                **jobs[-1],
                "name": body.get("name", jobs[-1]["name"]),
                "prompt": body.get("prompt", jobs[-1]["prompt"]),
                "schedule_display": body.get("schedule", jobs[-1]["schedule_display"]),
                "repeat": {"times": body.get("repeat"), "completed": 0},
            }
            return {
                "ok": True,
                "status": 200,
                "url": url,
                "json": {
                    "ok": True,
                    "job": jobs[-1],
                },
            }
        return {"ok": True, "status": 200, "url": url, "json": {"ok": True}}

    monkeypatch.setattr(hermes_adapter, "http_json", fake_http_json)
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Automation delivery"},
    ).json()["session"]

    created = client.post(
        "/v1/automations",
        json={
            "agentId": agent["id"],
            "name": "Core reminder",
            "schedule": "10m",
            "prompt": "Reply exactly with this message: check the oven",
            "repeat": 1,
            "deliverToSessionId": session["id"],
        },
    )
    automation = created.json()["automation"]
    listed = client.get(f"/v1/automations?agentId={agent['id']}")
    updated = client.patch(
        f"/v1/automations/{automation['id']}",
        json={
            "name": "Morning standup",
            "schedule": "daily at 09:00",
            "prompt": "Send the morning standup note.",
            "repeat": None,
        },
    )
    paused = client.post(f"/v1/automations/{automation['id']}/pause")
    resumed = client.post(f"/v1/automations/{automation['id']}/resume")
    run = client.post(f"/v1/automations/{automation['id']}/run")
    deleted = client.delete(f"/v1/automations/{automation['id']}")

    assert created.status_code == 200
    assert automation["id"].startswith("auto_")
    assert automation["externalJobId"] == "external-job-created"
    assert automation["deliverToSessionId"] == session["id"]
    assert listed.status_code == 200
    assert {row["externalJobId"] for row in listed.json()["automations"]} >= {
        "external-job-created",
        "external-job-existing",
    }
    assert updated.status_code == 200
    assert updated.json()["automation"]["name"] == "Morning standup"
    assert paused.status_code == 200
    assert paused.json()["automation"]["status"] == "paused"
    assert resumed.status_code == 200
    assert resumed.json()["automation"]["status"] == "active"
    assert run.status_code == 200
    assert deleted.status_code == 200
    assert [request["token"] for request in seen] == ["hermes-job-token"] * len(seen)
    assert seen[0]["body"]["deliver"] == f"iris:{session['externalChatId']}"
    assert any(
        request["method"] == "PATCH"
        and request["body"]["repeat"] is None
        and request["body"]["schedule"] == "daily at 09:00"
        for request in seen
    )
    assert any(request["url"].endswith("/api/jobs/external-job-created/pause") for request in seen)
    assert any(request["url"].endswith("/api/jobs/external-job-created/resume") for request in seen)
    assert any(request["url"].endswith("/api/jobs/external-job-created/run") for request in seen)


def test_core_send_owns_chat_id_and_uses_env_file_token(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / ".env").write_text("AGENTUI_TOKEN=agentui-local-test\n", encoding="utf-8")
    seen = []

    def fake_http_json(url, *, method, token, body):
        seen.append({"url": url, "method": method, "token": token, "body": body})
        return {
            "ok": True,
            "status": 202,
            "url": url,
            "json": {
                "ok": True,
                "accepted": True,
                "profile": body["profile"],
                "chatId": body["chatId"],
                "messageId": body["messageId"],
            },
        }

    monkeypatch.setattr(hermes_adapter, "http_json", fake_http_json)
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Core send"},
    ).json()["session"]

    sent = client.post(
        f"/v1/sessions/{session['id']}/messages",
        json={
            "text": "Reply exactly: core phase 3",
            "clientMessageId": "client-message-1",
            "model": {"provider": "openai-codex", "model": "gpt-5.5"},
            "metadata": {
                "modelSwitch": {"provider": "openai-codex", "model": "gpt-5.5"},
            },
        },
    )
    refreshed = client.get(f"/v1/sessions/{session['id']}").json()["session"]

    assert sent.status_code == 200
    assert sent.json()["accepted"] is True
    assert refreshed["externalChatId"].startswith("core-")
    assert [request["token"] for request in seen] == ["agentui-local-test", "agentui-local-test"]
    assert [request["body"]["chatId"] for request in seen] == [refreshed["externalChatId"], refreshed["externalChatId"]]
    assert seen[0]["body"]["text"] == "/model gpt-5.5 --provider openai-codex"
    assert seen[0]["body"]["metadata"]["hidden"] is True
    assert seen[1]["body"]["text"] == "Reply exactly: core phase 3"
    assert seen[1]["body"]["metadata"]["agentuiSessionId"] == session["id"]
    assert client.get(f"/v1/sessions/{session['id']}/messages").json()["messages"] == []


def test_core_send_dedupes_replayed_client_message_ids(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / ".env").write_text("AGENTUI_TOKEN=agentui-local-test\n", encoding="utf-8")
    seen = []

    def fake_http_json(url, *, method, token, body):
        seen.append({"url": url, "method": method, "token": token, "body": body})
        return {
            "ok": True,
            "status": 202,
            "url": url,
            "json": {
                "ok": True,
                "accepted": True,
                "profile": body["profile"],
                "chatId": body["chatId"],
                "messageId": body["messageId"],
            },
        }

    monkeypatch.setattr(hermes_adapter, "http_json", fake_http_json)
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Core send"},
    ).json()["session"]
    payload = {
        "text": "Reply exactly once",
        "clientMessageId": "client-message-1",
        "model": {"provider": "openai-codex", "model": "gpt-5.5"},
    }

    first = client.post(f"/v1/sessions/{session['id']}/messages", json=payload)
    replay = client.post(f"/v1/sessions/{session['id']}/messages", json=payload)

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json()["duplicate"] is True
    assert len(seen) == 1


def test_core_send_dedupes_replayed_idempotency_header_without_client_message_id(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / ".env").write_text("AGENTUI_TOKEN=agentui-local-test\n", encoding="utf-8")
    seen = []

    def fake_http_json(url, *, method, token, body):
        seen.append({"url": url, "method": method, "token": token, "body": body})
        return {
            "ok": True,
            "status": 202,
            "url": url,
            "json": {
                "ok": True,
                "accepted": True,
                "profile": body["profile"],
                "chatId": body["chatId"],
                "messageId": body["messageId"],
            },
        }

    monkeypatch.setattr(hermes_adapter, "http_json", fake_http_json)
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Core send"},
    ).json()["session"]

    first = client.post(
        f"/v1/sessions/{session['id']}/messages",
        headers={"Idempotency-Key": "send-once-1"},
        json={"text": "Reply once from header key"},
    )
    replay = client.post(
        f"/v1/sessions/{session['id']}/messages",
        headers={"Idempotency-Key": "send-once-1"},
        json={"text": "Reply once from header key"},
    )

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json()["duplicate"] is True
    assert replay.json()["messageId"] == first.json()["messageId"]
    assert len(seen) == 1
    assert seen[0]["body"]["metadata"]["idempotencyKey"] == "send-once-1"


def test_core_send_retries_after_failed_runtime_send_with_same_idempotency_key(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / ".env").write_text("AGENTUI_TOKEN=agentui-local-test\n", encoding="utf-8")
    seen = []

    def fake_http_json(url, *, method, token, body):
        seen.append({"url": url, "method": method, "token": token, "body": body})
        if len(seen) == 1:
            return {
                "ok": True,
                "status": 202,
                "url": url,
                "json": {"ok": False, "error": "gateway unavailable"},
            }
        return {
            "ok": True,
            "status": 202,
            "url": url,
            "json": {
                "ok": True,
                "accepted": True,
                "profile": body["profile"],
                "chatId": body["chatId"],
                "messageId": body["messageId"],
            },
        }

    monkeypatch.setattr(hermes_adapter, "http_json", fake_http_json)
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Core send"},
    ).json()["session"]
    payload = {"text": "Try until accepted", "clientMessageId": "client-message-retry"}

    failed = client.post(f"/v1/sessions/{session['id']}/messages", json=payload)
    retry = client.post(f"/v1/sessions/{session['id']}/messages", json=payload)
    duplicate = client.post(f"/v1/sessions/{session['id']}/messages", json=payload)

    assert failed.status_code == 200
    assert failed.json()["accepted"] is False
    assert retry.status_code == 200
    assert retry.json()["accepted"] is True
    assert duplicate.status_code == 200
    assert duplicate.json()["duplicate"] is True
    assert len(seen) == 2


def test_core_send_persists_top_level_attachments_as_message_metadata(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    root.mkdir(parents=True)
    (root / ".env").write_text("AGENTUI_TOKEN=agentui-local-test\n", encoding="utf-8")
    seen: list[dict] = []

    def fake_http_multipart(url, *, method, token, payload, files):
        seen.append({"url": url, "method": method, "token": token, "payload": payload, "files": files})
        return {
            "ok": True,
            "json": {
                "ok": True,
                "accepted": True,
                "profile": payload["profile"],
                "chatId": payload["chatId"],
                "messageId": payload["messageId"],
            },
        }

    monkeypatch.setattr(hermes_adapter, "http_multipart", fake_http_multipart)
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Attachment send"},
    ).json()["session"]
    upload = client.post(
        "/v1/attachments",
        data={"profile": agent["runtimeProfile"], "runtimeId": agent["runtimeId"]},
        files={"file": ("report.pdf", b"%PDF-1.7\npdf-bytes", "application/pdf")},
    )
    attachment = upload.json()["attachment"]

    sent = client.post(
        f"/v1/sessions/{session['id']}/messages",
        json={
            "text": "Look at this",
            "attachments": [{"id": attachment["id"]}],
            "clientMessageId": "client-message-attachments",
        },
    )

    assert upload.status_code == 200
    assert sent.status_code == 200
    rows = client.app.state.core_store.client_message_metadata_for_messages(
        runtime_id=agent["runtimeId"],
        profile=agent["runtimeProfile"],
        chat_id=seen[0]["payload"]["chatId"],
        messages=[{"id": "client-message-attachments", "content": "Look at this"}],
    )
    persisted_attachment = rows["byMessageId"]["client-message-attachments"]["attachments"][0]
    payload_attachment = seen[0]["payload"]["attachments"][0]
    file_part = seen[0]["files"][0]
    assert persisted_attachment["id"] == attachment["id"]
    assert persisted_attachment["kind"] == "document"
    assert persisted_attachment["mimeType"] == "application/pdf"
    assert persisted_attachment["previewUrl"] == ""
    assert persisted_attachment["downloadUrl"] == f"/v1/attachments/{attachment['id']}/content"
    assert "runtime" not in persisted_attachment
    assert payload_attachment["id"] == attachment["id"]
    assert payload_attachment["field"] == "file_0"
    assert payload_attachment["kind"] == "document"
    assert payload_attachment["mimeType"] == "application/pdf"
    assert payload_attachment["size"] == len(b"%PDF-1.7\npdf-bytes")
    assert payload_attachment["sha256"] == attachment["sha256"]
    assert "path" not in payload_attachment
    assert "runtime" not in payload_attachment
    assert "attachments" not in seen[0]["payload"]["metadata"]
    assert seen[0]["payload"]["text"] == "Look at this"
    assert seen[0]["payload"]["attachments"] == [
        {
            "field": "file_0",
            "id": attachment["id"],
            "name": "report.pdf",
            "kind": "document",
            "mimeType": "application/pdf",
            "size": len(b"%PDF-1.7\npdf-bytes"),
            "sha256": attachment["sha256"],
        }
    ]
    assert file_part["field"] == "file_0"
    assert file_part["name"] == "report.pdf"
    assert file_part["mimeType"] == "application/pdf"
    assert file_part["path"].endswith(attachment["sha256"])


def test_core_send_passes_existing_runtime_session_id_for_legacy_followup(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    root.mkdir(parents=True)
    (root / ".env").write_text("AGENTUI_TOKEN=agentui-local-test\n", encoding="utf-8")
    connection = sqlite3.connect(root / "state.db")
    connection.executescript(
        """
        create table sessions (
            id text primary key,
            source text not null,
            model text,
            started_at real not null,
            message_count integer default 0,
            title text
        );

        create table messages (
            message_id text primary key,
            session_id text not null,
            role text not null,
            content text,
            timestamp real not null
        );
        """
    )
    connection.execute(
        "insert into sessions (id, source, model, started_at, message_count, title) values (?, ?, ?, ?, ?, ?)",
        ("legacy-session-1", "agentui", "gpt-5.5", 1000, 2, "Legacy session without chat id"),
    )
    connection.execute(
        "insert into messages (message_id, session_id, role, content, timestamp) values (?, ?, ?, ?, ?)",
        ("legacy-message-1", "legacy-session-1", "user", "Original prompt", 1001),
    )
    connection.commit()
    connection.close()
    seen: list[dict] = []

    def fake_http_json(url, *, method, token, body):
        seen.append({"url": url, "method": method, "token": token, "body": body})
        return {
            "ok": True,
            "status": 202,
            "url": url,
            "json": {
                "ok": True,
                "accepted": True,
                "profile": body["profile"],
                "chatId": body["chatId"],
                "messageId": body["messageId"],
            },
        }

    monkeypatch.setattr(hermes_adapter, "http_json", fake_http_json)
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    sessions = client.get(f"/v1/sessions?agentId={agent['id']}").json()["sessions"]
    session = next(item for item in sessions if item["externalSessionId"] == "legacy-session-1")

    sent = client.post(
        f"/v1/sessions/{session['id']}/messages",
        json={"text": "Continue this exact session", "clientMessageId": "followup-1"},
    )

    assert session["externalChatId"] == ""
    assert sent.status_code == 200
    assert seen[0]["body"]["chatId"].startswith("core-")
    assert seen[0]["body"]["sessionId"] == "legacy-session-1"


def test_runtime_attachment_resolve_endpoint_is_removed(tmp_path):
    client = make_client(tmp_path / ".hermes")

    response = client.post(
        "/v1/runtime/attachments/resolve",
        json={"runtimeId": "runtime_local_hermes", "profile": "default", "attachments": []},
    )

    assert response.status_code == 404


def test_core_upload_accepts_universal_attachment_kinds_and_content(tmp_path):
    client = make_client(tmp_path / ".hermes")
    cases = [
        ("report.pdf", b"%PDF-1.7\npdf-bytes", "application/pdf", "document"),
        ("song.mp3", b"ID3\x04\x00\x00audio-bytes", "audio/mpeg", "audio"),
        ("clip.mp4", b"\x00\x00\x00\x18ftypmp42video-bytes", "video/mp4", "video"),
        ("files.zip", b"PK\x03\x04zip-bytes", "application/zip", "archive"),
        ("blob.bin", b"\x00\x01\x02binary", "application/octet-stream", "file"),
    ]

    for filename, content, mime_type, kind in cases:
        upload = client.post(
            "/v1/attachments",
            data={"profile": "default", "runtimeId": "runtime_local_hermes"},
            files={"file": (filename, content, mime_type)},
        )

        assert upload.status_code == 200
        attachment = upload.json()["attachment"]
        assert attachment["kind"] == kind
        assert attachment["mimeType"] == mime_type
        assert attachment["size"] == len(content)
        assert attachment["downloadUrl"] == f"/v1/attachments/{attachment['id']}/content"
        assert attachment["previewUrl"] == ""

        preview = client.get(f"/v1/attachments/{attachment['id']}/preview")
        download = client.get(f"/v1/attachments/{attachment['id']}/content")

        assert preview.status_code == 415
        assert download.status_code == 200
        assert download.content == content
        assert download.headers["content-type"].split(";")[0] == mime_type


def test_core_upload_rejects_empty_and_oversized_files_with_limit(tmp_path, monkeypatch):
    client = make_client(tmp_path / ".hermes")

    empty = client.post(
        "/v1/attachments",
        data={"profile": "default"},
        files={"file": ("empty.txt", b"", "text/plain")},
    )
    monkeypatch.setenv("IRIS_MAX_ATTACHMENT_SIZE_MB", "1")
    oversized = client.post(
        "/v1/attachments",
        data={"profile": "default"},
        files={"file": ("large.bin", b"x" * (1024 * 1024 + 1), "application/octet-stream")},
    )

    assert empty.status_code == 400
    assert empty.json()["error"] == "Attachment file is empty."
    assert oversized.status_code == 413
    assert oversized.json()["error"] == "Attachment exceeds the 1 MB limit."


def test_core_send_rejects_invalid_attachment_references_before_runtime_send(tmp_path, monkeypatch):
    client = make_client(tmp_path / ".hermes")
    agent = client.get("/v1/agents").json()["agents"][0]
    session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Attachment validation"},
    ).json()["session"]
    seen = []

    def fake_http_json(url, *, method, token, body):
        seen.append({"url": url, "method": method, "token": token, "body": body})
        return {"ok": True, "status": 202, "url": url, "json": {"ok": True}}

    monkeypatch.setattr(hermes_adapter, "http_json", fake_http_json)

    missing_id = client.post(
        f"/v1/sessions/{session['id']}/messages",
        json={"text": "Bad attachment", "attachments": [{"id": ""}]},
    )
    too_many = client.post(
        f"/v1/sessions/{session['id']}/messages",
        json={
            "text": "Too many attachments",
            "attachments": [{"id": f"att_missing_{index}"} for index in range(9)],
        },
    )

    assert missing_id.status_code == 400
    assert missing_id.json()["error"] == "Attachment id is required."
    assert too_many.status_code == 400
    assert too_many.json()["error"] == "Messages may include at most 8 attachments."
    assert seen == []


def test_core_send_rejects_attachment_bound_to_different_session(tmp_path, monkeypatch):
    client = make_client(tmp_path / ".hermes")
    agent = client.get("/v1/agents").json()["agents"][0]
    first_session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "First attachment owner"},
    ).json()["session"]
    second_session = client.post(
        "/v1/sessions",
        json={"agentId": agent["id"], "title": "Second attachment owner"},
    ).json()["session"]
    upload = client.post(
        "/v1/attachments",
        data={
            "profile": agent["runtimeProfile"],
            "runtimeId": agent["runtimeId"],
            "sessionId": first_session["id"],
        },
        files={"file": ("report.pdf", b"%PDF-1.7\npdf-bytes", "application/pdf")},
    )
    seen = []

    def fake_http_json(url, *, method, token, body):
        seen.append({"url": url, "method": method, "token": token, "body": body})
        return {"ok": True, "status": 202, "url": url, "json": {"ok": True}}

    monkeypatch.setattr(hermes_adapter, "http_json", fake_http_json)

    sent = client.post(
        f"/v1/sessions/{second_session['id']}/messages",
        json={
            "text": "Use an attachment from another session",
            "attachments": [{"id": upload.json()["attachment"]["id"]}],
        },
    )

    assert upload.status_code == 200
    assert sent.status_code == 400
    assert sent.json()["error"] == "Attachment belongs to a different session."
    assert seen == []


def test_core_rejects_unknown_agent_filters(tmp_path):
    client = make_client(tmp_path / ".hermes")

    sessions = client.get("/v1/sessions?agentId=agent_missing")
    events = client.get("/v1/events?agentId=agent_missing")
    stream = client.get("/v1/events/stream?agentId=agent_missing")

    assert sessions.status_code == 404
    assert sessions.json()["error"] == "Agent was not found."
    assert events.status_code == 404
    assert stream.status_code == 404
