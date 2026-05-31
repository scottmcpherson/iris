# Chat delivery reliability overhaul (Desktop ↔ Core ↔ Hermes)

## Goal

Make the chat round-trip — Iris Desktop → Iris Core → Hermes → Iris Core → Iris Desktop — reliable, so that a sent message always produces exactly one assistant reply that streams in smoothly, never duplicates, never disappears, never truncates, and never gets overwritten by a fabricated error. Today the round-trip is flaky because **three independent layers each try to assemble the assistant message** (the desktop live-merge, Hermes' persisted transcript, and the Core event buffer), joined only by a client-generated correlation ID that several code paths silently lose, and because the one piece of server code written to make streaming robust (`prepare_assistant_delivery_event`) is dead — imported but never called.

End state:

1. **Iris Core is the single assembler of the assistant message.** Core accumulates streaming deltas server-side and publishes **full-content snapshots** to the client. A dropped, duplicated, or reordered event can no longer corrupt the rendered text, because every event is a complete snapshot of the message-so-far.
2. **The desktop client stops stitching deltas and stops replacing live state with a divergent history copy mid-stream.** The client renders the highest-cursor snapshot per stream and reconciles to history only on session open, keyed on a stable shared ID.
3. **One stable correlation identity** (`clientRequestId` + `streamMessageId`) is preserved end-to-end and stamped onto the Hermes history copy, so live-vs-history dedupe is deterministic instead of content-hash guessing.
4. **The event channel is robust**: SSE authenticates, reconnects with cursor resume, and is deduped by a monotonic cursor high-water mark shared with the polling fallback.
5. **Send is durably idempotent** and a slow/lost send response no longer tears down an in-flight reply.
6. **The safety timeout finalizes good partial content instead of replacing it with an error.**

This is a correctness overhaul of an existing pipeline, not a redesign of the product surface. No visible UI/layout changes beyond the chat transcript behaving correctly.

## Non-Goals

- No change to the Hermes gateway itself or to how the agent runs. We only change the Core↔Hermes adapter (`iris-platform`) and Core.
- No change to the product data model for sessions/projects/agents beyond adding overlay/idempotency persistence.
- No new chat features (no edit/regenerate/branching). Attachments, voice, cron/automation deliveries keep working unchanged.
- No migration of historical transcripts. Hermes remains the source of truth for finalized history.
- The uncommitted `apps/desktop/src/features/chat/ChatView.tsx` working-tree change is unrelated to this plan and out of scope.

## Current Repo State

Architecture (verified): Desktop (React/Tauri) → Iris Core (Python/FastAPI, `iris-core/src/hermes_management_server/`, `127.0.0.1:8765/v1`) → Hermes (external runtime) via the bundled `iris-platform` adapter plugin. Replies flow back over a separate HTTP channel into Core's `/v1/events` buffer, consumed by the desktop via SSE (`EventSource`) with a polling fallback.

### The send path
- `POST /v1/sessions/{id}/messages` → `core_send_message` (`main.py:1649`). Stamps `clientRequestId`/`clientMessageId` into `runtime_metadata`, forwards to the per-profile adapter listener (`POST /iris/messages`), and returns `{ messageId, eventCursor }` **synchronously, before the reply exists**.
- Idempotency: `accepted_client_messages` is an in-memory `dict` (init `main.py:~795`, read `~1669`, write `~1823`) — **unbounded and lost on restart**.
- Desktop side: `useIrisChat.sendMessage` (`useIrisChat.ts:346`) mints `userMessageId = crypto.randomUUID()` (`:356`), tags optimistic user + assistant messages with it as `clientRequestId`, and sends it as `clientMessageId` + `Idempotency-Key` (`packages/core-client/src/messages.ts:9-17`, 12 s timeout). On timeout/error it **tears down the active request** (`useIrisChat.ts:615-640`).

### The delivery path (the core problem)
- Hermes streams via the adapter's `edit_message` (`payload/iris-platform/adapter.py:263-354`): computes a delta (`:282-296`), labels each chunk with a unique `messageId = {streamMessageId}:edit:{time.time_ns()}` (`:315`) plus `clientRequestId` resolved through a fallback chain ending in a per-chat map (`:301-310`), and POSTs to `/v1/runtime-deliveries/hermes`.
- `runtime_delivery_hermes` (`main.py:1930-2046`) publishes **one raw event per delta**, verbatim, via `publish_core_event` (`:2028`) with `event_id = f"evt_delivery_{delivery.messageId}"` (`:2039`). **No server-side accumulation.**
- `prepare_assistant_delivery_event` (`message_coalescer.py:26-79`) — the function that merges deltas by `streamMessageId`, honors append/replace, and suppresses duplicate terminals — is imported at `main.py:51` and **called nowhere** (verified by grep: the only reference is the import). Its helper kit (`append_delta_content:271`, `cumulative_replay_content:285`, `stream_append_overlap:295`, `apply_stream_content:303`, `chunk_operation:309`) is therefore dead on the live path.
- The `/v1/events` buffer (`LiveDeliveryBus`, `main.py:107-325`) dedupes only by exact `event_id`; with a `core_store` set it persists to `core_events` and `prune()` is a no-op (`~302-304`) → **no cap, no TTL** in production.

### The "fetch the full conversation" reconcile
- `GET /v1/sessions/{id}/messages` → `core_session_messages` (`main.py:1611-1647`) reads the transcript from **Hermes' own store** (different message IDs, `status:"completed"`), and only falls back to the event buffer `if not messages` (`:1642`).
- Desktop refetches this **3–4× per reply**: `refreshSessionDetailSoon` ~600 ms after send (`useIrisChat.ts:612`, def `:1040`), `scheduleActiveStreamReconcile` 3.5 s into the stream (`:1403`, def `:1477`), on **every** completed/error delivery (`:1400`), and `scheduleSessionTitleResolveSoon` ~3 s later (`:1401`). `refreshSessionDetail` (`:897-1018`) **replaces** `messagesBySession[id]` with the Hermes copy (`:966-980`).
- The live message used `streamMessageId`-keyed IDs; the history copy uses Hermes' IDs; the user-message `clientRequestId` is recovered by **content-hash match, which `core_store` abandons on hash collisions** (two identical messages). This replace-with-divergent-identity is where a just-streamed reply flips to a duplicate or briefly disappears.

### Desktop event consumption
- SSE `EventSource` is constructed **directly** (`useIrisChat.ts:306`), bypassing the authed Tauri/Python bridge (`core_bridge.py` adds `Authorization: Bearer` at `~191-194`). So for **tailscale/remote** Core (which requires the token), SSE 401s immediately.
- `onerror` closes the source and **permanently degrades to polling** with no reconnect (`:321-325`). Every send tears down and rebuilds the whole SSE+poll effect (`hasActiveRequest` dep, `:337`).
- Cross-channel dedupe is an id-`Set` trimmed to 250 entries (`:1337-1341`); cursor is advanced on processing, not commit (`:1213-1220`). SSE limit 200 vs poll limit 50 (`events.ts` vs `useIrisChat.ts:1197`).
- Failure sinks: `mergeStreamDelivery` silently drops deltas with no resolvable `clientRequestId` (`chatStreamMerging.ts:18-25`); unmapped deliveries are dropped after 2 attempts (`shouldRetryUnmappedDelivery`); the 60 s safety timeout (`STREAM_SAFETY_TIMEOUT_MS`, `useIrisChat.ts:147`) replaces a stalled-but-correct bubble with "Iris stopped receiving stream updates…" (`failTimedOutStreams:1426-1475`).

### Symptom → cause map
| Symptom | Primary cause |
|---|---|
| Stuck on "Thinking…" forever, then a 60 s error | Delta dropped / `clientRequestId` lost → live merge never updates; safety timeout fabricates error |
| Reply appears, then duplicates | Mid-stream history refetch replaces live (different IDs); content-hash dedupe collision |
| Reply flickers / briefly disappears | Same refetch-replace race |
| Garbled / truncated text | Lost or reordered delta with no server snapshot; empty-content finalize |
| Laggy streaming, esp. remote | SSE dead (no auth / no reconnect) → 50-event polling only |
| Duplicate reply after restart | Non-persistent idempotency cache → retry re-runs the agent |

## Architecture Decision

**One assembler, one identity, one reconcile.**

1. **Core assembles; Core→client is full snapshots.** Keep the adapter→Core hop as deltas (efficient server-to-server), but make Core accumulate per `streamMessageId` and publish events whose `content` is the **entire message-so-far** with `chunkOperation: "replace"`. The client renders the highest-cursor snapshot per stream. This is the linchpin: on an at-least-once, possibly-reordered channel, a full snapshot per event is the only representation that cannot be corrupted by loss/dup/reorder. It also fixes empty-content finalize truncation, because the completed event carries the full final text.

   Wire choice within this: **unique `event_id` per delivery, cumulative content.** We do not reuse a stable per-stream `event_id` (the buffer dedupes by id and would drop the second snapshot). Each snapshot is a new cursor row; the client keeps only the latest per `streamMessageId`. Bound buffer growth with an explicit cap+TTL (below).

2. **Stable shared identity.** `clientRequestId` (the client UUID) and `streamMessageId` are the canonical keys. Core stamps both onto the assistant history rows it returns from `core_session_messages`, via a persisted assistant overlay written at finalize. The client dedupes live-vs-history strictly by `clientRequestId`; content-hash becomes a last-resort tiebreak that **no longer abandons on collision** (positional match instead).

3. **Stop mid-stream refetch.** While a request is active, the client does **not** refetch+replace the whole conversation. The Core-assembled snapshot is canonical for the active turn. History reconcile happens only on session open/switch and as a **single, idempotent, clientRequestId-keyed** safety pass after completion (never a blind replace).

4. **Robust event channel.** SSE authenticates (token via the stream request), reconnects with `after=lastCursor` and backoff, and both SSE and polling feed a single monotonic **cursor high-water mark** for dedupe (replacing the 250-entry id-Set). Cursor advances only after state commit.

5. **Durable idempotency, resilient send.** Persist accepted client messages (bounded) so retries dedupe across restart. A send timeout where Core may have accepted does **not** tear down the active request; the event stream (or the safety timeout) resolves it.

6. **Honest finalize.** The safety timeout finalizes existing streamed content as completed; it only shows an error when there is genuinely no content and no cursor progress.

Layer ownership after this change:
- **Adapter (`iris-platform`)**: correlation hardening only — guarantee `clientRequestId` on every delta, restart-safe terminal guard.
- **Core**: assembly, snapshots, idempotency persistence, history overlay, buffer bounds.
- **Desktop**: dumb renderer of snapshots + cursor dedupe + robust SSE + single on-open reconcile.

---

## Core implementation

All paths under `iris-core/src/hermes_management_server/` unless noted.

### C1. Server-side stream assembly (`main.py` `runtime_delivery_hermes`, `message_coalescer.py`)

Introduce a per-stream accumulator and emit full snapshots.

- Add `app.state.stream_assembly: dict[str, dict]` (init next to `accepted_client_messages`). Keyed by `streamMessageId`, value `{ "content": str, "metadata": dict, "status": "streaming"|"completed", "updatedAt": int }`. Guard with the existing `LiveDeliveryBus` lock or a dedicated `threading.RLock`.
- In `runtime_delivery_hermes`, after computing `stream_message_id`, `is_streaming`, `is_final`, `is_error_delivery` (`main.py:1974-1986`) and before `publish_core_event` (`:2028`), call a new helper:

```python
# message_coalescer.py — new, reuses existing append/replace helpers
def assemble_stream_snapshot(prior, *, delta_content, metadata, status):
    """Return (full_content, changed). prior is the last snapshot dict or None."""
    operation = chunk_operation(metadata)               # "append" | "replace"
    existing = str((prior or {}).get("content") or "")
    if status == "error":
        return delta_content, True                       # errors replace, always emit
    merged = apply_stream_content(existing, delta_content, operation)
    return merged, not same_normalized_content(merged, existing)
```

- Wire it in `runtime_delivery_hermes`:
  - `prior = app.state.stream_assembly.get(stream_message_id)` (rehydrate from the last buffered event for this `streamMessageId` if missing — see C2 read helper — so it survives a Core restart mid-stream).
  - `status = "error" if is_error_delivery else "completed" if (is_final or not is_streaming) else "streaming"`.
  - `full_content, changed = assemble_stream_snapshot(prior, delta_content=event_content, metadata=event_metadata, status=status)`.
  - If `not changed and status == "streaming"`: **skip publishing** (idempotent redundant delta) and return `{ "ok": True, "suppressed": True, ... }`.
  - Else update `app.state.stream_assembly[stream_message_id] = { content: full_content, metadata: event_metadata, status, updatedAt: now }`.
  - Publish with **full content** and `chunkOperation: "replace"` in metadata:
    ```python
    event_metadata = { **event_metadata, "chunkOperation": "replace",
                       "streamMessageId": stream_message_id,
                       "assembled": True }     # marker for the client / forward-compat
    event = publish_core_event(app, ..., content=full_content,
                               event_id=f"evt_delivery_{delivery.messageId}", ...)
    ```
  - On `status in ("completed","error")`: pop `stream_assembly[stream_message_id]` and write the assistant history overlay (C3).
- Keep `event_id` unique per delivery (`delivery.messageId` already embeds `time.time_ns()`), preserving the buffer's exact-retry dedupe.
- Generated-file attachment ingestion (`ingest_generated_file_attachments`, `persist_assistant_attachment_metadata`, `main.py:2007-2026`) stays, operating on `full_content`.

Note the adapter still sends incremental deltas; **Core does the accumulation**. The `delta`/`replace` decision the adapter already encodes via `chunkOperation` is honored by `apply_stream_content`.

### C2. Event buffer bounds + per-stream lookup (`LiveDeliveryBus`, `main.py:107-325`)

- Add an explicit retention bound on the SQLite path (today `prune()` no-ops with a store): cap `core_events` to the most recent N rows (e.g. 5,000) and/or TTL (e.g. 24 h), pruning oldest by `cursor` on publish or on a periodic task. Never prune rows newer than any connected SSE/poll watermark within the TTL window.
- Add `latest_event_for_stream(stream_message_id, agent_id) -> event | None` (newest `core_events` row whose `metadata.streamMessageId == stream_message_id`), used by C1 to rehydrate the accumulator after a restart.
- Keep id-dedupe (`_publish_sqlite`) for exact adapter retries.

### C3. Assistant history overlay for stable dedupe (`core_store.py`, `runtime_adapters/hermes.py`)

Goal: when Desktop later fetches the full conversation, each assistant row carries the `clientRequestId`/`streamMessageId` it streamed under, so dedupe is deterministic.

- New overlay table `assistant_message_metadata(runtime_id, profile, chat_id, stream_message_id, client_request_id, reply_to, content_hash, normalized_content, created_at, PRIMARY KEY(runtime_id, profile, chat_id, stream_message_id))`. Written at finalize in `runtime_delivery_hermes` (C1) with the assembled `full_content`'s normalized hash.
- In `with_client_message_metadata` (`hermes.py:821-888`) — which already overlays user metadata — add an assistant pass: for each assistant history row, match an overlay row by, in priority order: (1) `content_hash` **with positional tiebreak** among rows/overlays sharing that hash (consume in transcript order; never drop on collision — this replaces the abandon-on-collision behavior at `core_store.py:1293-1297` for this overlay), (2) normalized-content equality. Stamp `clientRequestId`, `streamMessageId`, `replyTo` into the row metadata.
- Result: `clientRequestIdFromHistoryMessage` (`chatHistory.ts:101-118`) finds `clientRequestId` directly; no client-side content-hash guessing.

### C4. Durable, bounded idempotency (`core_send_message` `main.py:1649`, `core_store.py`)

- Replace the in-memory `accepted_client_messages` dict with: a bounded in-memory LRU (e.g. 1,000 entries) **backed by** a persisted table `accepted_client_messages(session_id, idempotency_key, response_json, created_at, PRIMARY KEY(session_id, idempotency_key))` with TTL pruning (e.g. 24 h).
- On send: check memory→DB; on hit return the stored response with `duplicate: True`. On accept: write both. Survives Core restart, so a client resend after a dropped response dedupes instead of re-running the agent.
- Keep keying on `(session_id, Idempotency-Key or clientMessageId)`; the desktop always sends a stable `Idempotency-Key` (`messages.ts:15`), so resends are safe.

### C5. Stop gating the event-buffer reconcile incorrectly (optional, `main.py:1642`)

- `core_session_messages` falls back to the buffer only `if not messages`. Leave that gate (Hermes stays source of truth), but ensure the assistant overlay (C3) is applied **regardless** so the returned Hermes transcript is dedupe-ready. No behavior change when Hermes returns history; correctness improvement on the overlay.

---

## Adapter implementation (`payload/iris-platform/adapter.py`)

Correlation hardening only; the adapter keeps sending deltas.

### A1. Guarantee `clientRequestId` on every delta
- In `edit_message` (`:263-354`) and `send` (`:189-261`), resolve `clientRequestId` strictly from the per-stream map `_stream_client_request_ids[stream_message_id]` first. Populate that map when the stream is first registered (on the inbound message / first edit) from the inbound `metadata.clientRequestId`.
- Demote the per-chat fallback `_active_client_request_ids_by_chat` (`:301-310`) to last resort **with a tight time fence** (e.g. only if set within the last few seconds) to avoid cross-turn mis-attribution when two messages overlap on one chat.
- If `clientRequestId` still cannot be resolved, attach an explicit `metadata.uncorrelated = True` instead of emitting a silently-unlabeled delta, so Core can route by `chatId` and the client can render it as a new assistant message rather than dropping it (see D5).

### A2. Restart-safe terminal guard
- `_stream_terminal_sent` (`:279-280, 334-342`) is per-process. Before emitting a synthetic error terminal in `_handle_inbound_message_done` (`:602-617`) / `_emit_stream_error_delivery` (`:421-455`), the adapter cannot see Core state, so make Core idempotent instead: in C1, if `stream_assembly` for the id is already `completed`/`error` (or a completed event exists in the buffer), treat a second terminal as a no-op (return `suppressed`). This prevents a post-restart re-terminate from overwriting a finished message.

### A3. Surface pre-stream failures
- When `handle_message` fails **before** the first `edit_message`/`send` (no active stream registered), `_handle_inbound_message_done` currently emits nothing. Emit an error delivery keyed by the inbound `clientRequestId` (which the adapter has from `_inbound_message`, `:540-548`) so the client shows a real failure instead of a stuck "Thinking…".

---

## Desktop implementation (`apps/desktop/src/`)

### D1. Render snapshots, retire delta-stitching (`features/chat/chatStreamMerging.ts`, `useIrisChat.ts`)
- `mergeStreamDelivery` (`chatStreamMerging.ts:11-81`): when the delivery is an assembled snapshot (`metadata.assembled === true` or `chunkOperation === "replace"`), set `content = messageContent` directly (full replace) — no `appendDeltaContent`/overlap heuristics. Keep the append path only as a **fallback for old Core** during version skew (SSH/remote), behind the same `assembled` check.
- Keep `coalescePostStreamAttachments` (generated-file messages) and tool-event merging unchanged.
- Net effect: the client cannot corrupt text by mis-stitching; it just shows the latest snapshot.

### D2. Cursor high-water dedupe (`useIrisChat.ts`, `chatCoreEvents.ts`)
- Replace the 250-entry `processedInboxEventIdsRef` Set (`:1337-1341`) with a monotonic `lastAppliedCursorByProfileRef` high-water mark. In `handleCoreEvents`/`handleCoreDeliveries`, ignore any delivery whose `cursor <= highWater[profile]`; after a batch commits to state, set `highWater = max(seen cursor)`.
- Advance the **fetch cursor** (for the next SSE/poll `after`) **only after** `setMessagesBySession` commits (move the bump out of `handleCoreEvents:1213-1220` to a post-commit effect or a `flushSync`-guarded point), eliminating the skip-on-teardown race.
- Because every event is a full snapshot, even an accidental reprocess is harmless (idempotent render), so this dedupe is belt-and-suspenders, not load-bearing.

### D3. Robust SSE: auth + reconnect (`useIrisChat.ts:281-337`, `lib/irisCore.ts`, `lib/coreTransport.ts`)
- **Auth**: stop using the raw browser `EventSource` for authenticated connections. Either (a) consume the stream via a `fetch()` `ReadableStream` reader routed through the same transport that injects `Authorization` (preferred — works for tailscale), or (b) for loopback/SSH-tunnel (no token required per README) keep `EventSource`. Implement a small `openCoreEventStream(runtimeConfig, { after, agentId, onEvent, onError })` in `lib/irisCore.ts` that picks the authed fetch-reader when a token is required and `EventSource` otherwise.
- **Reconnect**: on stream error, do **not** permanently fall back. Reconnect with `after = lastAppliedCursor` and capped exponential backoff (e.g. 0.5 s → 5 s), keeping the polling fallback active only while disconnected. Tear the stream down only on `requestKey`/`profile` change (drop `hasActiveRequest` from the effect deps `:337` so sends no longer rebuild the stream).
- **Resume correctness**: opening with `after = lastAppliedCursor` plus snapshot semantics means a reconnect can neither skip (snapshots are cumulative) nor corrupt (high-water dedupe).

### D4. Single, idempotent on-open reconcile (`useIrisChat.ts`)
- Remove the mid-stream refetch-replace calls while a request is active: drop `scheduleActiveStreamReconcile`/`reconcileActiveSessionDetails` during streaming (`:1403, 1413-1424, 1477-1482`) and the per-delivery `refreshSessionDetailSoon` (`:1400`). Keep title resolution (`scheduleSessionTitleResolveSoon`) but make it **metadata-only** (title/project), never replacing message bodies.
- Keep exactly one reconcile: on session open/switch (`loadSession`), and one **idempotent** post-completion pass that merges history by `clientRequestId` (using `mergeMessageLists`, `chatStreamMerging.ts:405-426`) instead of blindly replacing (`refreshSessionDetail:966-980`). With C3 stamping `clientRequestId` on history rows, this pass dedupes deterministically and is a no-op in the common case.

### D5. Don't drop late/unmapped replies (`useIrisChat.ts:1259-1411`, `chatSessionState.ts`)
- Raise `shouldRetryUnmappedDelivery` attempts and widen the window; with stable IDs (C3) and no mid-stream teardown, unmapped should be rare.
- When a delivery maps to a known session by `chatId` but no active request matches (e.g. after a send timeout, D6), **render it** as an assistant message keyed by its `clientRequestId` rather than discarding it (`:1307-1316`). A late reply is never lost.
- `mergeStreamDelivery`'s silent drop on missing `clientRequestId` (`chatStreamMerging.ts:18-25`): fall back to `streamMessageId` (snapshots carry it) so an `uncorrelated` delivery (A1) still renders.

### D6. Resilient send (`useIrisChat.ts:346-644`, `lib/query/sessions.ts`, `packages/core-client/src/messages.ts`)
- On send timeout/transport error where Core may have accepted, do **not** immediately remove the active request and write the error into the assistant bubble (`:615-640`). Instead: keep the assistant placeholder streaming, mark the request "pending confirmation," and let the event stream resolve it; only fail if the safety timeout (D7) elapses with no cursor progress.
- Because `Idempotency-Key` is durable now (C4), an optional one-shot resend on timeout is safe; gate behind a flag, default off for V1.
- Plumb the intended per-call timeout through the Tauri bridge (`coreTransport.ts:47-66` currently drops `init.timeoutMs`); align browser-transport default (2.5 s, `coreTransport.ts:85`) with the 12 s send timeout so Vite-dev sends don't spuriously fail.

### D7. Honest safety timeout (`useIrisChat.ts:1426-1475`, `:147`)
- Reset the per-request touch timestamp on **any cursor advance** for the session, not only on a `clientRequestId`-matched delta, so a healthy stream is never marked timed-out.
- On timeout, if the assistant message has non-placeholder content, **finalize it as completed** (drop `streaming`, keep the text). Only render the "stopped receiving updates" error when content is still the `ASSISTANT_THINKING_TEXT` placeholder and no cursor progress occurred.

---

## Wire protocol change (Core → client)

- **Before**: `message.assistant.delta` events carry an incremental fragment; client concatenates by `clientRequestId`. `message.assistant.completed` often carries empty content.
- **After**: every `message.assistant.delta` and `message.assistant.completed` event carries the **full assembled content-so-far** with `metadata.chunkOperation = "replace"` and `metadata.assembled = true`. `streamMessageId` is always present. Client renders the highest-cursor snapshot per `streamMessageId`/`clientRequestId`.
- **Compatibility**: new Core + old client works (old client's `replace` path renders full content). New client + old Core works (the `assembled` check is false → client keeps the legacy append path). Adapter→Core hop is unchanged (still deltas), so Hermes/adapter version skew is unaffected.

---

## Tests

### Core (pytest, `iris-core/tests/`)
- **Assembly unit** (`message_coalescer`): append sequence → snapshots are cumulative; `replace` op resets; non-monotonic content → replace; redundant identical delta → `changed == False` (suppressed); error delivery replaces and emits.
- **`runtime_delivery_hermes` integration**: feed N deltas + finalize → buffer holds cumulative snapshots; the final/completed event content equals the full text (not empty); a duplicate finalize after completion is `suppressed` (A2); rehydrate-after-restart (drop `stream_assembly`, ensure prior snapshot is read from the buffer).
- **Update `tests/test_streaming_e2e.py`**: it currently asserts `"".join(deltas) == full` and `completed content == ""`. Rewrite to assert **latest snapshot per `streamMessageId` == full text** and **completed content == full text**. This is an intended, breaking wire change.
- **Idempotency persistence** (C4): same `(session_id, Idempotency-Key)` across a simulated restart returns `duplicate: True` and does not re-forward to the adapter.
- **History overlay** (C3): assistant rows get `clientRequestId`/`streamMessageId` stamped; collision case (two identical assistant contents) resolves positionally with no dropped overlay.
- **Buffer bounds** (C2): publishing past the cap prunes oldest; `latest_event_for_stream` returns the newest snapshot.

### Desktop (vitest, `apps/desktop/src/features/chat/__tests__/`)
- **`chatStreamMerging`**: assembled snapshot → full replace, no overlap heuristic; legacy delta path still works when `assembled` absent.
- **`useIrisChat`**: cursor high-water dedupe (SSE+poll delivering overlapping cursors render once); no message replacement during an active request; on-open reconcile merges by `clientRequestId` without duplicating; late/unmapped delivery by `chatId` renders instead of dropping (D5); send-timeout keeps the request pending and a subsequent event resolves it (D6); safety timeout finalizes good partial content rather than erroring (D7).
- **SSE module** (`lib/irisCore` `openCoreEventStream`): chooses authed fetch-reader when a token is required; reconnects with `after=lastCursor` and backoff; does not tear down on send.

### Manual / packaged (required — see Verification)
- Local managed Core: long streamed reply, rapid successive sends, send during reconnect, two sessions streaming at once, Core restart mid-stream, identical message twice.
- Tailscale remote: confirm SSE now authenticates (no permanent polling fallback) and streams smoothly.

## Implementation Order

1. **C1 + C2** — Core assembly + snapshots + buffer lookup/bounds. Update `test_streaming_e2e.py`. (Biggest reliability win; everything else builds on it.)
2. **D1 + D2** — Client renders snapshots + cursor high-water dedupe. End-to-end smooth streaming on local.
3. **D4** — Stop mid-stream refetch-replace; single on-open reconcile. Kills duplicates/flicker.
4. **C3** — Assistant history overlay → deterministic on-open dedupe (pairs with D4).
5. **D3** — Robust SSE (auth + reconnect). Fixes remote/degraded streaming.
6. **C4 + D6** — Durable idempotency + resilient send.
7. **A1 + A2 + A3** — Adapter correlation hardening + restart-safe terminal + pre-stream failures.
8. **D5 + D7** — Late-delivery rendering + honest safety timeout (final polish).

Each step is independently shippable and leaves the system better than before; land in this order.

## Acceptance Criteria

- A streamed reply renders progressively and ends with the complete text; killing/reordering/duplicating events in a test harness never corrupts it.
- No duplicate assistant bubbles, no flicker, no disappear-then-reappear across the live→history transition — including two identical prompts in a row.
- A reply for which the synchronous send response was lost (>12 s) still renders; no fabricated error over good content.
- Core restart mid-stream does not duplicate or overwrite the finished message; client resend after a dropped response does not re-run the agent.
- On tailscale, SSE authenticates and stays connected (verified: not silently on polling); a transient drop reconnects and resumes without gaps or dupes.
- Two concurrent sessions stream independently with correct attribution.
- `npm run check` (incl. `check:css`), desktop vitest, and `iris-core` pytest all green.

## Risks and Mitigations

- **Snapshot bandwidth O(N²)** for long messages streamed in many chunks. Mitigation: optional Core-side emit throttle (coalesce snapshots to every ~120 ms / ~256 new chars); ship correctness first, add throttle if profiling shows pressure. Note as the one perf tradeoff.
- **Version skew (remote Core vs desktop)**: handled by the `assembled` capability flag (dual-path client, replace-tolerant old client). Document the minimum matched Core version in the SSH/remote setup notes.
- **Authed SSE via fetch-reader**: must handle tunnel/WebView streaming quirks. Mitigation: keep `EventSource` for loopback/SSH, fetch-reader only where a token is required; polling fallback remains the floor.
- **Overlay mismatch on collisions**: positional tiebreak is deterministic but assumes transcript order is stable; acceptable because the live snapshot already rendered the correct message and the overlay only affects on-open dedupe.
- **Behavior change in `test_streaming_e2e.py`** is intentional; reviewers should expect the wire-format assertions to change.

## Open Questions

1. Snapshot throttle: ship in V1 or defer? (Recommendation: defer behind a constant, default unthrottled, revisit after manual long-reply testing.)
2. Optional auto-resend on send timeout (D6): enable by default once idempotency is durable, or keep flag-gated? (Recommendation: flag-gated off for V1.)
3. Event buffer retention numbers (N rows / TTL) — confirm against expected session volume and the `/v1/events` consumer cadence.
4. Should the assistant overlay (C3) also write back into Hermes' own message metadata (if the adapter can), making the join independent of Core overlays? (Out of scope for V1; note for a future pass.)

## Verification (packaged desktop required)

Per `AGENTS.md`, this touches Core, the Tauri bridge, persistence, transport, and business logic, so final verification is packaged-desktop, not Vite-only:
- Iterate per-step with vitest + pytest + the Vite dev surface (`http://localhost:1420/`) for client-only slices (D1, D2, D7).
- For the full round-trip (C1–C4, D3–D6, A1–A3): `npm run build:mac:app`, launch the bundle, and exercise with Computer Use against `com.nousresearch.hermes-agent.desktop`. Run the local-managed matrix, then the tailscale matrix. Do not run parallel packaged sessions against the same bundle id.
- After landing: note in the PR whether users must restart Iris Core, reinstall/update the Hermes adapter plugin (A1–A3 change `iris-platform`), and restart the Hermes gateway. The adapter change ships via the version-matched Core installer, so the release notes must instruct: update Core → reinstall Iris adapter → restart Hermes gateway → open a fresh chat.
