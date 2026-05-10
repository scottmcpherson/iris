# Iris Code Quality Audit — 2026-05-10

Scope: `iris-core/` (FastAPI server), `iris-platform/adapter.py`, `desktop/src-tauri/` (Rust + Python bridge), `desktop/src/` (React/TS frontend).

This was a static read-only audit; no code was changed.

---

## Headline findings

| # | Severity | Area | Issue |
|---|----------|------|-------|
| 1 | High | iris-core | God-file `main.py` is 2,942 lines mixing routing, business logic, MIME handling, auth, coalescing |
| 2 | High | iris-core | `LiveDeliveryBus` (`main.py:82-145`) uses an unlocked `deque` and non-atomic cursor — race conditions under concurrent publish/read |
| 3 | High | iris-core | Catch-all `@app.exception_handler(Exception)` (`main.py:775-777`) returns "Internal server error" with no logging — operators are blind |
| 4 | High | iris-core | `core_store.py` swallows `(OSError, ValueError, JSONDecodeError)` silently in multiple write paths (e.g. lines 1041-1045, 1066-1072) |
| 5 | High | iris-platform | `adapter.py` `_request()` (lines 455-480) uses synchronous `urllib.request.urlopen(timeout=8)` from async handlers — blocks event loop |
| 6 | High | desktop CSS | `App.css` is 5,852 lines / ~104 KB with 976 selectors, no modularization |
| 7 | High | desktop TS | `useIrisChat.ts` is 1,805 lines with 13+ `useState` hooks plus parallel ref mirrors — single hook handles streaming, history, attachments, model selection |
| 8 | High | desktop Rust | `lib.rs:129` panics via `.expect()` on `tauri::generate_context!()` — unrecoverable startup failure |
| 9 | High | desktop config | `tauri.conf.json:32` CSP includes `'unsafe-eval'` and permissive `frame-src 'self' data: blob:` |
| 10 | Med | iris-core | Unbounded `asyncio.to_thread()` (~50 call sites) — slow Hermes gateway can spawn unbounded threads |

---

## A. `iris-core/` (FastAPI management server)

### Structure
- `main.py` — 2,942 lines, ~165 route handlers + `LiveDeliveryBus` + factories
- `core_store.py` — 1,545 lines, SQLite persistence
- `models.py` — 250 lines, Pydantic schemas
- `security.py` — 87 lines, auth + device token hashing
- `runtime_registry.py` — 70 lines
- `runtime_adapters/*` — 2,439 lines across 3 files

### Concurrency / correctness
- **Live delivery race:** [`main.py:82-145`](iris-core/src/hermes_management_server/main.py#L82) — `LiveDeliveryBus._events` is a plain `deque`; `_cursor` is incremented without a lock. Two concurrent publishers can collide on the same cursor.
- **Sync SQLite under async FastAPI:** `core_store.connect()` uses a blocking context manager. With default `journal_mode=DELETE`, one slow query blocks all writers. Either move to `aiosqlite` or wrap in a bounded thread pool with timeouts.
- **Unbounded thread pool:** ~50 `asyncio.to_thread(adapter.*)` call sites, no semaphore, no per-call timeout. A wedged Hermes gateway will leak threads/FDs until exhaustion.

### Error handling
- **Catch-all handler** ([`main.py:775-777`](iris-core/src/hermes_management_server/main.py#L775)) returns generic 500 with no logging.
- **Silent excepts** in `core_store.py` (e.g. lines 1041-1045, 1066-1072) drop disk-full and JSON-decode errors with no logging — the SQL transaction may still commit a partial write.

### Validation / DoS
- `conversation_read_states()` ([`core_store.py:672-687`](iris-core/src/hermes_management_server/core_store.py#L672)) is parameterized but unbounded — a 100k-id `IN (...)` clause is a self-DoS.
- No rate limiting on `/v1/attachments` upload ([`main.py:802`](iris-core/src/hermes_management_server/main.py#L802)).
- Device pairing ([`main.py:919-933`](iris-core/src/hermes_management_server/main.py#L919)) accepts arbitrary metadata with no schema.
- `security.py:27-28` hashes device tokens with bare SHA256; consider HMAC or salting.

### Idempotency gap
- [`main.py:1503-1511`](iris-core/src/hermes_management_server/main.py#L1503) treats absent `clientMessageId` as "generate random", so two retries without an ID become two messages. Either require the ID or document the behavior.

### Code smell
- **Message coalescing** at lines 2716-2883 in `main.py` is 167 lines, 5+ levels of nesting — extract a `MessageCoalescer` class so it can be tested independently.
- **Duplicated MIME normalization** between `main.py:250-294` and `core_store.py` (slightly divergent ZIP handling) — consolidate.

### Tests
- `tests/test_api.py` covers happy-path endpoints well.
- **Gaps:** no concurrency tests for `LiveDeliveryBus`, no negative tests for oversized payloads, no integration tests for concurrent attachment + delivery.

---

## B. `iris-platform/adapter.py` (Hermes plugin)

- **Oversized:** 1,064 lines covering HTTP routing, credential management, slash command discovery, model catalog, and attachment normalization. Split into `routes.py`, `credentials.py`, `discovery.py`, `attachments.py`.
- **Blocking I/O on async runtime:** [`adapter.py:455-480`](iris-platform/adapter.py#L455) uses sync `urllib.request.urlopen(timeout=8)`; called from `connect()` ([line 97](iris-platform/adapter.py#L97)), model catalog handlers ([line 348+](iris-platform/adapter.py#L348)), and inbound dispatch. Migrate to `aiohttp.ClientSession`.
- **Bare `except Exception`** at lines 107, 274, 396, 423, 471, 587, 593, 599, 605, 627, 676, 693, 1031 — swallows `CancelledError` and timeouts, hides retries.
- **Tests:** no visible suite for the adapter.

---

## C. `desktop/src-tauri/` (Rust + Python bridge)

| Location | Issue |
|----------|-------|
| [`lib.rs:129`](desktop/src-tauri/src/lib.rs#L129) | `.expect("error while running tauri application")` — unrecoverable startup panic |
| [`core_bridge.py:54`](desktop/src-tauri/python/core_bridge.py#L54) | Bare `except Exception` at the entry point swallows `SystemExit` and breaks debuggability |
| [`tauri.conf.json:32`](desktop/src-tauri/tauri.conf.json#L32) | CSP `script-src 'unsafe-eval'` and `frame-src 'self' data: blob:` are broader than necessary |

Positives:
- `lib.rs` runs the Python subprocess via `spawn_blocking()` — correct.
- `capabilities/default.json` is minimal (`core:default`, `core:window:*`, `opener:default`).
- `test_core_bridge.py` covers credential and request paths, but not audio transcoding, multipart upload, or error paths.

---

## D. `desktop/src/` (React / TypeScript)

### Sizing
- `App.css` — **5,852 lines / ~104 KB**, 976 selectors, 10 distinct media queries, no modularization.
- `layout/AppShell.tsx` — ~74 KB, ~2,000 lines, 40+ props passed to children (prop drilling).
- `features/chat/useIrisChat.ts` — 1,805 lines, 13+ `useState` hooks plus parallel `useRef` mirrors.
- `features/chat/ChatView.tsx` — 1,198 lines.
- `App.tsx` (~25 KB), `lib/agentuiCore.ts` (~25 KB), `lib/irisRuntime.ts` (~21 KB).

### React-specific smells
- **Stale-closure event listeners** in [`App.tsx:100-116`](desktop/src/App.tsx#L100): `listen()` callbacks capture old state; cleanup is `void unlisten?.then(...)` — not awaited, racy on unmount.
- **Derived state stored in `useState`** in `useIrisChat.ts` (`conversations`, `conversationsLoading`, `historyError` — lines 95-97) instead of memoization.
- **Inefficient counters:** `hasActiveRequest = Object.keys(activeRequestIdsByConversation).length > 0` (line 108) recomputes on every render — track a count instead.
- **Unstable list keys:** several `key={index}` patterns in `ChatView.tsx`; should use `message.id`.
- **Missing memoization** on sidebar conversation merge in [`App.tsx:156-164`](desktop/src/App.tsx#L156) — recomputes on every render even when inputs are unchanged.

### Type safety
- ~20+ `Record<string, unknown>` payloads in `lib/agentuiCore.ts` (lines 22, 32, 37, 46, 58, 69, 84, 101, 122-123) — the new `any`. Replace with discriminated unions / Zod schemas.
- Very few raw `any` (good).

### Tests
- `__tests__/` directories exist for `app/`, `lib/`, `layout/`, `features/chat/MessageContent` but no integration coverage of `useIrisChat`, `ChatView`, attachment uploads, or EventSource reconnection.

### Recommendations (priority order)
1. Break `App.css` into per-feature CSS modules + a tokens file.
2. Decompose `useIrisChat` into `useConversationHistory`, `useChatEventStream`, `useChatInput`; consider Zustand/Jotai to drop the ref-mirror state.
3. Replace `Record<string, unknown>` API payloads with codegen-derived types or runtime schemas.
4. Fix listener cleanup in `App.tsx` (await `unlisten` in `useEffect`).
5. Add tests for `useIrisChat` reconnection, model selection, and attachment flows.

---

## Suggested fix order (cross-cutting)

1. **Lock the delivery bus** and add structured logging to the catch-all exception handler in `iris-core/main.py` — these are the riskiest correctness gaps.
2. **Replace blocking `urllib` in `iris-platform/adapter.py`** with an async HTTP client — fixes a latent event-loop stall under load.
3. **Bound `asyncio.to_thread()`** with a semaphore + per-call timeout, and harden `core_store.py` write paths with explicit logging.
4. **Tighten Tauri CSP** (drop `'unsafe-eval'`, narrow `frame-src`) and replace the `lib.rs:129` `.expect()` with a graceful failure.
5. **Decompose the largest hotspots** — `main.py`, `useIrisChat.ts`, `App.css`, `AppShell.tsx`, `adapter.py` — in that order.

---

*Generated by scheduled task `iris-code-audit` on 2026-05-10. Read-only static review; no code changes were made.*
