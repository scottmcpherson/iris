from __future__ import annotations

import json

from fastapi.testclient import TestClient

from hermes_management_server.main import Settings, create_app


def make_client(root):
    app = create_app(Settings(hermes_home=str(root), core_store_path=str(root.parent / "core.sqlite3")))
    return TestClient(app)


def create_session(client: TestClient) -> dict:
    agent = client.get("/v1/agents").json()["agents"][0]
    response = client.post("/v1/sessions", json={"agentId": agent["id"], "title": "Streaming E2E"})
    assert response.status_code == 200
    return response.json()["session"]


def post_delta(
    client: TestClient,
    session: dict,
    *,
    stream_id: str,
    client_request_id: str,
    content: str,
    finalize: bool = False,
    source: str = "hermes-gateway-stream",
    error: str = "",
):
    response = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": session["externalChatId"],
            "messageId": f"{stream_id}:edit:{content or 'terminal'}",
            "replyTo": client_request_id,
            "source": source,
            "content": content,
            "metadata": {
                "streamMessageId": stream_id,
                "clientRequestId": client_request_id,
                "chunkProtocol": "v2-delta",
                "streaming": not finalize,
                "finalize": finalize,
                **({"error": error} if error else {}),
            },
        },
    )
    assert response.status_code == 200
    return response.json()["event"]


def test_streaming_e2e_reconstructs_interleaved_delta_streams(tmp_path):
    client = make_client(tmp_path / ".hermes")
    session = create_session(client)
    cursor = client.get("/v1/events?after=0").json()["cursor"]

    left = [str(index) for index in range(100)]
    right = [f"x{index}" for index in range(100)]
    for left_delta, right_delta in zip(left, right):
        post_delta(
            client,
            session,
            stream_id="stream-left",
            client_request_id="client-left",
            content=left_delta,
        )
        post_delta(
            client,
            session,
            stream_id="stream-right",
            client_request_id="client-right",
            content=right_delta,
        )
    post_delta(client, session, stream_id="stream-left", client_request_id="client-left", content="", finalize=True)
    post_delta(client, session, stream_id="stream-right", client_request_id="client-right", content="", finalize=True)

    stream = client.get(f"/v1/events/stream?after={cursor}&limit=500&live=false")
    events = [
        json.loads(line.removeprefix("data: "))
        for line in stream.text.splitlines()
        if line.startswith("data: ")
    ]
    by_request: dict[str, list[str]] = {"client-left": [], "client-right": []}
    terminal: dict[str, str] = {}
    for event in events:
        request_id = event["metadata"]["clientRequestId"]
        if event["type"] == "message.assistant.delta":
            by_request[request_id].append(event["content"])
        if event["type"] == "message.assistant.completed":
            terminal[request_id] = event["metadata"]["streamMessageId"]

    assert "".join(by_request["client-left"]) == "".join(left)
    assert "".join(by_request["client-right"]) == "".join(right)
    assert terminal == {"client-left": "stream-left", "client-right": "stream-right"}


def test_streaming_e2e_emits_error_terminal_with_client_request_id(tmp_path):
    client = make_client(tmp_path / ".hermes")
    session = create_session(client)
    cursor = client.get("/v1/events?after=0").json()["cursor"]

    post_delta(client, session, stream_id="stream-error", client_request_id="client-error", content="partial")
    post_delta(
        client,
        session,
        stream_id="stream-error",
        client_request_id="client-error",
        content="",
        finalize=True,
        source="hermes-error",
        error="model stopped",
    )

    events = client.get(f"/v1/events?after={cursor}").json()["events"]

    assert [event["type"] for event in events] == ["message.assistant.delta", "message.assistant.error"]
    assert events[-1]["metadata"]["clientRequestId"] == "client-error"
    assert events[-1]["metadata"]["streamMessageId"] == "stream-error"
    assert events[-1]["content"] == "model stopped"


def test_streaming_e2e_handles_empty_stream_finalize(tmp_path):
    client = make_client(tmp_path / ".hermes")
    session = create_session(client)
    cursor = client.get("/v1/events?after=0").json()["cursor"]

    post_delta(client, session, stream_id="stream-empty", client_request_id="client-empty", content="", finalize=True)

    events = client.get(f"/v1/events?after={cursor}").json()["events"]

    assert len(events) == 1
    assert events[0]["type"] == "message.assistant.completed"
    assert events[0]["content"] == ""
    assert events[0]["metadata"]["clientRequestId"] == "client-empty"
    assert events[0]["metadata"]["streamMessageId"] == "stream-empty"


def test_streaming_e2e_replay_identical_content_keeps_distinct_client_request_ids(tmp_path):
    client = make_client(tmp_path / ".hermes")
    session = create_session(client)
    cursor = client.get("/v1/events?after=0").json()["cursor"]

    post_delta(client, session, stream_id="stream-first", client_request_id="client-first", content="same")
    post_delta(client, session, stream_id="stream-first", client_request_id="client-first", content="", finalize=True)
    post_delta(client, session, stream_id="stream-second", client_request_id="client-second", content="same")
    post_delta(client, session, stream_id="stream-second", client_request_id="client-second", content="", finalize=True)

    events = client.get(f"/v1/events?after={cursor}").json()["events"]
    completed = [event for event in events if event["type"] == "message.assistant.completed"]

    assert [event["metadata"]["clientRequestId"] for event in completed] == ["client-first", "client-second"]
    assert [event["metadata"]["streamMessageId"] for event in completed] == ["stream-first", "stream-second"]


def test_streaming_e2e_persists_event_bus_across_core_restart(tmp_path):
    root = tmp_path / ".hermes"
    first = make_client(root)
    session = create_session(first)
    event = post_delta(
        first,
        session,
        stream_id="stream-persisted",
        client_request_id="client-persisted",
        content="persisted",
        finalize=True,
    )

    restarted = make_client(root)
    replay = restarted.get("/v1/events?after=0").json()["events"]

    assert replay[-1]["id"] == event["id"]
    assert replay[-1]["content"] == "persisted"
    assert replay[-1]["metadata"]["clientRequestId"] == "client-persisted"
