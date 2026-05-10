from __future__ import annotations

from hermes_management_server.message_coalescer import (
    coalesce_core_messages,
    merged_completed_stream_content,
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
        content="The answer starts here.",
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


def test_merged_completed_stream_content_uses_text_overlap():
    assert (
        merged_completed_stream_content(
            "The first paragraph ends with an overlapping fragment",
            "overlapping fragment and then continues.",
        )
        == "The first paragraph ends with an overlapping fragment and then continues."
    )


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
