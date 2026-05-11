from __future__ import annotations

from hermes_management_server.message_coalescer import (
    append_delta_content,
    coalesce_core_messages,
    prepare_assistant_delivery_event,
)


def test_prepare_assistant_delivery_suppresses_stream_snapshot_after_completion():
    messages = [
        {
            "id": "stream-1",
            "role": "assistant",
            "content": "Final answer.",
            "status": "completed",
            "metadata": {"streamMessageId": "stream-1", "replyTo": "user-1"},
        },
    ]

    content, metadata, suppress = prepare_assistant_delivery_event(
        messages,
        content="Partial",
        metadata={"streamMessageId": "stream-1", "streaming": True},
        stream_message_id="stream-1",
        has_stream_id=True,
        reply_to="user-1",
        status="streaming",
    )

    assert content == "Final answer."
    assert metadata["streamMessageId"] == "stream-1"
    assert suppress is True


def test_prepare_assistant_delivery_finalizes_stream_without_explicit_stream_id():
    messages = [
        {"id": "user-1", "role": "user", "content": "Draft", "status": "completed", "metadata": {}},
        {
            "id": "stream-1",
            "role": "assistant",
            "content": "The answer starts",
            "status": "streaming",
            "metadata": {"streamMessageId": "stream-1", "streaming": True},
        },
    ]

    content, metadata, suppress = prepare_assistant_delivery_event(
        messages,
        content=" here.",
        metadata={"source": "hermes-gateway"},
        stream_message_id="",
        has_stream_id=False,
        reply_to="",
        status="completed",
    )

    assert content == "The answer starts here."
    assert metadata["streamMessageId"] == "stream-1"
    assert metadata["replyTo"] == "user-1"
    assert metadata["streaming"] is False
    assert metadata["finalize"] is True
    assert suppress is False


def test_append_delta_content_concatenates_many_deltas():
    deltas = [f"{index}," for index in range(1000)]
    content = ""

    for delta in deltas:
        content = append_delta_content(content, delta)

    assert content == "".join(deltas)


def test_append_delta_content_keeps_empty_terminal_delta_stable():
    assert append_delta_content("complete", "") == "complete"


def test_prepare_assistant_delivery_replaces_non_monotonic_stream_content():
    messages = [
        {
            "id": "stream-1",
            "role": "assistant",
            "content": "Hello world",
            "status": "streaming",
            "metadata": {"streamMessageId": "stream-1"},
        },
    ]

    content, metadata, suppress = prepare_assistant_delivery_event(
        messages,
        content="Goodbye",
        metadata={"streamMessageId": "stream-1", "chunkOperation": "replace"},
        stream_message_id="stream-1",
        has_stream_id=True,
        reply_to="user-1",
        status="streaming",
    )

    assert content == "Goodbye"
    assert metadata["streamMessageId"] == "stream-1"
    assert suppress is False


def test_coalesce_core_messages_preserves_non_gateway_duplicate_assistant_rows():
    messages = [
        {
            "id": "assistant-1",
            "role": "assistant",
            "content": "Same text",
            "status": "completed",
            "metadata": {"source": "manual-import"},
        },
        {
            "id": "assistant-2",
            "role": "assistant",
            "content": "Same text",
            "status": "completed",
            "metadata": {"source": "manual-import"},
        },
    ]

    assert [message["id"] for message in coalesce_core_messages(messages)] == ["assistant-1", "assistant-2"]


def test_coalesce_core_messages_refuses_divergent_gateway_rows(caplog):
    messages = [
        {
            "id": "stream-1",
            "role": "assistant",
            "content": "Hello world",
            "status": "streaming",
            "metadata": {"source": "hermes-gateway-stream", "streamMessageId": "stream-1", "clientRequestId": "user-1"},
        },
        {
            "id": "completed-1",
            "role": "assistant",
            "content": "Goodbye",
            "status": "completed",
            "metadata": {"source": "hermes-gateway", "replyTo": "user-1", "clientRequestId": "user-1"},
        },
    ]

    coalesced = coalesce_core_messages(messages)

    assert [message["id"] for message in coalesced] == ["stream-1", "completed-1"]
    assert "Refusing to coalesce divergent Hermes gateway assistant rows" in caplog.text
