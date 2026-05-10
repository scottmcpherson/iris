"""Message coalescing helpers for Iris Core delivery and transcript reads."""

from __future__ import annotations

import re
from typing import Any


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
        if status == "streaming":
            merged = merged_stream_snapshot_content(existing_content, content)
            return merged, metadata, same_normalized_content(merged, existing_content)
        merged = merged_completed_stream_content(existing_content, content)
        merged_metadata = merged_completion_metadata(existing, metadata, reply_to=reply_to)
        if existing_status == "completed" and same_normalized_content(merged, existing_content):
            return existing_content, merged_metadata, True
        return merged, merged_metadata, False

    if status != "completed":
        return content, metadata, False

    fallback = stream_fallback_completion(messages, reply_to=reply_to, content=content)
    if fallback:
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

    existing = last_mergeable_assistant_message(messages, reply_to=reply_to, content=content)
    if not existing:
        return content, metadata, False
    existing_content = str(existing.get("content") or "")
    merged = merged_completed_stream_content(existing_content, content)
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
        "content": merged_completed_stream_content(str(existing.get("content") or ""), content),
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
                and equivalent_message_content(
                    str(previous.get("content") or ""),
                    str(message.get("content") or ""),
                )
                and is_gateway_replay_pair(previous, message)
            ):
                metadata = merged_completion_metadata(
                    previous,
                    message.get("metadata") if isinstance(message.get("metadata"), dict) else {},
                    reply_to="",
                )
                if message.get("status") == "completed" and previous.get("status") != "completed":
                    coalesced[-1] = {
                        **previous,
                        "status": "completed",
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
    return bool(
        left_metadata.get("streamMessageId")
        or right_metadata.get("streamMessageId")
        or (
            left_metadata.get("replyTo")
            and left_metadata.get("replyTo") == right_metadata.get("replyTo")
        )
    )


def last_mergeable_assistant_message(
    messages: list[dict[str, Any]],
    *,
    reply_to: str,
    content: str,
) -> dict[str, Any] | None:
    normalized_content = normalize_message_content(content)
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
        if (
            normalized_content
            and equivalent_message_content(str(message.get("content") or ""), normalized_content)
            and (reply_matches or unscoped_stream_message)
        ):
            return message
        if is_post_stream_attachment(content) and (reply_matches or unscoped_stream_message):
            return message
    return None


def normalize_message_content(content: str) -> str:
    return "\n".join(line.rstrip() for line in content.strip().splitlines())


def same_normalized_content(left: str, right: str) -> bool:
    return normalize_message_content(left) == normalize_message_content(right)


def equivalent_message_content(left: str, right: str) -> bool:
    return compact_message_content(left) == compact_message_content(right)


def compact_message_content(content: str) -> str:
    return re.sub(r"\s+([,.;:!?])", r"\1", " ".join(normalize_message_content(content).split()))


def is_post_stream_attachment(content: str) -> bool:
    stripped = content.strip()
    return bool(
        stripped.startswith("Media:")
        or stripped.startswith("Image:")
        or stripped.startswith("File:")
        or stripped.startswith("🖼️ Image:")
        or stripped.startswith("📎 File:")
    )


def append_message_content(content: str, addition: str) -> str:
    left = content.rstrip()
    right = addition.strip()
    if not left:
        return right
    if not right or right in left or equivalent_message_content(left, right):
        return left
    if re.match(r"^[,.;:!?)]", right):
        return f"{left}{right}"
    if not re.search(r"[.!?:;)]$", left) and re.match(r"^[a-z]", right):
        return f"{left} {right}"
    return f"{left}\n\n{right}"


def merged_completed_stream_content(existing: str, delivery: str) -> str:
    existing_content = existing.rstrip()
    delivery_content = delivery.strip()
    if not existing_content:
        return delivery_content
    if not delivery_content:
        return existing_content
    compact_existing = compact_message_content(existing_content)
    compact_delivery = compact_message_content(delivery_content)
    if compact_existing == compact_delivery:
        return delivery_content
    if compact_delivery.startswith(compact_existing):
        return delivery_content
    if compact_existing.startswith(compact_delivery) or compact_delivery in compact_existing:
        return existing_content
    overlapped = overlapping_message_content(existing_content, delivery_content)
    if overlapped:
        return overlapped
    return append_message_content(existing_content, delivery_content)


def merged_stream_snapshot_content(existing: str, delivery: str) -> str:
    existing_content = existing.rstrip()
    delivery_content = delivery.strip()
    if not existing_content:
        return delivery_content
    if not delivery_content:
        return existing_content
    compact_existing = compact_message_content(existing_content)
    compact_delivery = compact_message_content(delivery_content)
    if compact_delivery.startswith(compact_existing):
        return delivery_content
    if compact_existing.startswith(compact_delivery):
        return existing_content
    return delivery_content if len(compact_delivery) >= len(compact_existing) else existing_content


def overlapping_message_content(existing: str, delivery: str) -> str:
    max_overlap = min(len(existing), len(delivery))
    for length in range(max_overlap, 11, -1):
        prefix = delivery[:length]
        index = existing.rfind(prefix)
        if index != -1:
            return f"{existing[:index]}{delivery}"
    return ""
