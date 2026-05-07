from __future__ import annotations

import os
import sqlite3

from fastapi.testclient import TestClient

from hermes_management_server.main import Settings, coalesce_core_messages, create_app
from hermes_management_server.runtime_adapters import hermes as hermes_adapter


def make_client(root):
    app = create_app(Settings(hermes_home=str(root), core_store_path=str(root.parent / "core.sqlite3")))
    return TestClient(app)


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
        "/v1/conversations/conv_test/messages",
        headers={
            "Origin": "tauri://localhost",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,idempotency-key",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "tauri://localhost"
    assert "Idempotency-Key" in response.headers["access-control-allow-headers"]


def test_profile_memory_and_skills_endpoints(tmp_path):
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

    profile_response = client.get("/v1/profiles/research")
    memory_response = client.get("/v1/profiles/research/memory")
    skills_response = client.get("/v1/profiles/research/skills")
    skill_id = skills_response.json()["skills"][0]["id"]
    detail_response = client.get(f"/v1/profiles/research/skills/{skill_id}")

    assert profile_response.status_code == 200
    assert profile_response.json()["skillCount"] == 1
    assert memory_response.status_code == 200
    assert memory_response.json()["memory"]["content"] == "remember this"
    assert memory_response.json()["user"]["content"] == "user facts"
    assert skills_response.status_code == 200
    assert skills_response.json()["skills"][0]["name"] == "Summarize"
    assert detail_response.status_code == 200
    assert detail_response.json()["content"] == "# Summarize\n\nCondense notes."


def test_profile_summary_accepts_json_gateway_pid(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir(parents=True)
    (root / "gateway.pid").write_text(f'{{"pid": {os.getpid()}, "kind": "hermes-gateway"}}', encoding="utf-8")
    client = make_client(root)

    response = client.get("/v1/profiles")

    assert response.status_code == 200
    assert response.json()["profiles"][0]["gatewayRunning"] is True


def test_profile_management_endpoints_create_clone_delete(tmp_path):
    root = tmp_path / ".hermes"
    default_memories = root / "memories"
    default_memories.mkdir(parents=True)
    (default_memories / "MEMORY.md").write_text("default memory", encoding="utf-8")
    (root / "profiles" / "existing").mkdir(parents=True)
    client = make_client(root)

    create_response = client.post("/v1/profiles", json={"name": "research"})
    clone_response = client.post("/v1/profiles/default/clone", json={"name": "default-copy"})

    assert create_response.status_code == 200
    assert create_response.json()["profile"] == "research"
    assert (root / "profiles" / "research" / "memories").is_dir()
    assert clone_response.status_code == 200
    assert clone_response.json()["profile"] == "default-copy"
    assert (root / "profiles" / "default-copy" / "memories" / "MEMORY.md").read_text(encoding="utf-8") == "default memory"
    assert not (root / "profiles" / "default-copy" / "profiles").exists()

    delete_response = client.delete("/v1/profiles/research")
    default_delete_response = client.delete("/v1/profiles/default")

    assert delete_response.status_code == 200
    assert not (root / "profiles" / "research").exists()
    assert default_delete_response.status_code == 400
    assert "default profile cannot be deleted" in default_delete_response.json()["error"].lower()


def test_api_returns_structured_error_for_bad_profile(tmp_path):
    client = make_client(tmp_path / ".hermes")

    response = client.get("/v1/profiles/bad$name")

    assert response.status_code == 400
    assert response.json()["ok"] is False
    assert "Profile names" in response.json()["error"]


def test_inbox_accepts_lists_and_acknowledges_messages(tmp_path):
    root = tmp_path / ".hermes"
    inbox_path = tmp_path / "agentui-inbox.sqlite3"
    app = create_app(
        Settings(
            hermes_home=str(root),
            inbox_store_path=str(inbox_path),
            inbox_token="inbox-token",
            core_store_path=str(tmp_path / "core.sqlite3"),
        )
    )
    client = TestClient(app)

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

    assert unauthorized.status_code == 401
    assert created.status_code == 200
    assert created.json()["message"]["profile"] == "health"
    assert created.json()["message"]["content"] == "test delivery"
    assert listed.status_code == 200
    assert len(listed.json()["messages"]) == 1
    assert listed.json()["messages"][0]["metadata"]["jobId"] == "job-1"
    assert acknowledged.status_code == 200
    assert acknowledged.json()["message"]["acknowledgedAt"] is not None


def test_inbox_auth_accepts_configured_hermes_env_agentui_token(tmp_path):
    root = tmp_path / ".hermes"
    root.mkdir(parents=True)
    (root / ".env").write_text("AGENTUI_TOKEN=agentui-env-token\n", encoding="utf-8")
    app = create_app(
        Settings(
            hermes_home=str(root),
            inbox_store_path=str(tmp_path / "agentui-inbox.sqlite3"),
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
    inbox_path = tmp_path / "agentui-inbox.sqlite3"
    app = create_app(
        Settings(
            hermes_home=str(root),
            inbox_store_path=str(inbox_path),
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


def test_legacy_inbox_delivery_mirrors_to_core_conversation(tmp_path):
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
    conversation = client.post(
        "/v1/conversations",
        json={"agentId": agent["id"], "title": "Legacy inbox delivery"},
    ).json()["conversation"]

    delivered = client.post(
        "/v1/inbox/messages",
        headers={"Authorization": "Bearer inbox-token"},
        json={
            "source": "hermes-cron",
            "platform": "agentui",
            "profile": "default",
            "chatId": conversation["externalChatId"],
            "content": "Legacy inbox delivery through Core",
            "metadata": {"jobId": "job-legacy"},
        },
    )
    messages = client.get(f"/v1/conversations/{conversation['id']}/messages")
    events = client.get(f"/v1/conversations/{conversation['id']}/events?after=0")

    assert delivered.status_code == 200
    assert messages.json()["messages"][0]["content"] == "Legacy inbox delivery through Core"
    assert messages.json()["messages"][0]["metadata"]["jobId"] == "job-legacy"
    assert [event["type"] for event in events.json()["events"]] == [
        "conversation.created",
        "message.assistant.completed",
    ]


def test_core_conversation_create_can_link_existing_runtime_chat(tmp_path):
    client = make_client(tmp_path / ".hermes")
    agent = client.get("/v1/agents").json()["agents"][0]

    created = client.post(
        "/v1/conversations",
        json={
            "agentId": agent["id"],
            "title": "Linked legacy chat",
            "externalChatId": "legacy-chat-1",
            "externalSessionId": "legacy-session-1",
            "metadata": {"createdBy": "desktop-legacy-link"},
        },
    )

    conversation = created.json()["conversation"]
    assert created.status_code == 200
    assert conversation["externalChatId"] == "legacy-chat-1"
    assert conversation["externalSessionId"] == "legacy-session-1"
    assert conversation["metadata"]["createdBy"] == "desktop-legacy-link"


def test_legacy_inbox_stream_and_completed_replays_coalesce_in_core(tmp_path):
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
    conversation = client.post(
        "/v1/conversations",
        json={"agentId": agent["id"], "title": "Gateway replay"},
    ).json()["conversation"]

    client.post(
        "/v1/inbox/messages",
        headers=headers,
        json={
            "id": "assistant-stream-1",
            "source": "hermes-gateway",
            "platform": "agentui",
            "profile": "default",
            "chatId": conversation["externalChatId"],
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
            "chatId": conversation["externalChatId"],
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
            "chatId": conversation["externalChatId"],
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
            "chatId": conversation["externalChatId"],
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
            "chatId": conversation["externalChatId"],
            "content": "Hi! What can I help you with today?",
            "metadata": {"replyTo": "user-message-1"},
        },
    )

    messages = client.get(f"/v1/conversations/{conversation['id']}/messages").json()["messages"]
    events = client.get(f"/v1/conversations/{conversation['id']}/events?after=0").json()["events"]

    assert len([event for event in events if event["type"].startswith("message.assistant")]) == 1
    assert len(messages) == 1
    assert messages[0]["id"] == "assistant-stream-1"
    assert messages[0]["status"] == "completed"
    assert messages[0]["content"] == "Hi! What can I help you with today?"


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


def test_core_lists_runtimes_agents_and_backfilled_conversations(tmp_path):
    root = tmp_path / ".hermes"
    profile = root / "profiles" / "research"
    profile.mkdir(parents=True)
    client = make_client(root)

    runtimes = client.get("/v1/runtimes")
    agents = client.get("/v1/agents")
    agent = next(row for row in agents.json()["agents"] if row["runtimeProfile"] == "research")
    conversations = client.get(f"/v1/conversations?agentId={agent['id']}")

    assert runtimes.status_code == 200
    assert runtimes.json()["runtimes"][0]["id"] == "runtime_local_hermes"
    assert agents.status_code == 200
    assert agent["displayName"] == "research"
    assert conversations.status_code == 200
    assert conversations.json()["conversations"] == []


def test_core_message_events_and_runtime_delivery_are_replayable(tmp_path):
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    created = client.post("/v1/conversations", json={"agentId": agent["id"], "title": "Core chat"})
    conversation_id = created.json()["conversation"]["id"]

    delivery = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": created.json()["conversation"]["externalChatId"],
            "messageId": "assistant-stream-1",
            "replyTo": "client-message-1",
            "content": "Hello from Hermes",
            "metadata": {"streamMessageId": "assistant-stream-1", "streaming": False, "finalize": True},
        },
    )
    events = client.get("/v1/events?after=0&limit=10")
    messages = client.get(f"/v1/conversations/{conversation_id}/messages")

    assert created.status_code == 200
    assert delivery.status_code == 200
    assert delivery.json()["conversationId"] == conversation_id
    assert [event["type"] for event in events.json()["events"]] == [
        "conversation.created",
        "message.assistant.completed",
    ]
    assert messages.json()["messages"][0]["content"] == "Hello from Hermes"


def test_core_marks_late_model_switch_replies_hidden(tmp_path):
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    created = client.post("/v1/conversations", json={"agentId": agent["id"], "title": "Core chat"})
    conversation_id = created.json()["conversation"]["id"]

    delivery = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": created.json()["conversation"]["externalChatId"],
            "messageId": "model-switch-reply-1",
            "replyTo": "client-message-1-model",
            "content": "Model switched to `gpt-5.4-mini`",
            "metadata": {},
        },
    )
    event = client.get("/v1/events?after=0&limit=10").json()["events"][-1]
    message = client.get(f"/v1/conversations/{conversation_id}/messages").json()["messages"][0]

    assert delivery.status_code == 200
    assert event["metadata"]["hidden"] is True
    assert event["metadata"]["kind"] == "model-switch"
    assert message["metadata"]["hidden"] is True
    assert message["metadata"]["kind"] == "model-switch"


def test_core_backfills_hermes_conversations_and_fetches_messages(tmp_path):
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

    listed = client.get(f"/v1/conversations?agentId={agent['id']}")
    conversation = listed.json()["conversations"][0]
    messages = client.get(f"/v1/conversations/{conversation['id']}/messages")

    assert listed.status_code == 200
    assert conversation["title"] == "Default history"
    assert conversation["externalSessionId"] == "default-session"
    assert conversation["externalChatId"] == "default-chat"
    assert messages.status_code == 200
    assert [message["content"] for message in messages.json()["messages"]] == [
        "Default question",
        "Default answer",
    ]


def test_core_conversations_and_events_are_profile_isolated(tmp_path):
    root = tmp_path / ".hermes"
    (root / "profiles" / "health").mkdir(parents=True)
    client = make_client(root)
    agents = client.get("/v1/agents").json()["agents"]
    default_agent = next(agent for agent in agents if agent["runtimeProfile"] == "default")
    health_agent = next(agent for agent in agents if agent["runtimeProfile"] == "health")
    default_conversation = client.post(
        "/v1/conversations",
        json={"agentId": default_agent["id"], "title": "Default core"},
    ).json()["conversation"]

    health_delivery = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "health",
            "chatId": default_conversation["externalChatId"],
            "messageId": "health-delivery-1",
            "content": "Health-only answer",
            "metadata": {"streamMessageId": "health-delivery-1", "finalize": True},
        },
    )
    default_conversations = client.get(f"/v1/conversations?agentId={default_agent['id']}").json()["conversations"]
    health_conversations = client.get(f"/v1/conversations?agentId={health_agent['id']}").json()["conversations"]
    default_events = client.get(f"/v1/events?after=0&agentId={default_agent['id']}").json()["events"]
    health_events = client.get(f"/v1/events?after=0&agentId={health_agent['id']}").json()["events"]
    default_messages = client.get(f"/v1/conversations/{default_conversation['id']}/messages").json()["messages"]

    assert health_delivery.status_code == 200
    assert health_delivery.json()["conversationId"] != default_conversation["id"]
    assert [conversation["runtimeProfile"] for conversation in default_conversations] == ["default"]
    assert [conversation["runtimeProfile"] for conversation in health_conversations] == ["health"]
    assert {event["agentId"] for event in default_events} == {default_agent["id"]}
    assert {event["agentId"] for event in health_events} == {health_agent["id"]}
    assert default_messages == []


def test_core_events_cursor_replay_and_sse_stream(tmp_path):
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    conversation = client.post(
        "/v1/conversations",
        json={"agentId": agent["id"], "title": "SSE core"},
    ).json()["conversation"]
    first_cursor = client.get("/v1/events?after=0").json()["cursor"]
    client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": conversation["externalChatId"],
            "messageId": "sse-delivery-1",
            "content": "SSE answer",
            "metadata": {"streamMessageId": "sse-delivery-1", "finalize": True},
        },
    )

    replay = client.get(f"/v1/events?after={first_cursor}")
    conversation_replay = client.get(f"/v1/conversations/{conversation['id']}/events?after={first_cursor}")
    stream = client.get(f"/v1/events/stream?after={first_cursor}&agentId={agent['id']}&live=false")
    stream_text = stream.text

    assert [event["content"] for event in replay.json()["events"]] == ["SSE answer"]
    assert [event["content"] for event in conversation_replay.json()["events"]] == ["SSE answer"]
    assert stream.status_code == 200
    assert stream.headers["content-type"].startswith("text/event-stream")
    assert "event: message.assistant.completed" in stream_text
    assert "id: 2" in stream_text
    assert '"content":"SSE answer"' in stream_text


def test_core_runtime_deliveries_materialize_stream_without_duplicates(tmp_path):
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    conversation = client.post(
        "/v1/conversations",
        json={"agentId": agent["id"], "title": "Materialized stream"},
    ).json()["conversation"]
    cursor = client.get("/v1/events?after=0").json()["cursor"]

    first = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": conversation["externalChatId"],
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
            "chatId": conversation["externalChatId"],
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
            "chatId": conversation["externalChatId"],
            "messageId": "media-message-1",
            "replyTo": "user-message-1",
            "source": "hermes-gateway",
            "content": "File: /tmp/test.txt",
            "metadata": {},
        },
    )
    replay = client.get(f"/v1/events?after={cursor}")
    messages = client.get(f"/v1/conversations/{conversation['id']}/messages").json()["messages"]

    assert first.status_code == 200
    assert final.status_code == 200
    assert media.status_code == 200
    assert [event["type"] for event in replay.json()["events"]] == [
        "message.assistant.delta",
        "message.assistant.completed",
        "message.assistant.completed",
    ]
    assert len(messages) == 1
    assert messages[0]["id"] == "assistant-stream-1"
    assert messages[0]["status"] == "completed"
    assert messages[0]["content"] == "Hello\n\nFile: /tmp/test.txt"


def test_core_runtime_delivery_fallback_finalizes_existing_stream(tmp_path):
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    conversation = client.post(
        "/v1/conversations",
        json={"agentId": agent["id"], "title": "Fallback stream"},
    ).json()["conversation"]
    client.app.state.core_store.upsert_message(
        conversation_id=conversation["id"],
        message_id="user-message-1",
        role="user",
        content="Write a story",
        status="completed",
        metadata={},
    )
    cursor = client.get("/v1/events?after=0").json()["cursor"]

    first = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": conversation["externalChatId"],
            "messageId": "stream-message-1",
            "content": "The rain began.",
            "metadata": {"streamMessageId": "assistant-stream-1", "streaming": True, "finalize": False},
        },
    )
    fallback = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": conversation["externalChatId"],
            "messageId": "fallback-message-1",
            "source": "hermes-gateway",
            "content": "Inside, the observatory smelled of dust.",
            "metadata": {},
        },
    )
    replay = client.get(f"/v1/events?after={cursor}").json()["events"]
    messages = client.get(f"/v1/conversations/{conversation['id']}/messages").json()["messages"]

    assert first.status_code == 200
    assert fallback.status_code == 200
    assert replay[-1]["type"] == "message.assistant.completed"
    assert replay[-1]["metadata"]["streamMessageId"] == "assistant-stream-1"
    assert replay[-1]["metadata"]["streaming"] is False
    assert replay[-1]["metadata"]["finalize"] is True
    assert replay[-1]["metadata"]["replyTo"] == "user-message-1"
    assert replay[-1]["content"] == "The rain began.\n\nInside, the observatory smelled of dust."
    assistant = next(message for message in messages if message["id"] == "assistant-stream-1")
    assert {message["id"] for message in messages} == {"user-message-1", "assistant-stream-1"}
    assert assistant["status"] == "completed"
    assert assistant["metadata"]["streaming"] is False
    assert assistant["metadata"]["finalize"] is True


def test_core_runtime_delivery_ignores_shorter_stream_replay_before_fallback(tmp_path):
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    conversation = client.post(
        "/v1/conversations",
        json={"agentId": agent["id"], "title": "Regressive stream"},
    ).json()["conversation"]
    client.app.state.core_store.upsert_message(
        conversation_id=conversation["id"],
        message_id="user-message-1",
        role="user",
        content="Write a story",
        status="completed",
        metadata={},
    )
    full_content = "The sign read: KEEP STREAMING. The light stayed green."

    client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": conversation["externalChatId"],
            "messageId": "stream-message-1",
            "content": full_content,
            "metadata": {"streamMessageId": "assistant-stream-1", "streaming": True, "finalize": False},
        },
    )
    shorter = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": conversation["externalChatId"],
            "messageId": "stream-message-1:edit:1",
            "content": "The sign read",
            "metadata": {"streamMessageId": "assistant-stream-1", "streaming": True, "finalize": False},
        },
    )
    fallback = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": conversation["externalChatId"],
            "messageId": "fallback-message-1",
            "source": "hermes-gateway",
            "content": ": KEEP STREAMING. The light stayed green.",
            "metadata": {},
        },
    )
    replay = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": conversation["externalChatId"],
            "messageId": "fallback-message-2",
            "replyTo": "user-message-1",
            "source": "hermes-gateway",
            "content": full_content,
            "metadata": {},
        },
    )
    messages = client.get(f"/v1/conversations/{conversation['id']}/messages").json()["messages"]

    assert fallback.status_code == 200
    assert shorter.status_code == 200
    assert shorter.json()["event"] is None
    assert shorter.json()["suppressed"] is True
    assert fallback.json()["event"]["content"] == full_content
    assert fallback.json()["event"]["metadata"]["streaming"] is False
    assert replay.status_code == 200
    assert replay.json()["event"] is None
    assert replay.json()["suppressed"] is True
    assistant_messages = [message for message in messages if message["role"] == "assistant"]
    assert len(assistant_messages) == 1
    assert assistant_messages[0]["content"] == full_content
    assert assistant_messages[0]["status"] == "completed"


def test_core_runtime_delivery_merges_overlapping_fallback_tail(tmp_path):
    root = tmp_path / ".hermes"
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    conversation = client.post(
        "/v1/conversations",
        json={"agentId": agent["id"], "title": "Overlapping tail"},
    ).json()["conversation"]
    client.app.state.core_store.upsert_message(
        conversation_id=conversation["id"],
        message_id="user-message-1",
        role="user",
        content="Write a story",
        status="completed",
        metadata={},
    )
    visible_content = (
        "Verification starts now, she said, uploading the logs live. "
        "By morning, the blackout was no longer a rumor"
    )
    final_content = (
        "Verification starts now, she said, uploading the logs live. "
        "By morning, the blackout was no longer a rumor, and the proof survived."
    )

    client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": conversation["externalChatId"],
            "messageId": "stream-message-1",
            "content": visible_content,
            "metadata": {"streamMessageId": "assistant-stream-1", "streaming": True, "finalize": False},
        },
    )
    fallback = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": conversation["externalChatId"],
            "messageId": "fallback-message-1",
            "source": "hermes-gateway",
            "content": "she said, uploading the logs live. By morning, the blackout was no longer a rumor, and the proof survived.",
            "metadata": {},
        },
    )
    messages = client.get(f"/v1/conversations/{conversation['id']}/messages").json()["messages"]

    assert fallback.status_code == 200
    assert fallback.json()["event"]["content"] == final_content
    assistant = next(message for message in messages if message["role"] == "assistant")
    assert assistant["content"] == final_content


def test_core_automations_create_list_control_and_delete_hermes_jobs(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / ".env").write_text("API_SERVER_KEY=hermes-job-token\n", encoding="utf-8")
    seen = []

    def fake_http_json(url, *, method, token, body=None):
        seen.append({"url": url, "method": method, "token": token, "body": body})
        if method == "GET":
            return {
                "ok": True,
                "status": 200,
                "url": url,
                "json": {
                    "ok": True,
                    "jobs": [
                        {
                            "id": "external-job-existing",
                            "name": "Existing reminder",
                            "prompt": "Reply exactly: existing",
                            "schedule_display": "once in 5m",
                            "state": "scheduled",
                            "deliver": "agentui:desktop",
                        }
                    ],
                },
            }
        if method == "POST" and url.endswith("/api/jobs"):
            return {
                "ok": True,
                "status": 200,
                "url": url,
                "json": {
                    "ok": True,
                    "job": {
                        "id": "external-job-created",
                        "name": body["name"],
                        "prompt": body["prompt"],
                        "schedule_display": f"once in {body['schedule']}",
                        "state": "scheduled",
                        "deliver": body.get("deliver"),
                        "repeat": {"times": body.get("repeat"), "completed": 0},
                    },
                },
            }
        return {"ok": True, "status": 200, "url": url, "json": {"ok": True}}

    monkeypatch.setattr(hermes_adapter, "http_json", fake_http_json)
    client = make_client(root)
    agent = client.get("/v1/agents").json()["agents"][0]
    conversation = client.post(
        "/v1/conversations",
        json={"agentId": agent["id"], "title": "Automation delivery"},
    ).json()["conversation"]

    created = client.post(
        "/v1/automations",
        json={
            "agentId": agent["id"],
            "name": "Core reminder",
            "schedule": "10m",
            "prompt": "Reply exactly with this message: check the oven",
            "repeat": 1,
            "deliverToConversationId": conversation["id"],
        },
    )
    automation = created.json()["automation"]
    listed = client.get(f"/v1/automations?agentId={agent['id']}")
    paused = client.post(f"/v1/automations/{automation['id']}/pause")
    resumed = client.post(f"/v1/automations/{automation['id']}/resume")
    run = client.post(f"/v1/automations/{automation['id']}/run")
    deleted = client.delete(f"/v1/automations/{automation['id']}")

    assert created.status_code == 200
    assert automation["id"].startswith("auto_")
    assert automation["externalJobId"] == "external-job-created"
    assert automation["deliverToConversationId"] == conversation["id"]
    assert listed.status_code == 200
    assert {row["externalJobId"] for row in listed.json()["automations"]} >= {
        "external-job-created",
        "external-job-existing",
    }
    assert paused.status_code == 200
    assert paused.json()["automation"]["status"] == "paused"
    assert resumed.status_code == 200
    assert resumed.json()["automation"]["status"] == "active"
    assert run.status_code == 200
    assert deleted.status_code == 200
    assert [request["token"] for request in seen] == ["hermes-job-token"] * len(seen)
    assert seen[0]["body"]["deliver"] == f"agentui:{conversation['externalChatId']}"
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
    conversation = client.post(
        "/v1/conversations",
        json={"agentId": agent["id"], "title": "Core send"},
    ).json()["conversation"]

    sent = client.post(
        f"/v1/conversations/{conversation['id']}/messages",
        json={
            "text": "Reply exactly: core phase 3",
            "clientMessageId": "client-message-1",
            "model": {"provider": "openai-codex", "model": "gpt-5.5"},
            "metadata": {
                "modelSwitch": {"provider": "openai-codex", "model": "gpt-5.5"},
            },
        },
    )
    refreshed = client.get(f"/v1/conversations/{conversation['id']}").json()["conversation"]
    messages = client.get(f"/v1/conversations/{conversation['id']}/messages").json()["messages"]

    assert sent.status_code == 200
    assert sent.json()["accepted"] is True
    assert refreshed["externalChatId"].startswith("core-conv_")
    assert [request["token"] for request in seen] == ["agentui-local-test", "agentui-local-test"]
    assert [request["body"]["chatId"] for request in seen] == [refreshed["externalChatId"], refreshed["externalChatId"]]
    assert seen[0]["body"]["text"] == "/model gpt-5.5 --provider openai-codex"
    assert seen[0]["body"]["metadata"]["hidden"] is True
    assert seen[1]["body"]["text"] == "Reply exactly: core phase 3"
    assert seen[1]["body"]["metadata"]["agentuiConversationId"] == conversation["id"]
    assert messages[0]["content"] == "Reply exactly: core phase 3"


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
    conversation = client.post(
        "/v1/conversations",
        json={"agentId": agent["id"], "title": "Core send"},
    ).json()["conversation"]
    payload = {
        "text": "Reply exactly once",
        "clientMessageId": "client-message-1",
        "model": {"provider": "openai-codex", "model": "gpt-5.5"},
    }

    first = client.post(f"/v1/conversations/{conversation['id']}/messages", json=payload)
    replay = client.post(f"/v1/conversations/{conversation['id']}/messages", json=payload)

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json()["duplicate"] is True
    assert len(seen) == 1


def test_core_rejects_unknown_agent_filters(tmp_path):
    client = make_client(tmp_path / ".hermes")

    conversations = client.get("/v1/conversations?agentId=agent_missing")
    events = client.get("/v1/events?agentId=agent_missing")
    stream = client.get("/v1/events/stream?agentId=agent_missing")

    assert conversations.status_code == 404
    assert conversations.json()["error"] == "Agent was not found."
    assert events.status_code == 404
    assert stream.status_code == 404
