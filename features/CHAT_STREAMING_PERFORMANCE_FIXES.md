# Chat Streaming Performance Fixes

Restore streaming hot-path latency after the durability rework. The Workstream 4 (Option B) change persisted the event bus to SQLite, which surfaced three latency sources that compound during a streaming assistant turn. This plan eliminates them without giving up the persistence we gained.

## Goal

Make a streamed assistant turn feel as snappy as it did before `CHAT_STREAMING_REWORK.md` landed — sub-50 ms from "iris-platform posts a delta" to "desktop renders the token" — while keeping the durable SQLite-backed `LiveDeliveryBus` from Workstream 4.

## Background

After the rework, users report responses take noticeably longer to appear. The model itself isn't slower; the infrastructure between Hermes and the desktop is. Three contributors, in order of impact:

1. **`CoreStore.connect()` opens a fresh SQLite connection plus four PRAGMAs on every event publish**, synchronously on the asyncio event loop. With 50–100 deltas per assistant turn, that's ~100–500 ms of pure setup overhead per turn, none of it visible in model output. While a publish runs, the SSE generator can't poll the bus (same event loop), so deliveries get bunched behind the writer.
2. **`_prune_stream_state` runs on every iris-platform `edit_message`** with O(n) dict scans up to 512 entries. Small per call, compounds across deltas.
3. **The SSE generator polls every 500 ms** (`asyncio.sleep(0.5)`). Pre-existing, but the SQLite write contention amplifies its effect — chunks land during a poll window and arrive at the desktop in a batch, or miss the window entirely when the writer is holding the loop.

Pre-rework the in-memory bus was a `deque.append` — microseconds, no lock contention with the SSE generator beyond the brief publish call. We need that hot-path cost back.

## Reference: files involved

- `iris-core/src/hermes_management_server/main.py`
  - `LiveDeliveryBus.publish` / `_publish_sqlite` (~102–183)
  - `LiveDeliveryBus._list_events_sqlite` / `_latest_cursor_sqlite` (~206–263)
  - `core_event_stream` SSE handler / `event_generator` (~1645–1680)
  - `runtime_delivery_hermes` (~1682–1787) — caller that runs `publish_core_event` synchronously inside the event loop
- `iris-core/src/hermes_management_server/core_store.py`
  - `CoreStore.connect` (~253–260)
- `iris-platform/adapter.py`
  - `edit_message` (~234–325), specifically the `self._prune_stream_state()` call at line 249
  - `_prune_stream_state` (~349–390)

---

## Workstream 1 — Stop opening a fresh SQLite connection per event

### Problem

`LiveDeliveryBus._publish_sqlite` and `_list_events_sqlite` both call `self.core_store.connect()` per invocation. Each call runs `sqlite3.connect()` plus four PRAGMA statements. The bus also holds a Python `RLock` for the full duration of connect → query → commit → close, which serializes against the SSE generator's reads.

### Target state

`LiveDeliveryBus` owns a small connection pool (or one connection per thread via `threading.local()`). PRAGMAs are set once at pool init. The hot path goes straight to `execute()` with no setup cost.

### Changes

1. **`LiveDeliveryBus.__init__`** (`main.py:93-100`): construct a connection-management object that hands out PRAGMA-initialized connections. Two reasonable shapes:
   - `threading.local()` field that lazily opens a connection on first use per thread (simplest).
   - A bounded pool (e.g. `queue.Queue` of 4 connections) acquired/released around each call.
   - Either way, PRAGMAs run exactly once per connection lifetime, not per event.
2. **`CoreStore`**: expose a `connect_pooled()` (or similar) entry point that the bus uses, distinct from `connect()` which other callers use for one-shot operations. Keep `connect()` unchanged for cold paths (migrations, one-off reads).
3. **`_publish_sqlite`** (`main.py:148`) and `_list_events_sqlite` (`main.py:206`) and `_latest_cursor_sqlite` (`main.py:248`): use the pooled connection instead of `self.core_store.connect()`.
4. **Lock scope**: holding `self._lock` around the SQLite call is no longer needed — SQLite's own locking with WAL is sufficient for the publish/read patterns we have. Drop the Python lock from the SQLite paths and keep it only on the in-memory deque path.

### Acceptance criteria

- A streaming turn of 100 deltas does not open more than 1–2 SQLite connections in total (verify with `lsof` or `sqlite3.connect` count).
- `_publish_sqlite` executes in <0.5 ms (excluding fsync) under no contention; measurable with a `perf_counter` benchmark in `test_api.py`.
- SSE generator's `list_events` calls do not block on concurrent publishes (verify with a stress test that pushes 200 events/s while reading).

### Risks

- `sqlite3` connections are not safe to share across threads without `check_same_thread=False` plus external serialization. The pool/thread-local approach must respect this — use `check_same_thread=False` on the pooled connections and rely on WAL + busy_timeout for write serialization.
- `with connection:` commits on exit. If we keep the same connection across many writes, we need explicit `commit()` calls and probably one-statement-per-transaction semantics so a crash mid-stream doesn't lose accumulated chunks.

---

## Workstream 2 — Move SQLite writes off the asyncio event loop

### Problem

`runtime_delivery_hermes` calls `publish_core_event` synchronously inside an async handler (`main.py:1769`). Whatever the SQLite write costs (even with Workstream 1's pooled connection), it costs that on the event loop thread. While it runs, the SSE generator can't tick, other inbound deliveries can't be processed, and any other async work pauses.

### Target state

The SQLite write happens on a worker thread (`asyncio.to_thread`) so the event loop stays responsive for the SSE generator and concurrent inbound deliveries.

### Changes

1. **`publish_core_event`** (or `LiveDeliveryBus.publish`): expose an `async` variant — e.g. `LiveDeliveryBus.publish_async` — that wraps the sync path in `asyncio.to_thread`. Keep the sync `publish` for callers that aren't on the event loop.
2. **`runtime_delivery_hermes`** (`main.py:1769`): switch to `await app.state.live_delivery_bus.publish_async(event_payload)`.
3. **Other publish call sites** in `main.py` (e.g. error paths around line 1485, 1521): audit each — if they're in async handlers, switch to the async variant.

### Acceptance criteria

- During a 100-delta streaming turn, the event loop does not block on SQLite for more than 1 ms per chunk (measurable with `loop.slow_callback_duration` warnings or a profiler).
- Concurrent SSE clients on different sessions do not visibly stutter while a high-volume stream is active.

### Dependencies

Should follow Workstream 1 — moving expensive work off the loop matters more, but the work itself should be cheap first.

---

## Workstream 3 — Stop pruning iris-platform stream state on every chunk

### Problem

`adapter.py:249` calls `self._prune_stream_state()` at the top of every `edit_message`. The implementation (`adapter.py:349-390`) does up to four full dict iterations plus repeated `min(... key=...)` calls (each O(n)) to evict over the 512-entry cap. Small per call, but it runs on every delta.

### Target state

Prune on a wall-clock cadence (every ~30 s) or every Nth call, not every chunk. The cache only needs to be bounded eventually, not synchronously per delta.

### Changes

1. **`adapter.py`**: track `self._last_prune_at` (float). Call `_prune_stream_state` at most once per N seconds (try 30) when entering `edit_message`. If the dicts exceed `STREAM_STATE_MAX_ENTRIES * 2`, prune immediately as a backstop (this only matters if something is leaking faster than the timer cadence).
2. **`_prune_stream_state`**: replace the `min(..., key=...)` LRU eviction loop with a single sort-by-timestamp + slice when the cap is exceeded. Same asymptotic cost as the current loop but only runs on the timer cadence.

### Acceptance criteria

- During a 100-delta streaming turn, `_prune_stream_state` runs at most twice (start + maybe once mid-stream if the turn spans >30s).
- Existing test `test_stream_state_is_pruned_and_finalize_cleans_active_request` still passes — update if needed to call `_prune_stream_state` explicitly rather than relying on the per-chunk call.

### Dependencies

Independent. Can land anytime.

---

## Workstream 4 — Wake the SSE generator on publish instead of polling

### Problem

`event_generator` in `main.py:1659-1674` has `await asyncio.sleep(0.5)` at the end of each iteration. Chunks that land mid-window arrive at the desktop in batches up to 500 ms behind the writer. This was tolerable when publishes were free (in-memory deque), but the SQLite write contention amplifies it — if the loop is doing back-to-back writes, the sleep window can stretch and the desktop gets visibly bursty output.

### Target state

The generator waits on an `asyncio.Event` that `publish_async` sets after each successful write. Deltas reach the desktop within milliseconds of being published. A short fallback poll (~2s) covers the rare case where an event was published but the generator missed the wake (defensive only).

### Changes

1. **`LiveDeliveryBus`**: hold an `asyncio.Event` (or one per session — keyed by `session_id`/`agent_id` if multiple SSE clients are common). `publish_async` calls `event.set()` after the write. The generator does `await event.wait()` with a 2-second timeout, then `event.clear()` and polls the bus.
2. **`event_generator`** (`main.py:1659`): replace `await asyncio.sleep(0.5)` with the event-wait pattern above. Keep the disconnect check.
3. **Heartbeat**: keep the existing 15-second keep-alive logic; just gate it on "no events seen in 15 seconds" rather than counting sleep iterations.

### Acceptance criteria

- Time from a `runtime_delivery_hermes` POST returning 200 to the corresponding SSE frame being yielded is <50 ms p50 (measurable with a small e2e timing test in `test_streaming_e2e.py`).
- A long idle SSE connection still receives the keep-alive comment line every ~15 s.

### Risks

- One global `asyncio.Event` means *every* SSE client wakes on *every* publish. For a single-user desktop that's fine; if you ever have many concurrent SSE consumers, per-session events are worth it. Keep it simple (single global Event) unless multi-client perf shows up as a problem.

### Dependencies

Workstream 2 should land first so the publish can synchronously call `event.set()` without dragging the event loop further.

---

## Suggested ordering

1. **Workstream 1** (pooled connections) — biggest single fix, smallest blast radius. Land first.
2. **Workstream 2** (off the event loop) — restores responsiveness under concurrent load. Land after 1 so the worker-thread work is already cheap.
3. **Workstream 4** (event-driven SSE) — eliminates the 500 ms batching. Best done after 2 so the publish that wakes the generator isn't blocking the loop.
4. **Workstream 3** (prune cadence) — small, independent. Land whenever convenient.

Workstreams 1, 2, and 4 can ship as a single PR if convenient — they share the same call sites and benchmark would apply to all three. Workstream 3 is a separate small change on the iris-platform side.

---

## How to confirm the diagnosis before starting

Quick sanity check that connection overhead is the actual cause:

1. In `main.py:766` (where `LiveDeliveryBus` is constructed), temporarily change `LiveDeliveryBus(core_store=core_store)` to `LiveDeliveryBus(core_store=None)`. This reverts the bus to the original in-memory deque path.
2. Restart Core and send a streaming message.
3. If responsiveness returns to pre-rework levels, the connection-per-event hot path is the primary cause and Workstreams 1+2 are the right fix.
4. Revert the change before doing anything else — running in-memory loses the durability we deliberately bought.

If revert *doesn't* fix it, the issue is somewhere else and we should profile before guessing. `python -m cProfile` against Core during a streaming turn, or a few `time.perf_counter()` spans around `_publish_sqlite`, `event_generator`'s sleep, and iris-platform's `edit_message`, will tell us.

---

## Non-goals

- Reworking the event bus protocol. The wire format and event types stay the same.
- Reverting any durability behavior. SQLite-backed events stay; we're only changing how they're written.
- Reworking the desktop side. All four workstreams are Core / iris-platform changes.
- Per-event retention/vacuum on `core_events`. Worth doing separately, but unrelated to latency.

## Open questions

1. **Connection-pool shape:** thread-local vs bounded queue. Thread-local is simpler if the SQLite calls always run on the same worker pool; bounded queue scales better if we ever have many concurrent write threads. For now, asyncio's default thread pool has a small number of workers — thread-local should be sufficient.
2. **Event granularity in Workstream 4:** one global `asyncio.Event` or per-session? Start with global; revisit only if multi-client perf becomes a real concern.
3. **Should `publish` itself become `async` everywhere**, or keep the sync version for non-asyncio callers (tests, migrations)? Suggest keeping both — `publish` (sync) and `publish_async` (awaitable wrapper). Tests can use either.
