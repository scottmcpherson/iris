# Iris Hermes Streaming Plan

## Problem

Iris chat now correctly routes through Hermes gateway via the `agentui` platform adapter. That fixed profile-aware cron delivery, but it changed the response path:

```text
Iris -> Iris platform adapter -> Hermes gateway -> sidecar inbox -> Iris
```

The old direct API path streamed SSE chunks through `hermes_stream_message` and Tauri `hermes://stream` events. The new gateway/platform path currently writes only completed outbound messages into the sidecar inbox, so the UI replaces `Thinking...` with the final full response only after Hermes finishes.

## Target Behavior

- Normal Iris chat should continue using the Hermes gateway/platform path.
- Assistant text should appear incrementally in the existing assistant bubble.
- Tool/progress messages should continue to appear without duplicating final assistant output.
- Cron/reminder delivery should remain profile-aware and should not regress.
- `default` and named profiles such as `health` must stay isolated.

## Current Routing Facts

- Default Hermes API is usually `127.0.0.1:8642`.
- Default Iris adapter is derived as `127.0.0.1:8766`.
- Health Hermes API is usually `127.0.0.1:8643`.
- Health Iris adapter is derived as `127.0.0.1:8767`.
- Inbox rows now include `profile`.
- Iris adapter sends final messages through `POST /v1/inbox/messages`.

## Required Fixes

### 1. Enable Hermes Gateway Streaming

Hermes platform streaming uses top-level gateway config:

```yaml
streaming:
  enabled: true
```

Do not confuse this with `display.streaming`; that is not enough for gateway platform streaming. Check both root and named profile configs.

### 2. Make the Iris Adapter Edit-Capable

Hermes gateway streaming uses `GatewayStreamConsumer`. It sends an initial partial assistant message with `adapter.send(...)`, then updates that message by calling `adapter.edit_message(...)`.

Update `agentui-platform/adapter.py`:

- Advertise message editing support if Hermes expects a flag such as `SUPPORTS_MESSAGE_EDITING = True`.
- Implement `edit_message(chat_id, message_id, content, finalize=False, metadata=None)`.
- Preserve `profile` on both initial send and edits.
- Include stream metadata in outbound sidecar payloads:
  - stable message id
  - `streaming: true | false`
  - `finalize: true | false`
  - optional `replyTo`
  - source such as `hermes-gateway-stream`

### 3. Extend Sidecar Inbox for Stream Updates

The current inbox is append/read by row cursor. If an edit mutates an existing SQLite row, Iris may not see it because the cursor has already advanced. Prefer append-only stream update events.

Add sidecar support for update events, probably still under `/v1/inbox/messages` unless a clearer endpoint emerges.

Recommended payload shape:

```json
{
  "id": "stable-or-event-id",
  "source": "hermes-gateway-stream",
  "platform": "agentui",
  "profile": "health",
  "chatId": "desktop-...",
  "content": "partial assistant text",
  "metadata": {
    "streamMessageId": "adapter-message-id",
    "streaming": true,
    "finalize": false,
    "replyTo": "user-message-id"
  }
}
```

Final update:

```json
{
  "metadata": {
    "streamMessageId": "adapter-message-id",
    "streaming": false,
    "finalize": true
  }
}
```

Keep existing final-message behavior working for non-streaming Hermes configs.

### 4. Merge Stream Updates in Iris Chat State

Update `desktop/src/features/chat/useHermesChat.ts`:

- Poll inbox by selected profile, as it does now.
- Detect `metadata.streamMessageId`.
- If an assistant message with that stream id already exists, update its `content`.
- If not, replace the optimistic `Thinking...` assistant message when `replyTo` matches the active user message.
- Keep `streaming: true` until `metadata.finalize` or `metadata.streaming === false`.
- Do not append every stream update as a separate assistant bubble.
- Continue deduping by inbox event id, but key visible assistant updates by `streamMessageId`.

### 5. Improve Live Delivery Latency

Current polling is around 2 seconds, which will feel coarse for token streaming.

Phase 1 option:

- Poll faster while `activeRequestId` exists, for example 250-500ms.
- Fall back to slower polling when idle.

Better option:

- Add a sidecar SSE endpoint for inbox events.
- Iris subscribes to profile-filtered events.
- Keep polling as a fallback.

### 6. Preserve Profile Isolation

Do not reintroduce global/default fallbacks.

Required invariants:

- A message sent while `health` is selected goes to the health Iris adapter URL.
- The Hermes session is created under `~/.hermes/profiles/health`.
- Sidecar inbox rows/events include `profile: "health"`.
- Default chat polling does not consume or render health stream events.

## Suggested Implementation Order

1. Add/confirm Hermes config notes and defaults for `streaming.enabled`.
2. Add sidecar tests for profile-scoped stream update events.
3. Add adapter `edit_message` support and unit-test payload shape if practical.
4. Update chat reducer logic to merge stream events by `streamMessageId`.
5. Speed up active-request polling or add SSE.
6. Verify with default and health profiles.

## Verification Checklist

- Run `npm --workspace desktop run test:bridge`.
- Run `npm run sidecar:test`.
- Run `npm --workspace desktop run test`.
- Run `npm --workspace desktop run build`.
- Run `npm run build:mac:app`.
- Launch the fresh bundle:

```bash
open -n "/Users/scott/Development/agent-ui/desktop/src-tauri/target/release/bundle/macos/Iris.app"
```

- Use Computer Use against `com.nousresearch.hermes-agent.desktop`.
- In default profile, send a long response prompt and confirm text appears incrementally.
- In health profile, send a long response prompt and confirm:
  - text appears incrementally,
  - health session is not created under default,
  - default sidebar does not show the health chat.
- Schedule a one-minute reminder from health and confirm cron delivery still returns to the same health chat.

## Pitfalls

- Mutating one inbox row will not wake cursor-based polling. Use append-only update events or SSE.
- `display.streaming` is not the gateway streaming switch.
- Returning a message id from `adapter.send(...)` matters; Hermes uses it for later `edit_message(...)` calls.
- If `edit_message` is missing or advertises unsupported editing, Hermes will skip streaming and send only the final response.
- Do not route based on prompt content. All regular chat should stay on the gateway/platform path.
