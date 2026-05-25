"""Message coalescing helpers for Iris Core delivery and transcript reads."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def merge_client_attachments(existing: Any, additions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in list(existing if isinstance(existing, list) else []) + additions:
        if not isinstance(item, dict):
            continue
        key = str(item.get("id") or item.get("sha256") or item.get("downloadUrl") or "")
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        merged.append(item)
    return merged


def prepare_assistant_delivery_event(
    messages: list[dict[str, Any]],
    *,
    content: str,
    metadata: dict[str, Any],
    stream_message_id: str,
    has_stream_id: bool,
    reply_to: str,
    status: str,
) -> tuple[str, dict[str, Any], bool]:
    if has_stream_id:
        existing = message_by_id(messages, stream_message_id)
        if not existing:
            return content, metadata, False
        existing_content = str(existing.get("content") or "")
        existing_status = str(existing.get("status") or "")
        if existing_status == "completed" and status == "streaming":
            return existing_content, metadata, True
        operation = chunk_operation(metadata)
        if status == "streaming":
            merged = apply_stream_content(existing_content, content, operation)
            return merged, metadata, same_normalized_content(merged, existing_content)
        merged = apply_stream_content(existing_content, content, operation)
        merged_metadata = merged_completion_metadata(existing, metadata, reply_to=reply_to)
        if existing_status == "completed" and same_normalized_content(merged, existing_content):
            return existing_content, merged_metadata, True
        return merged, merged_metadata, False

    if status != "completed":
        return content, metadata, False

    fallback = stream_fallback_completion(messages, reply_to=reply_to, content=content)
    if fallback:
        logger.warning("Assistant delivery without streamMessageId entered legacy stream fallback path.")
        return (
            str(fallback["content"]),
            finalized_stream_metadata(
                metadata,
                existing_metadata=fallback["metadata"],
                stream_message_id=str(fallback["streamMessageId"]),
                reply_to=reply_to or str(fallback.get("replyTo") or ""),
            ),
            False,
        )

    existing = last_mergeable_assistant_message(messages, reply_to=reply_to)
    if not existing:
        return content, metadata, False
    existing_content = str(existing.get("content") or "")
    merged = append_delta_content(existing_content, content)
    merged_metadata = merged_completion_metadata(existing, metadata, reply_to=reply_to)
    if str(existing.get("status") or "") == "completed" and same_normalized_content(merged, existing_content):
        return existing_content, merged_metadata, True
    return merged, merged_metadata, False


def has_stream_message_id(metadata: dict[str, Any]) -> bool:
    return bool(metadata.get("streamMessageId") or metadata.get("stream_message_id"))


def stream_fallback_completion(
    messages: list[dict[str, Any]],
    *,
    reply_to: str,
    content: str,
) -> dict[str, Any] | None:
    existing = None
    metadata: dict[str, Any] = {}
    stream_message_id = ""
    for message in reversed(messages):
        if message.get("role") != "assistant" or message.get("status") != "streaming":
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        stream_message_id = str(metadata.get("streamMessageId") or metadata.get("stream_message_id") or "")
        if stream_message_id:
            existing = message
            break
    if not existing or not stream_message_id:
        return None
    inferred_reply_to = reply_to or str(metadata.get("replyTo") or "") or last_user_message_id(messages)
    return {
        "content": append_delta_content(str(existing.get("content") or ""), content),
        "messageId": str(existing.get("id") or stream_message_id),
        "metadata": metadata,
        "replyTo": inferred_reply_to,
        "streamMessageId": stream_message_id,
    }


def finalized_stream_metadata(
    metadata: dict[str, Any],
    *,
    existing_metadata: dict[str, Any],
    stream_message_id: str,
    reply_to: str,
) -> dict[str, Any]:
    merged = {**existing_metadata, **metadata}
    attachments = merged_metadata_attachments(existing_metadata, metadata)
    if attachments:
        merged["attachments"] = attachments
    merged["streamMessageId"] = stream_message_id
    merged["streaming"] = False
    merged["finalize"] = True
    if reply_to:
        merged["replyTo"] = reply_to
    return merged


def merged_completion_metadata(existing: dict[str, Any], metadata: dict[str, Any], *, reply_to: str) -> dict[str, Any]:
    existing_metadata = existing.get("metadata") if isinstance(existing.get("metadata"), dict) else {}
    stream_message_id = str(existing_metadata.get("streamMessageId") or existing_metadata.get("stream_message_id") or "")
    if not stream_message_id:
        merged = {**existing_metadata, **metadata}
        attachments = merged_metadata_attachments(existing_metadata, metadata)
        if attachments:
            merged["attachments"] = attachments
        return merged
    return finalized_stream_metadata(
        metadata,
        existing_metadata=existing_metadata,
        stream_message_id=stream_message_id,
        reply_to=reply_to or str(existing_metadata.get("replyTo") or ""),
    )


def merged_metadata_attachments(left: dict[str, Any], right: dict[str, Any]) -> list[dict[str, Any]]:
    return merge_client_attachments(left.get("attachments"), [
        item for item in right.get("attachments", []) if isinstance(item, dict)
    ] if isinstance(right.get("attachments"), list) else [])


def last_user_message_id(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return str(message.get("id") or "")
    return ""


def message_by_id(messages: list[dict[str, Any]], message_id: str) -> dict[str, Any] | None:
    for message in messages:
        if message["id"] == message_id:
            return message
    return None


def coalesce_core_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    coalesced: list[dict[str, Any]] = []
    for message in messages:
        if message["role"] == "assistant" and coalesced:
            previous = coalesced[-1]
            if (
                previous["role"] == "assistant"
                and is_gateway_replay_pair(previous, message)
            ):
                content = coalesced_gateway_replay_content(previous, message)
                if content is None:
                    logger.warning(
                        "Refusing to coalesce divergent Hermes gateway assistant rows: previous=%s current=%s",
                        previous.get("id"),
                        message.get("id"),
                    )
                    coalesced.append(message)
                    continue
                metadata = merged_completion_metadata(
                    previous,
                    message.get("metadata") if isinstance(message.get("metadata"), dict) else {},
                    reply_to="",
                )
                if message.get("status") == "completed" and previous.get("status") != "completed":
                    coalesced[-1] = {
                        **previous,
                        "status": "completed",
                        "content": content,
                        "updatedAt": message.get("updatedAt") or previous.get("updatedAt"),
                        "metadata": metadata,
                    }
                elif metadata.get("attachments"):
                    coalesced[-1] = {**previous, "metadata": metadata}
                continue
        coalesced.append(message)
    return coalesced


def is_gateway_replay_pair(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_metadata = left.get("metadata") if isinstance(left.get("metadata"), dict) else {}
    right_metadata = right.get("metadata") if isinstance(right.get("metadata"), dict) else {}
    left_source = str(left_metadata.get("source") or "")
    right_source = str(right_metadata.get("source") or "")
    if not left_source.startswith("hermes-gateway") or not right_source.startswith("hermes-gateway"):
        return False
    left_client_request_id = str(left_metadata.get("clientRequestId") or left_metadata.get("client_request_id") or "")
    right_client_request_id = str(right_metadata.get("clientRequestId") or right_metadata.get("client_request_id") or "")
    if left_client_request_id and left_client_request_id == right_client_request_id:
        return True
    left_stream_id = str(left_metadata.get("streamMessageId") or left_metadata.get("stream_message_id") or "")
    right_stream_id = str(right_metadata.get("streamMessageId") or right_metadata.get("stream_message_id") or "")
    return bool(left_stream_id and left_stream_id == right_stream_id)


def coalesced_gateway_replay_content(left: dict[str, Any], right: dict[str, Any]) -> str | None:
    left_content = str(left.get("content") or "")
    right_content = str(right.get("content") or "")
    if not right_content:
        return left_content
    if not left_content:
        return right_content
    if same_normalized_content(left_content, right_content):
        return left_content
    return None


def last_mergeable_assistant_message(
    messages: list[dict[str, Any]],
    *,
    reply_to: str,
) -> dict[str, Any] | None:
    reply_scope_exists = bool(reply_to and any(
        message.get("role") == "user" and str(message.get("id") or "") == reply_to
        for message in messages
    ))
    for message in reversed(messages):
        if message["role"] == "user":
            if reply_scope_exists and str(message.get("id") or "") == reply_to:
                continue
            break
        if message["role"] != "assistant":
            continue
        metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
        reply_matches = bool(reply_to and metadata.get("replyTo") == reply_to)
        unscoped_stream_message = bool((not reply_to or not reply_scope_exists) and metadata.get("streamMessageId"))
        if message["status"] == "streaming":
            return message
        if reply_matches or unscoped_stream_message:
            return message
    return None


def normalize_message_content(content: str) -> str:
    return "\n".join(line.rstrip() for line in content.strip().splitlines())


def same_normalized_content(left: str, right: str) -> bool:
    return normalize_message_content(left) == normalize_message_content(right)


def append_delta_content(existing: str, delta: str) -> str:
    if not existing:
        return delta
    if not delta:
        return existing
    replay_content = cumulative_replay_content(existing, delta)
    if replay_content is not None:
        return replay_content
    overlap = stream_append_overlap(existing, delta)
    if overlap >= 12:
        return f"{existing}{delta[overlap:]}"
    return f"{existing}{delta}"


def cumulative_replay_content(existing: str, delta: str) -> str | None:
    if delta.startswith(existing) and (len(delta) > len(existing) or len(existing) >= 12):
        return delta
    current = existing.rstrip()
    next_content = delta.lstrip()
    if current and next_content.startswith(current) and (len(next_content) > len(current) or len(current) >= 12):
        return next_content
    return None


def stream_append_overlap(existing: str, delta: str) -> int:
    limit = min(len(existing), len(delta))
    for size in range(limit, 0, -1):
        if existing.endswith(delta[:size]):
            return size
    return 0


def apply_stream_content(existing: str, content: str, operation: str) -> str:
    if operation == "replace":
        return content
    return append_delta_content(existing, content)


def chunk_operation(metadata: dict[str, Any]) -> str:
    operation = str(metadata.get("chunkOperation") or metadata.get("chunk_operation") or "append").strip().lower()
    return operation if operation in {"append", "replace"} else "append"
