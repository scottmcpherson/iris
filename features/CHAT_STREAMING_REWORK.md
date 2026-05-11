# Chat Streaming Rework

## Goal

Reduce the chat streaming pipeline to one opinionated path, modeled on the Vercel AI SDK: typed monotonic chunks, one stable correlation key, a single transport, and a guaranteed terminal event per turn. Most regressions in this area trace back to ambiguous chunk semantics, fragile message identity, and an in-memory event bus that the client can't trust — this plan addresses each in order of payoff.

## Background

A streamed assistant turn currently traverses three layers:

```
Desktop ──POST /v1/sessions/{}/messages──► Core ──adapter.send──► Hermes
                                                                      │ streams tokens
                                                                      ▼
Desktop ◄── SSE /v1/events/stream ──── Core ◄── POST /v1/runtime-deliveries/hermes ── iris-platform
            (or polling fallback)         │                                              (edit_message per chunk
            (or 8s stall watchdog)        │                                               with finalize flag)
                                          ▼
                                  LiveDeliveryBus
                                  (in-mem deque,
                                   500 events, 900s TTL)
```

Five+ IDs are in play across the pipeline (`userMessageId`/`clientMessageId`, `clientRequestId`, `streamMessageId`, optimistic `assistantId`, per-edit `messageId`, `sessionId`/`externalSessionId`, `chatId`), three transports stack as fallbacks (SSE → polling → local stall watchdog), and two layers (Core's `message_coalescer.py` and Desktop's `chatStreamMerging.ts`) each implement their own string-matching heuristics to reconcile what a chunk's content actually means.

Commit `8257413` ("Stabilize chat streaming identity and recover from stalled finalize") introduced `clientRequestId` threading and a stall watchdog as the first stabilization pass. This document picks up from there.

## Reference: files involved

Desktop:

- `desktop/src/features/chat/useIrisChat.ts` — send orchestration, EventSource/polling subscription, stall watchdog, delivery routing
- `desktop/src/features/chat/chatStreamMerging.ts` — `mergeStreamDelivery`, `mergeCompletedDelivery`, content reconciliation heuristics
- `desktop/src/features/chat/chatCoreEvents.ts` — event parsing, `streamDeliveryFinalized`
- `desktop/src/features/chat/chatHistory.ts` — history hydration, `clientRequestId` reconstruction
- `desktop/src/features/chat/chatSessionState.ts` — session-state helpers, ID migration
- `desktop/src/lib/agentuiCore.ts` — Core HTTP client, `agentUICoreEventStreamUrl`
- `desktop/src/lib/coreTransport.ts` — low-level transport

Core:

- `iris-core/src/hermes_management_server/main.py`
  - `core_send_message` (≈1285–1460) — POST `/v1/sessions/{id}/messages`
  - `runtime_delivery_hermes` (≈1555–1648) — POST `/v1/runtime-deliveries/hermes`
  - `core_event_stream` (≈1518–1554) — GET `/v1/events/stream` (SSE)
  - `LiveDeliveryBus` (≈93–163) — in-memory event buffer
- `iris-core/src/hermes_management_server/message_coalescer.py` — server-side stream merging
- `iris-core/src/hermes_management_server/runtime_adapters/hermes.py` — Hermes outbound adapter

iris-platform:

- `iris-platform/adapter.py` — `send`, `edit_message`, delivery POST body shape
- `iris-platform/routes.py` — Hermes-facing inbound routes
- `iris-platform/http_client.py` — POST to Core

Tests:

- `desktop/src/features/chat/__tests__/useIrisChat.test.ts`
- `iris-core/tests/test_api.py`, `iris-core/tests/test_message_coalescer.py`, `iris-core/tests/test_core_store.py`
- No end-to-end test exists that exercises all three layers together.

---

## Workstream 1 — Freeze the chunk protocol

### Problem

The current protocol does not specify whether a streaming chunk is a delta, a cumulative snapshot, or an overlapping partial replay. Both Core and Desktop independently try to figure this out with string heuristics:

- `iris-core/src/hermes_management_server/message_coalescer.py:291-335` — `merged_completed_stream_content`, `merged_stream_snapshot_content`, `overlapping_message_content` (12+ char overlap scan)
- `desktop/src/features/chat/chatStreamMerging.ts:252-285` — the same algorithm reimplemented in TypeScript

When a chunk crosses a sentence boundary, equals a prior chunk, or two assistant turns share a prefix, the heuristics can pick the wrong slice. This is the largest single source of "the response looks wrong" regressions.

### Target state

`iris-platform` sends **delta-only** chunks. Each `edit_message` POST contains only the new text since the last chunk for that `streamMessageId`. Cumulative content is reconstructed by appending; no prefix-matching or overlap scanning is needed.

(Snapshot-only is an alternative if Hermes can't easily emit deltas, but deltas are smaller on the wire and trivially correct on the receive side. Pick one and document it.)

### Changes

1. **iris-platform** (`adapter.py:212-253`, `edit_message`): change semantics so `content` is the delta since the previous `edit_message` for this `stream_message_id`. Track the last-sent length per stream so a delta can be sliced. Tag the protocol version in delivery metadata, e.g. `"chunkProtocol": "v2-delta"`.
2. **Core** (`message_coalescer.py`): replace `merged_stream_snapshot_content` and `merged_completed_stream_content` with a single `append` that concatenates the existing content with the delivered delta. Keep the legacy paths behind a `metadata.chunkProtocol == "v1-snapshot"` branch for a deprecation window if iris-platform versions can lag.
3. **Desktop** (`chatStreamMerging.ts:252-295`): same — replace `mergedStreamSnapshotContent`, `mergedCompletedStreamContent`, `overlappingMessageContent`, the punctuation-aware branches in `appendMessageContent`, and the `duplicateCompletedDeliveryIndex` content-equivalence path with a simple delta append, gated on protocol version.
4. **Tests:** add `test_message_coalescer.py` cases that send 1000 deltas and assert the final content equals their concatenation. Update `useIrisChat.test.ts` analogously.

### Acceptance criteria

- `merged_completed_stream_content`, `overlapping_message_content`, and the equivalent TS helpers are deletable (or guarded behind a v1 compatibility branch).
- A fuzz test that sends randomized delta sequences for two interleaved streams produces correct final content.
- No code path uses `String.startsWith`, `String.indexOf`, or overlap scanning on assistant message content.

---

## Workstream 2 — Promote `clientRequestId` to canonical correlation key

### Problem

`desktop/src/features/chat/chatStreamMerging.ts:42-65` has four fallback strategies for locating which assistant message to merge a chunk into:

1. `clientRequestId` match (added in `8257413`)
2. `streamMessageId` / `id` match
3. Last streaming assistant with no `streamMessageId` (the placeholder)
4. Last orphaned streaming assistant (final-chunk-only fallback)

`mergeCompletedDelivery` adds a content-equivalence dedup (`duplicateCompletedDeliveryIndex`) and a post-stream attachment heuristic on top.

Each fallback exists because some sender, in some path, doesn't emit a reliable ID. The fallbacks themselves are why "the response went into the wrong message" still happens — they will match *something* even when they shouldn't.

### Target state

Every chunk carries `clientRequestId` (the user-message UUID) in its metadata, all the way from `iris-platform` through Core to Desktop. `clientRequestId` is the only correlation key used for matching. If a chunk arrives without one, it is logged and dropped.

### Changes

1. **Desktop send path** (`useIrisChat.ts` send → `agentuiCore.ts:sendAgentUICoreMessage`): already passes `clientMessageId`. Confirm it's also propagated as a top-level field on the assistant message and on every subsequent delivery.
2. **Core send path** (`main.py:core_send_message`): when forwarding to the Hermes adapter, include `clientRequestId` in the metadata pushed to Hermes. Persist it on both the user and assistant message rows so history reload can hydrate it.
3. **Hermes adapter** (`runtime_adapters/hermes.py`): forward `clientRequestId` to `iris-platform` in the outbound payload.
4. **iris-platform** (`adapter.py`): read `clientRequestId` from the inbound Hermes context and include it in every `edit_message` and `send` POST to Core's `/v1/runtime-deliveries/hermes`.
5. **Core delivery path** (`main.py:runtime_delivery_hermes`): pass `clientRequestId` through to the emitted event metadata. Also include it on `coalesce_core_messages` output for history loads (it should already be on the persisted row from step 2).
6. **Desktop merge** (`chatStreamMerging.ts`): remove fallbacks (2), (3), (4) from `mergeStreamDelivery`. Remove `duplicateCompletedDeliveryIndex` and `postStreamAttachmentIndex` from `mergeCompletedDelivery`. If `clientRequestId` is missing on an incoming delivery, log a warning and drop the chunk.
7. **`mergeMessageLists`** (`chatStreamMerging.ts:435-465`): drop `shouldReplaceLocalDuplicateMessage` — the duplicate-by-content path. With stable IDs, the only correct merge is by `clientRequestId` or `id`.

### Acceptance criteria

- `chatStreamMerging.ts` has one match strategy per merge function (`clientRequestId` plus an explicit ID check for legacy persisted history).
- A chunk delivered with no `clientRequestId` produces a log line and no UI change.
- Replaying the same prompt twice produces two distinct assistant messages with distinct `clientRequestId`s, even if the content is byte-identical.

### Dependencies

Must follow Workstream 1 (which removes the content-merge path some fallbacks rely on) or land alongside it. Can start in parallel.

---

## Workstream 3 — Guaranteed finalize from iris-platform

### Problem

The desktop's 8-second stall watchdog (`useIrisChat.ts:271-313`) exists because `iris-platform` doesn't always send the terminal `edit_message(..., finalize=True)` call. The watchdog locally flips `streaming` to `false` after 8s of no deltas, which:

- Can fire on a long, healthy stream (slow tool call, model thinking), freezing the UI prematurely.
- Only patches the visible symptom; server state remains inconsistent and is repaired by `refreshSessionDetailSoon`.

### Target state

`iris-platform` guarantees exactly one terminal delivery per stream — either a `finalize: true` chunk on success or an `error` chunk on failure. The desktop trusts the protocol and the 8-second watchdog is removed.

### Changes

1. **iris-platform** (`adapter.py`): wrap the entire stream-handling code path in a `try/finally`. The `finally` block must emit a terminal delivery if one hasn't been sent — either a `finalize: true` empty-delta chunk or, in the exception path, a delivery with `source: "hermes-error"` and `metadata.error` populated.
2. **iris-platform inbound** (`routes.py` Hermes-facing): ensure that whatever drives the stream from Hermes also has a `finally` that triggers the adapter's terminal emit.
3. **Core** (`main.py:runtime_delivery_hermes`): when an `error` delivery arrives mid-stream, emit a `message.assistant.error` event in addition to (or in place of) the `completed` event. The event must reference the same `streamMessageId` and `clientRequestId` so the desktop can mark the right message.
4. **Desktop** (`useIrisChat.ts:271-313`): remove the stall watchdog (`streamLastDeltaAtRef`, `STREAM_STALL_MS`, the 2-second interval). Remove the fallback finalize logic in `mergeStreamDelivery` (the "last orphaned streaming assistant" branch, lines 60-65).
5. **Desktop** (`useIrisChat.ts:1129-1254`): handle `message.assistant.error` by surfacing an error state on the assistant message and clearing the active request.
6. **Tests:** add an iris-platform test that injects an exception mid-stream and asserts a terminal delivery is emitted.

### Acceptance criteria

- Killing the model mid-stream produces a visible error message in the desktop UI within 1 second, not 8.
- `streamLastDeltaAtRef`, `STREAM_STALL_MS`, and the stall-watchdog `useEffect` are removed.
- A long stream (>30s) with steady token output never fires a false stall.

### Dependencies

Workstream 2 should land first so the error event has a reliable `clientRequestId` to attribute to.

---

## Workstream 4 — Replace the event bus with a streaming POST response

### Problem

`LiveDeliveryBus` (`main.py:93-163`) is an in-memory deque with `maxlen=500` and a 900s TTL. If Core restarts, every event in flight is lost. If the desktop sleeps for 15+ minutes, events fall off the back of the buffer. The cursor-based resume can only replay events that are still in the deque.

This is also the structural reason the desktop needs three transports (SSE, polling, stall watchdog): the bus is unreliable enough that the client can't trust any single subscription path.

### Target state (Option A — recommended)

`POST /v1/sessions/{id}/messages` becomes a streaming SSE response. The response body *is* the stream of assistant-message events for that turn (deltas + terminal). One HTTP connection per assistant turn; when the connection ends, the turn is done. Same shape as Vercel AI SDK.

Cross-turn events that aren't tied to a specific send (cron deliveries, automation outputs, multi-session updates) keep using `/v1/events/stream`, but that channel becomes optional rather than the only path.

### Target state (Option B — incremental)

Keep the event-bus architecture but back it with SQLite (`~/.iris/core.sqlite3`, the existing Core-owned store). Drop the 900s TTL. Add a `cursor > N` index. Removes the "Core restart loses events" failure mode without restructuring transports.

### Changes (Option A)

1. **Core** (`main.py:core_send_message`): change the handler to return an SSE response that yields events as `iris-platform` delivers them for this turn. Bridge `runtime_delivery_hermes` deliveries that carry the matching `clientRequestId` into the active per-request subscription rather than (or in addition to) the global bus. A short-lived per-`clientRequestId` queue replaces the cursor-based subscription for this turn.
2. **Core** (`/v1/events/stream`): keep for cross-turn events (cron, multi-session live state). Strip out delta/completed events that are now delivered inline on the send response.
3. **Desktop** (`agentuiCore.ts:sendAgentUICoreMessage`): switch to a `fetch` + `getReader()` SSE consumer for the send response. Per-turn events arrive on the response stream; the global EventSource only handles cross-turn events.
4. **Desktop** (`useIrisChat.ts:240-269`, `pollCoreEvents`): remove the polling fallback. With a streaming POST per turn, a connection drop is a hard failure for that turn (surface as an error and offer retry); no need to fall back to polling.
5. **Tests:** the long-promised end-to-end test (Workstream 5) gets easier here, because the per-turn stream is a single HTTP exchange.

### Changes (Option B)

1. **Core** (`main.py:93-163` `LiveDeliveryBus`): replace the in-memory deque with a SQLite-backed implementation. Persist `(cursor, id, session_id, agent_id, type, payload, created_at)`. Drop the 900s TTL or extend to 7 days. Add a periodic vacuum job.
2. Keep transports unchanged.

### Acceptance criteria

- (Option A) `core_send_message` returns an SSE stream; the desktop renders deltas as the response is read.
- (Option A) `pollCoreEvents` and `startPollingFallback` are deleted.
- (Option B) Restarting Core during an active stream loses no events on resume; the desktop catches up from its last cursor.

### Dependencies

Should follow Workstream 1 (delta-only chunks make the per-turn stream trivial to render) and Workstream 3 (guaranteed terminal closes the stream cleanly).

---

## Workstream 5 — One end-to-end test that crosses all three layers

### Problem

Every layer has unit tests against an idealized contract. The contract between layers is exactly the thing that keeps breaking. No regression in the last several months would have been caught by the existing test suite.

### Target state

A single integration test that:

1. Boots a real Core process against a temp `~/.iris/core.sqlite3`.
2. Boots a fake `iris-platform` that POSTs canned delta sequences (and edge cases: empty-delta finalize, mid-stream error, slow stream, two interleaved streams) to Core's `/v1/runtime-deliveries/hermes`.
3. Acts as the desktop by consuming the streaming POST response (or `/v1/events/stream`).
4. Asserts: every input delta sequence produces the expected reconstructed content, terminal state, and `clientRequestId` correlation.

Lives in `iris-core/tests/test_streaming_e2e.py` or a new top-level `tests/` directory if the test needs to import desktop TS logic via a tiny Node harness.

### Changes

1. Build the fake `iris-platform` test fixture — a small aiohttp app that exposes the same `send_message`/`edit_message` callable surface but with scriptable canned scenarios.
2. Add the test cases. Minimum suite:
   - Happy path: 100 deltas, finalize, content matches.
   - Empty stream: only a finalize.
   - Mid-stream error: error delivery after N deltas, assistant message shows error state.
   - Interleaved: two simultaneous streams with different `clientRequestId` do not cross-contaminate.
   - Replay-identical: same prompt sent twice produces two distinct messages.
3. Wire into `npm run check`.

### Acceptance criteria

- The test runs in <30s and is deterministic.
- A regression in any of the per-layer behaviors changed in Workstreams 1–3 is caught by this test before merge.

### Dependencies

Can start anytime, but the test will need updating after each workstream. Easiest to write *during* Workstream 1 and grow it as the others land.

---

## Suggested ordering

1. **Workstream 5** scaffolding (the test harness, even with one happy-path case) — gives every other workstream a way to prove it didn't break things.
2. **Workstream 1** (delta protocol) — biggest payoff; deletes the most code; lowest dependency on other changes.
3. **Workstream 2** (canonical `clientRequestId`) — depends on the v2 protocol from Workstream 1 to be sure metadata round-trips correctly.
4. **Workstream 3** (guaranteed finalize) — depends on Workstream 2 for reliable error attribution.
5. **Workstream 4** (event-bus rework) — biggest blast radius; do last; pick Option A or B based on appetite at the time.

Workstreams 1–3 can ship as separate PRs over a 2–4 week window without breaking any user flow, since the legacy paths can stay gated behind a `chunkProtocol` version flag during the deprecation window. Workstream 4 Option A is a larger single change and should land on its own.

---

## Non-goals

- Changing the Hermes-side LLM streaming pipeline itself. iris-platform stays a thin shim around Hermes.
- Changing the user-visible session/identity model. This work continues `CANONICAL_SESSION_IDENTITY.md`'s goals but does not re-open them.
- Reworking attachments, tool events, or slash commands beyond what is needed to carry `clientRequestId` and survive the protocol change.
- Replacing the runtime adapter abstraction in Core. The Hermes adapter stays; this is about the wire format and the desktop merge logic, not the adapter layer.

## Risks

- **Protocol version skew during deprecation:** users running an older `iris-platform` plugin against a newer Core (or vice versa) must still work. Mitigated by the `chunkProtocol` metadata tag and a single deprecation branch in `message_coalescer.py`. The branch can be removed once `iris-platform` is known to be ≥ v2 in all installs (`iris:hermes:install` updates can be relied on).
- **Streaming POST and Tauri/desktop networking:** the desktop currently uses `fetch` and `EventSource` from the renderer. Confirm Tauri's webview supports streaming `fetch` response bodies with `getReader()` on macOS, Windows, and Linux before committing to Option A in Workstream 4.
- **Cron and automation deliveries** don't have a `clientRequestId` (no user message triggered them). Workstream 2 must explicitly preserve a separate path for these: deliveries with `source: "hermes-cron"` are matched by `streamMessageId` or `replyTo`, not `clientRequestId`. Document this exception explicitly in `chatStreamMerging.ts`.
- **History reload:** persisted assistant rows from before the v2 protocol may have content that was reconstructed via the old heuristics. They are still correct as final strings; they just don't have a `clientRequestId` on them. The persisted-history path must continue to match by `id` for these rows. This is already the case after `8257413` (which persists `clientRequestId` going forward).

## Open questions

1. Should Workstream 4 go to Option A (per-turn streaming POST) or Option B (persist the bus)? A is the bigger payoff but a larger lift; B keeps the architecture and just makes it durable.
2. Does `iris-platform` have enough hooks into Hermes to emit a guaranteed terminal delivery in all failure modes, including process crashes? If not, the desktop may still need a minimal (e.g. 60s) inactivity timeout as a last-resort safety net — but not the current aggressive 8s watchdog.
3. Is there appetite to break wire compatibility with older `iris-platform` plugins, or must the v2 protocol be fully backward compatible? The plan above assumes backward compatibility via the `chunkProtocol` tag.
