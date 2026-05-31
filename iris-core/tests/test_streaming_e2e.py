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
    message_suffix: str = "",
) -> dict:
    response = client.post(
        "/v1/runtime-deliveries/hermes",
        json={
            "runtimeId": "runtime_local_hermes",
            "profile": "default",
            "chatId": session["externalChatId"],
            "messageId": f"{stream_id}:edit:{message_suffix or content or 'terminal'}",
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
    return response.json()


def read_events(client: TestClient, after: int) -> list[dict]:
    return client.get(f"/v1/events?after={after}&limit=500").json()["events"]


def test_streaming_e2e_assembles_full_snapshots_for_interleaved_streams(tmp_path):
    # Wire-format change (intended/breaking): Core is the single assembler, so
    # every event is a full content-so-far snapshot tagged for replace. The
    # client renders the highest-cursor snapshot per streamMessageId; the
    # concatenate-the-deltas assertion the old test used no longer applies.
    client = make_client(tmp_path / ".hermes")
    session = create_session(client)
    cursor = client.get("/v1/events?after=0").json()["cursor"]

    left = [str(index) for index in range(100)]
    right = [f"x{index}" for index in range(100)]
    for left_delta, right_delta in zip(left, right):
        post_delta(client, session, stream_id="stream-left", client_request_id="client-left", content=left_delta)
        post_delta(client, session, stream_id="stream-right", client_request_id="client-right", content=right_delta)
    post_delta(client, session, stream_id="stream-left", client_request_id="client-left", content="", finalize=True)
    post_delta(client, session, stream_id="stream-right", client_request_id="client-right", content="", finalize=True)

    stream = client.get(f"/v1/events/stream?after={cursor}&limit=500&live=false")
    events = [
        json.loads(line.removeprefix("data: "))
        for line in stream.text.splitlines()
        if line.startswith("data: ")
    ]

    latest_snapshot: dict[str, str] = {}
    completed: dict[str, str] = {}
    for event in events:
        stream_message_id = event["metadata"]["streamMessageId"]
        # Every event is a cumulative snapshot tagged for replace.
        assert event["metadata"]["chunkOperation"] == "replace"
        assert event["metadata"]["assembled"] is True
        previous = latest_snapshot.get(stream_message_id, "")
        assert event["content"].startswith(previous)  # snapshots only ever grow
        latest_snapshot[stream_message_id] = event["content"]
        if event["type"] == "message.assistant.completed":
            completed[event["metadata"]["clientRequestId"]] = event["content"]

    # Latest snapshot per stream — and the completed event — equal the full text.
    assert latest_snapshot["stream-left"] == "".join(left)
    assert latest_snapshot["stream-right"] == "".join(right)
    assert completed == {"client-left": "".join(left), "client-right": "".join(right)}


def test_streaming_e2e_completed_event_carries_full_text_not_empty(tmp_path):
    client = make_client(tmp_path / ".hermes")
    session = create_session(client)
    cursor = client.get("/v1/events?after=0").json()["cursor"]

    post_delta(client, session, stream_id="stream-full", client_request_id="client-full", content="Hello")
    post_delta(client, session, stream_id="stream-full", client_request_id="client-full", content=", world")
    final = post_delta(client, session, stream_id="stream-full", client_request_id="client-full", content="", finalize=True)

    assert final["suppressed"] is False
    assert final["event"]["type"] == "message.assistant.completed"
    # The terminal carries the entire message, fixing the empty-content finalize
    # truncation the client used to paper over.
    assert final["event"]["content"] == "Hello, world"

    events = read_events(client, cursor)
    completed = [event for event in events if event["type"] == "message.assistant.completed"]
    assert [event["content"] for event in completed] == ["Hello, world"]


def test_streaming_e2e_suppresses_redundant_streaming_delta(tmp_path):
    client = make_client(tmp_path / ".hermes")
    session = create_session(client)
    cursor = client.get("/v1/events?after=0").json()["cursor"]

    post_delta(client, session, stream_id="stream-dup", client_request_id="client-dup", content="Hello")
    # A no-op edit (empty delta / unchanged content) adds nothing to the snapshot.
    redundant = post_delta(
        client,
        session,
        stream_id="stream-dup",
        client_request_id="client-dup",
        content="",
        message_suffix="redundant",
    )
    assert redundant["suppressed"] is True
    assert redundant.get("event") is None

    events = read_events(client, cursor)
    deltas = [event for event in events if event["type"] == "message.assistant.delta"]
    assert [event["content"] for event in deltas] == ["Hello"]


def test_streaming_e2e_duplicate_finalize_after_completion_is_suppressed(tmp_path):
    # Restart-safe terminal guard (A2): once a stream finishes, a duplicate /
    # reordered / post-restart terminal is a no-op and never re-runs or
    # overwrites the finished message.
    client = make_client(tmp_path / ".hermes")
    session = create_session(client)
    cursor = client.get("/v1/events?after=0").json()["cursor"]

    post_delta(client, session, stream_id="stream-once", client_request_id="client-once", content="Answer")
    first_final = post_delta(
        client, session, stream_id="stream-once", client_request_id="client-once", content="", finalize=True
    )
    second_final = post_delta(
        client,
        session,
        stream_id="stream-once",
        client_request_id="client-once",
        content="",
        finalize=True,
        message_suffix="again",
    )

    assert first_final["suppressed"] is False
    assert second_final["suppressed"] is True

    events = read_events(client, cursor)
    completed = [event for event in events if event["type"] == "message.assistant.completed"]
    assert len(completed) == 1
    assert completed[0]["content"] == "Answer"


def test_streaming_e2e_rehydrates_accumulator_after_core_restart(tmp_path):
    # The accumulator is in-memory and lost on restart; the next delta must
    # resume from the last buffered snapshot rather than starting over.
    root = tmp_path / ".hermes"
    first = make_client(root)
    session = create_session(first)
    post_delta(first, session, stream_id="stream-resume", client_request_id="client-resume", content="Hello")
    post_delta(first, session, stream_id="stream-resume", client_request_id="client-resume", content=" world")

    restarted = make_client(root)
    final = post_delta(
        restarted,
        session,
        stream_id="stream-resume",
        client_request_id="client-resume",
        content="!",
        finalize=True,
    )

    assert final["suppressed"] is False
    assert final["event"]["content"] == "Hello world!"


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

    events = read_events(client, cursor)

    assert [event["type"] for event in events] == ["message.assistant.delta", "message.assistant.error"]
    assert events[0]["content"] == "partial"
    assert events[-1]["metadata"]["clientRequestId"] == "client-error"
    assert events[-1]["metadata"]["streamMessageId"] == "stream-error"
    assert events[-1]["content"] == "model stopped"


def test_streaming_e2e_handles_empty_stream_finalize(tmp_path):
    client = make_client(tmp_path / ".hermes")
    session = create_session(client)
    cursor = client.get("/v1/events?after=0").json()["cursor"]

    post_delta(client, session, stream_id="stream-empty", client_request_id="client-empty", content="", finalize=True)

    events = read_events(client, cursor)

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

    events = read_events(client, cursor)
    completed = [event for event in events if event["type"] == "message.assistant.completed"]

    assert [event["metadata"]["clientRequestId"] for event in completed] == ["client-first", "client-second"]
    assert [event["metadata"]["streamMessageId"] for event in completed] == ["stream-first", "stream-second"]
    assert [event["content"] for event in completed] == ["same", "same"]


def test_streaming_e2e_persists_event_bus_across_core_restart(tmp_path):
    root = tmp_path / ".hermes"
    first = make_client(root)
    session = create_session(first)
    final = post_delta(
        first,
        session,
        stream_id="stream-persisted",
        client_request_id="client-persisted",
        content="persisted",
        finalize=True,
    )
    event = final["event"]

    restarted = make_client(root)
    replay = restarted.get("/v1/events?after=0").json()["events"]

    assert replay[-1]["id"] == event["id"]
    assert replay[-1]["content"] == "persisted"
    assert replay[-1]["metadata"]["clientRequestId"] == "client-persisted"


def test_streaming_e2e_writes_assistant_overlay_at_finalize(tmp_path):
    # C1 -> C3 wiring: finalizing a stream stamps the streamed correlation identity
    # onto a persisted overlay so a later history read dedupes deterministically.
    client = make_client(tmp_path / ".hermes")
    session = create_session(client)
    post_delta(client, session, stream_id="stream-ov", client_request_id="client-ov", content="Answer")
    post_delta(client, session, stream_id="stream-ov", client_request_id="client-ov", content="", finalize=True)

    store = client.app.state.core_store
    overlay = store.assistant_message_metadata_for_messages(
        runtime_id="runtime_local_hermes",
        profile="default",
        chat_id=session["externalChatId"],
        messages=[{"id": "history-assistant", "role": "assistant", "content": "Answer"}],
    )
    buckets = list(overlay["byContentHash"].values())
    assert len(buckets) == 1
    assert buckets[0][0]["streamMessageId"] == "stream-ov"
    assert buckets[0][0]["clientRequestId"] == "client-ov"
    assert buckets[0][0]["replyTo"] == "client-ov"
