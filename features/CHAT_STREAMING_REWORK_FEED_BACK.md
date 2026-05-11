# Chat Streaming Rework — Implementation Feedback

Review of the implementation of `features/CHAT_STREAMING_REWORK.md`. Verifies acceptance criteria across all five workstreams and flags issues found during the review.

## Verdict

**Solid implementation.** All five workstreams shipped, all 69 desktop tests pass, all Core + iris-platform pytest cases pass including the new 5-scenario e2e suite. The chunk-protocol simplification is the standout: `message_coalescer.py` shed ~120 lines of string heuristics, `chatStreamMerging.ts` shed ~165, and the merge logic now boils down to "find by `clientRequestId`, append the delta." That is the right shape.

A handful of issues to address before declaring this done.

## What checks out

### Workstream 1 — delta protocol

- `iris-platform/adapter.py:edit_message` slices deltas from cumulative Hermes content.
- `chunkProtocol: "v2-delta"` tag is on every delivery.
- `message_coalescer.append_delta_content` and `chatStreamMerging.appendDeltaContent` both reduce to plain concatenation.
- `overlapping_message_content`, `merged_completed_stream_content`, `merged_stream_snapshot_content`, `compactWhitespace`, the punctuation-aware `appendMessageContent` — all gone.

### Workstream 2 — `clientRequestId` canonical

Full chain wired:

- `desktop/src/features/chat/useIrisChat.ts:312,319` puts it on the optimistic user and assistant messages.
- `iris-core/src/hermes_management_server/main.py:1462` injects it into `runtime_metadata`.
- `iris-core/src/hermes_management_server/runtime_adapters/hermes.py:393-401` forwards it.
- `iris-platform/adapter.py` reads it from inbound metadata, caches it per-stream, and tags every outbound chunk.
- `iris-core/src/hermes_management_server/main.py:1737-1743` round-trips it through `runtime_delivery_hermes`.
- Both `mergeStreamDelivery` and `mergeCompletedDelivery` drop chunks without it, with a `console.warn`.

### Workstream 3 — guaranteed finalize

- Stall watchdog gone (`grep` for `streamLastDeltaAt`/`STREAM_STALL` is empty).
- `_emit_stream_error_delivery` in `iris-platform/adapter.py:310` emits a terminal `hermes-error` delivery on `_request` failure.
- `mergeErrorDelivery` exists in `chatStreamMerging.ts:119`.
- The desktop detects error deliveries via three signals: `eventType === "message.assistant.error"`, `source === "hermes-error"`, or `metadata.error` presence (`useIrisChat.ts:1115-1117`).
- `eventType` is propagated from the SSE event into the inbox message metadata at `coreLegacyCompat.ts:59`.

### Workstream 4 — event bus

Option B implemented:

- `LiveDeliveryBus` now optionally backed by SQLite (`core_events` table created in `core_store.py:305`, wired via `main.py:766`).
- `_publish_sqlite` / `_list_events_sqlite` / `_latest_cursor_sqlite` work.
- Restart test confirms durability.
- Polling fallback and SSE both still active (consistent with Option B).

### Workstream 5 — e2e test

`iris-core/tests/test_streaming_e2e.py` covers all five doc-required scenarios:

- 100 interleaved deltas across two streams.
- Mid-stream error with `clientRequestId` correlation.
- Empty stream (finalize only).
- Replay-identical content with distinct `clientRequestId`s.
- Core restart persistence.

---

## Issues to address

### 1. Silent content corruption when Hermes content diverges (`iris-platform/adapter.py:245-250`)

```python
if last_sent_content and clean_content.startswith(last_sent_content):
    delta = clean_content[last_sent_length:]
elif not last_sent_content:
    delta = clean_content
else:
    delta = clean_content   # ← this branch
```

The third branch fires when Hermes sends new cumulative content that **doesn't** start with what was last sent (e.g., model retry, content edit, regen). It sends the full new content as if it were a delta, and the receiver appends it to existing content. Result: `"Hello world" + "Goodbye" = "Hello worldGoodbye"`.

This is silent and rare, but it is exactly the class of bug the rework was meant to eliminate. Three reasonable fixes:

- Compute the longest common prefix and send only the diverging tail (`delta = clean_content[len(common_prefix):]` with a "rewind" marker in metadata).
- Drop the chunk with a warning log and leave the previous content intact.
- Introduce a `chunkOperation: "replace"` metadata tag for this branch and have Core honor it.

Option (b) is the cheapest. If you go (a) or (c), add an e2e case covering non-monotonic Hermes content.

### 2. Per-stream caches in `IrisPlatformAdapter` have no cleanup path for abandoned streams

`_stream_last_sent_lengths`, `_stream_last_sent_content`, `_stream_client_request_ids`, `_stream_terminal_sent`, `_active_client_request_ids_by_chat` (`adapter.py:106-110`) are populated on every stream start and only cleaned up when:

- a `finalize=True` `edit_message` succeeds, or
- `_emit_stream_error_delivery` runs (which only fires from `_request` exceptions inside `edit_message`).

If Hermes silently stops calling `edit_message` (gateway crash between deltas, model timeout that doesn't raise), the per-stream entries leak forever. Worse, `_stream_terminal_sent` keeps the stream ID poisoned so a subsequent edit on the same id would be silently dropped.

Add a TTL or LRU cap on these dicts (or `weakref` keyed by stream).

### 3. The "guaranteed terminal" contract is only as strong as Hermes calling `edit_message`

The doc's Workstream 3 explicitly raised this in Open Question #2: "Does iris-platform have enough hooks into Hermes to emit a guaranteed terminal delivery in all failure modes?" The implementation removed the stall watchdog without resolving the question. Today:

- Exception inside `edit_message._request` → terminal error emitted ✓
- Hermes calls `edit_message(finalize=True)` normally → finalize emitted ✓
- Hermes streaming pipeline crashes or is cancelled outside any `edit_message` call → **no terminal ever emitted, desktop spins forever** ✗

The third case is what the stall watchdog protected against. The right fix is upstream: have Hermes (or the iris-platform inbound `routes.py` Hermes-facing path that drives the stream) wrap the stream loop in `try/finally` and always trigger `edit_message(finalize=True)` or `_emit_stream_error_delivery`. The doc called this out under Workstream 3 step 2 — that change is not present in the diff.

At minimum, restore a much-larger inactivity timeout (60s+, not 8s) as a safety net per Open Question #2's suggestion. Without it, a single Hermes crash leaves a chat permanently stuck.

### 4. `coalesce_core_messages` dropped the content-equivalence guard

Old guard: `equivalent_message_content(prev, msg) AND is_gateway_replay_pair(prev, msg)`. New guard: only `is_gateway_replay_pair`, which matches on `clientRequestId` OR `streamMessageId` equality. This is *more* aggressive — any two consecutive assistant rows sharing either ID get coalesced even if their content differs.

In the normal flow this is fine because the streaming row and completed row always have related content. But if a row got corrupted upstream (or the v2-delta bug from issue #1 fires), the new code silently coalesces mismatched content rather than catching it. Consider keeping a sanity-check assert (or warning log) when contents diverge wildly — same cost, much better diagnostics.

### 5. Dead-ish code worth cleaning up

- `message_coalescer.stream_fallback_completion` (line 81) and `last_mergeable_assistant_message` (line 210) only matter when a delivery has `has_stream_id == False`. Under the v2 protocol every chunk carries `streamMessageId`, so these branches are effectively dead. Either delete them, or add a log-and-investigate path so you'd find out if they ever fire.
- `chatStreamMerging.appendBlockContent` (line 206) is only used by `coalescePostStreamAttachments`. That's fine but it's the lone survivor of the old reconciliation helpers — worth a comment that it's a different concern (joining attachment-rendered text to assistant text), not a stream merge.
- `mergeStreamDelivery` drops cron deliveries that happen to be `isStreamDelivery` (cron usually isn't streaming, but the asymmetry between `mergeStreamDelivery` and `mergeCompletedDelivery`'s cron carve-out is worth a one-line comment to make the intent explicit).

### 6. Test coverage gaps

The e2e suite is good, but the bugs above are exactly the things it does not cover. Recommended additions:

- Non-monotonic Hermes content into `edit_message` → assert receiver content is correct (currently would fail per issue #1).
- Stream started but never finalized → assert per-stream caches are bounded (issue #2).
- Hermes silently dies (no finalize, no error) → assert UI surfaces something within N seconds (issue #3 — currently nothing).
- Two assistant rows with same `clientRequestId` but different content → assert coalescer warns or refuses (issue #4).

---

## Summary

Workstreams 1, 2, 4, 5 are done well and the code is meaningfully simpler. Workstream 3 is **partially complete** — the happy path and HTTP-error path are solid, but the "Hermes silently dies" case (which was the original reason for the stall watchdog) isn't covered, and the per-stream caches have no abandoned-stream cleanup. Issue #1 (the `else: delta = clean_content` line) is the only place where the new design can silently produce wrong content; fix that and the rework is genuinely robust.

## Suggested order for follow-up

1. **Issue #1** — smallest, highest impact, eliminates the last source of silent content corruption.
2. **Issue #3** — restore a 60s safety-net timeout (or fix the underlying Hermes-side guarantee), then add the test for issue #6 case three.
3. **Issue #2** — bounded per-stream caches; can be done alongside issue #3 since both are iris-platform changes.
4. **Issue #4** — add a divergence-warning log to `coalesce_core_messages`.
5. **Issue #5** — code cleanup; can land in a single tidy PR after the above.
