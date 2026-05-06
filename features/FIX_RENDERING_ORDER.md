# Fix Rendering Order

## Problem

Iris can render assistant response parts out of order after a Hermes run completes. The observed default-profile session `20260506_040643_39239878` is a good repro:

```text
User: create a test image for me
Expected assistant display:
I created a simple test image for you:

MEDIA:/tmp/test_image.svg

Note: the configured image-generation backend failed because `FAL_KEY` is not set, so I made a fallback SVG locally.
```

Hermes Dashboard shows the saved session in that order. Iris can instead show the delivered file/attachment line before the surrounding assistant text.

## Root Cause

Iris currently has two different message representations for the same conversation:

1. Canonical persisted history loaded by `getHermesConversationDetail()` and normalized through `toAppMessages()` in `desktop/src/features/chat/useHermesChat.ts`.
2. Live gateway inbox messages merged through `mergeStreamDelivery()`, `mergeCompletedDelivery()`, `postStreamAttachmentIndex()`, and `coalescePostStreamAttachments()` in the same file.

The gateway stream strips `MEDIA:` directives from streamed text and then sends the media as a separate `hermes-gateway` delivery such as:

```text
📎 File: /tmp/test_image.svg
```

Iris tries to reconstruct a single assistant response by appending these post-stream file messages back onto the streamed assistant message. That reconstruction is heuristic and can diverge from the persisted Hermes session.

The bug sticks because `loadConversation()` returns early when `messagesByConversation[conversationId]` already exists. That means clicking a conversation can keep showing the live reconstructed state instead of replacing it with canonical Hermes history.

## Desired Behavior

Iris should display message content in the order Hermes persisted it.

For completed conversations, the canonical source of truth should be `getHermesConversationDetail()`. Live inbox state should only be treated as provisional while the request is actively running.

## Implementation Plan

### 1. Stop Treating Cached Live Messages As Canonical

Update `loadConversation()` in `desktop/src/features/chat/useHermesChat.ts`.

Current behavior:

```ts
if (
  activeRequestIdsByConversation[conversationId] ||
  messagesByConversation[conversationId]?.length ||
  isOptimisticConversationId(conversationId)
) {
  return;
}
```

Change this so cached messages only block a reload for active or optimistic conversations. Completed real conversations should reload from `getHermesConversationDetail()` when selected.

Recommended shape:

```ts
const hasActiveRequest = Boolean(activeRequestIdsByConversation[conversationId]);
const optimistic = isOptimisticConversationId(conversationId);

if (hasActiveRequest || optimistic) {
  setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
  return;
}
```

Then let the existing detail load replace `messagesByConversation[loadedConversation.id]`.

### 2. Refresh Canonical History After Final Delivery

In `pollGatewayInbox()`, after handling a final stream delivery or a completed non-stream delivery, schedule a silent conversation detail refresh for the affected conversation once Hermes has had a short moment to persist.

Add a helper near `loadConversation()`:

```ts
function refreshConversationDetailSoon(conversationId: string, profileName = profile) {
  window.setTimeout(() => {
    void refreshConversationDetail(conversationId, profileName, { silent: true });
  }, 600);
}
```

Refactor the detail-loading body out of `loadConversation()` into a reusable `refreshConversationDetail()` helper. `loadConversation()` can call that helper, and final delivery handling can call it without mutating input state or user selection unnecessarily.

Only apply the refreshed messages if the conversation id still maps to the same chat id or selected conversation. Avoid replacing an active request in progress.

### 3. Make Media Attachment Merging Conservative

Keep live attachment stitching only for active streaming display. Do not let it become the lasting message state after final completion.

Tighten `isPostStreamAttachmentMessage()` so it recognizes the gateway-native forms exactly:

```ts
/^(?:🖼️\s*)?(?:Image):\s+/i
/^(?:📎\s*)?(?:File):\s+/i
/^(?:Media):\s+/i
```

Avoid broad matches that can classify normal assistant prose as an attachment.

If the canonical history contains a `MEDIA:` line, render it directly in the assistant text instead of replacing or moving it. Do not infer attachment order from file delivery inbox rows once persisted history is available.

### 4. Preserve Stable Ordering In History Reads

In `sidecar/src/hermes_management_server/conversations.py`, make SQLite message ordering deterministic when timestamps tie.

Current query orders by timestamp only:

```py
order_by = f" order by {quote_identifier(timestamp_column)} asc" if timestamp_column else ""
```

Change it to include message id when present:

```py
if timestamp_column and message_id_column:
    order_by = (
        f" order by {quote_identifier(timestamp_column)} asc, "
        f"{quote_identifier(message_id_column)} asc"
    )
elif timestamp_column:
    order_by = f" order by {quote_identifier(timestamp_column)} asc"
else:
    order_by = ""
```

This is not the primary defect, but it removes an easy ordering footgun.

### 5. Add Focused Tests

Add or update tests in `desktop/src/features/chat/__tests__/useHermesChat.test.ts`.

Cover these cases:

- A completed real conversation reloads canonical messages even if cached live messages exist.
- A final stream response followed by `📎 File: /tmp/test_image.svg` can be shown provisionally, but canonical reload replaces it with the persisted content containing `MEDIA:/tmp/test_image.svg` in the correct position.
- `coalescePostStreamAttachments()` does not move attachment-like text ahead of assistant prose.

Add sidecar coverage in `sidecar/tests/test_conversations.py` for deterministic ordering when several messages share the same timestamp.

## Verification

For the implementation PR, run:

```sh
npm test -- desktop/src/features/chat/__tests__/useHermesChat.test.ts
npm test -- desktop/src/features/chat/__tests__/markdown.test.ts
cd sidecar && python3.11 -m pytest tests/test_conversations.py
npm run build
```

Because this is a visible chat UI fix, final verification must follow `AGENTS.md`:

```sh
npm run build:mac:app
```

Launch the fresh app bundle and test with Computer Use against bundle id:

```text
com.nousresearch.hermes-agent.desktop
```

Use the default profile conversation titled `create a test image for me`, or create a new equivalent run. Confirm the assistant display order matches Hermes Dashboard at:

```text
http://127.0.0.1:9119/sessions
```

## Acceptance Criteria

- Completed conversations render in persisted Hermes order.
- The `MEDIA:` line appears where Hermes saved it, between surrounding assistant paragraphs.
- Selecting or reselecting a completed conversation does not preserve stale live-inbox reconstruction.
- Active streaming still updates smoothly while a run is in progress.
- No broad regex merge can reorder normal assistant prose that happens to mention `File:`, `Image:`, or `Media:`.
