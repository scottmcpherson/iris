# Hermes Source Of Truth Implementation Plan

## Implementation Status

Implemented in this checkout. Iris Core now uses adapter-backed reads for
Hermes agents, conversations, messages, and automations; live delivery events
use an in-memory bounded bus; Core SQLite defaults to `~/.iris/core.sqlite3`
and migrates/drops duplicate runtime-owned tables with backups; desktop Core
conversation detail/message calls preserve runtime identifiers.

## Goal

Refactor Iris Core so runtime-owned data is always read from the connected
runtime adapter. For the current local-first product, Hermes is the source of
truth for Hermes profiles, conversations, messages, jobs, models, command
catalogs, memory, skills, and execution state.

Iris Core should keep a stable normalized API for desktop and future clients,
but that API should be an adapter facade plus Core-owned overlays. It should
not maintain a second canonical copy of Hermes data in `~/.iris/core.sqlite3`.

The first production deployment runs Iris Core on the same machine as Hermes.
Because Core and Hermes are local peers, do not add conversation/message caches
for speed, offline access, or mobile sync in this phase. Network latency should
be negligible compared with agent execution time, and correctness is more
important than avoiding local reads.

## Product Principle

Provider-neutral means clients talk to one normalized Core API. It does not mean
Core owns every runtime's native records.

Runtime-owned facts should come from the runtime adapter every time:

- Agent/profile list and active/default state.
- Conversation list, titles, previews, source, model, timestamps, and counts.
- Conversation transcript messages.
- Job/automation list and job status.
- Runtime model catalog.
- Runtime slash command catalog and completion behavior.
- Runtime memory and skills files.
- Runtime execution state.

Core-owned facts may live in Core SQLite:

- Device pairing, token hashes, revocation, and last-seen timestamps.
- Core service settings and runtime connection records.
- Optional user overlays that do not exist in the runtime, such as future pins,
  local labels, app-specific sort overrides, or permission decisions.
- Short-lived delivery coordination needed to route an in-flight Hermes response
  to connected clients.

Derived/cache data should be avoided for conversations and transcripts. If a
future phase introduces a cache, it must be explicitly marked rebuildable,
disabled by default, scoped behind a feature flag, and never treated as the
source of truth.

## Current Problem

The current Core implementation stores a partial duplicate of Hermes data:

- `sidecar/src/hermes_management_server/core_store.py`
  - Creates `agents`, `conversations`, `conversation_runtime_links`,
    `message_events`, `conversation_messages`, and `automations` tables.
  - `sync_agents_from_profiles()` copies Hermes profile summaries into Core.
  - `upsert_runtime_conversation()` copies Hermes conversation metadata into
    Core.
  - `append_event()` and `upsert_message()` make Core a second transcript/event
    store.
  - `upsert_automation()` copies Hermes jobs into Core.

- `sidecar/src/hermes_management_server/main.py`
  - `/v1/conversations` calls `maybe_sync_core_conversations()` and then
    returns `core_store.list_conversations()`.
  - `/v1/conversations/{id}/messages` returns Core materialized messages first
    and only falls back to Hermes when Core has no messages.
  - `/v1/runtime-deliveries/hermes` appends Core events and materialized
    messages for Hermes deliveries.
  - `/v1/automations` syncs Hermes jobs into Core and then returns Core rows.

- `desktop/src/lib/hermes.ts`
  - Routes conversation and message reads through Core conversation endpoints.

This creates drift risk. After Core has a materialized transcript, Hermes is no
longer guaranteed to be the read source for that conversation. That is the
opposite of the desired source-of-truth model.

## Target Architecture

```text
Iris Desktop
  -> Iris Core /v1 normalized API
    -> RuntimeRegistry resolves adapter
      -> Hermes adapter reads Hermes source of truth
      -> Future OpenClaw/custom adapter reads its own source of truth
    -> Core applies only Core-owned overlays
```

Core remains the client-facing contract. Adapters own runtime reads and writes.

For Hermes:

```text
GET /v1/conversations
  -> resolve agent/profile
  -> HermesStore.conversations(profile)
  -> normalize to Iris conversation shape
  -> apply optional Core overlay fields
  -> return response

GET /v1/conversations/{id}/messages
  -> parse Iris conversation id into runtime id/profile/external id
  -> HermesStore.conversation_detail(profile, external_session_id)
  -> normalize Hermes messages
  -> return response

POST /v1/conversations/{id}/messages
  -> resolve runtime target
  -> send through Hermes adapter
  -> emit live delivery updates to connected clients only
  -> do not persist transcript messages in Core
```

## Identifier Model

Keep stable Iris-facing IDs without storing duplicate conversation rows.

### Agents

Derive Hermes agent IDs deterministically:

```text
agent_{stable_hash(runtime_id, profile)}_{profile_slug}
```

This is already available through `agent_id_for_profile()`. `GET /v1/agents`
should derive agents from `HermesStore.profiles()` on demand. It should not rely
on a persisted `agents` table.

For future non-Hermes runtimes, adapters must provide a stable external agent
identifier. Core can normalize that into an Iris agent ID with:

```text
agent_{stable_hash(runtime_id, external_agent_id)}_{slug}
```

### Conversations

Use deterministic Iris conversation IDs for runtime-known conversations:

```text
conv_{stable_hash(runtime_id, profile, external_conversation_id)}
```

For Hermes, `external_conversation_id` should be the Hermes session ID when a
session exists.

For a brand-new Iris-created chat before Hermes has written a session, use a
runtime chat ID as the temporary external ID:

```text
core-{uuid}
```

The Hermes adapter already receives `chatId`. Conversation discovery should
continue enriching Hermes sessions with origin/chat metadata so that once Hermes
persists the session, Core can return the deterministic ID derived from the
Hermes session and include the original `chatId`.

If a short-lived mapping is needed during an active send, keep it in memory in
the running Core process. Do not persist a permanent conversation row unless it
is a Core-owned overlay.

## Core Storage Location

Rename the Core data directory from:

```text
~/.agent-ui/
```

to:

```text
~/.iris/
```

The default Core database path should become:

```text
~/.iris/core.sqlite3
```

This rename should happen as part of the source-of-truth cleanup, not as a
separate later migration. New installs should create only `~/.iris/`. Existing
installs should migrate the Core-owned database data from `~/.agent-ui/` to
`~/.iris/`, then leave a timestamped backup of the old database before any
duplicate tables are dropped.

Update every default path and environment variable reference that implies
`.agent-ui`:

- `default_core_store_path()` should return `Path.home() / ".iris" / "core.sqlite3"`.
- Inbox/live delivery persistence should not keep using `~/.agent-ui/`.
- README and sidecar docs should refer to `~/.iris/`.
- Tests should assert the new default path where practical.

Keep environment variable overrides such as `IRIS_CORE_STORE` working. If an
override points at an explicit old `~/.agent-ui/core.sqlite3` path, respect the
override and do not silently move that custom path.

## Core SQLite Target Schema

Keep or add only Core-owned tables.

### Keep

```text
schema_meta
devices
runtimes
device_cursors
```

`device_cursors` may remain for Core-owned notification/event streams. It should
not be required for conversation history because conversation history comes from
the runtime.

### Replace With Overlays Only If Needed

```text
agent_overlays
conversation_overlays
automation_overlays
```

Do not create these in the first cleanup unless the UI currently needs a field
that Hermes cannot provide. If added, they must contain only app-owned fields:

```text
runtime_id text not null
runtime_profile text not null
external_id text not null
favorite integer
local_title_override text
metadata_json text not null
updated_at integer not null
primary key(runtime_id, runtime_profile, external_id)
```

They must not store transcript content, previews, message counts, runtime
status, or full runtime job payloads.

### Remove Or Stop Using

```text
agents
conversations
conversation_runtime_links
message_events
conversation_messages
automations
```

These tables currently duplicate runtime-owned data. The cleanup should either
drop them during migration or leave them ignored after copying any true
Core-owned fields into overlay tables.

## Endpoint Behavior Changes

### `GET /v1/agents`

Current behavior:

- Seeds/syncs Hermes profiles into Core `agents`.
- Returns rows from Core SQLite.

Target behavior:

- Resolve enabled runtimes from Core `runtimes`.
- For each runtime, call `adapter.list_agents()`.
- For Hermes, derive the list from `HermesStore.profiles()`.
- Return normalized agents directly.
- Do not write agent rows to SQLite.

Implementation notes:

- Update `RuntimeRegistry.agents()` to return adapter-derived agents.
- Remove the 10-second `_last_agent_sync_at` cache or make it request-local
  only if profiling proves it matters.
- Keep `RuntimeRegistry.agent(agent_id)` as a lookup over derived agents.

### `GET /v1/conversations`

Current behavior:

- Syncs Hermes conversations into Core `conversations`.
- Returns stored Core rows.

Target behavior:

- Validate `agentId`.
- Resolve agent to runtime/profile.
- Call `adapter.list_conversations(agent)`.
- For Hermes, call `HermesStore.conversations(profile, limit)`.
- Normalize each Hermes conversation into the existing `AgentUICoreConversation`
  response shape.
- Apply Core overlays only if overlay tables exist.
- Return runtime-backed data.

Important:

- The `cursor` query parameter is currently ignored. Keep it ignored or remove
  it from the frontend call until the runtime adapter can provide pagination.
- Do not call `maybe_sync_core_conversations()`.
- Delete `sync_core_conversations()` after callers are migrated.

### `POST /v1/conversations`

Current behavior:

- Creates a persistent Core conversation row and runtime link.

Target behavior:

- Do not create a persisted Core conversation.
- Return a lightweight runtime draft conversation target:

```json
{
  "id": "conv_<hash of runtime/profile/chatId>",
  "agentId": "agent_...",
  "title": "New conversation",
  "externalSessionId": "",
  "externalChatId": "core-<uuid>",
  "runtimeId": "runtime_local_hermes",
  "runtimeProfile": "default",
  "metadata": {
    "draft": true,
    "createdBy": "iris-core"
  }
}
```

- If the request includes `externalSessionId`, return a deterministic ID for
  that runtime conversation and do not persist a copy.
- If the request includes `externalChatId`, use it as the draft routing key.

The draft exists to route the next send. Hermes becomes canonical after it
creates or updates its session.

### `GET /v1/conversations/{conversation_id}`

Current behavior:

- Reads Core `conversations`.

Target behavior:

- Decode or resolve the Iris conversation ID.
- For Hermes session-derived IDs, call Hermes conversation detail or list lookup.
- For draft/chat-derived IDs, return a draft response only if an in-memory
  active-send record exists. Otherwise return `404` and let the client refresh
  the conversation list from Hermes.

To avoid fragile reverse hashing, include enough metadata in desktop state to
call detail by `externalSessionId` or `externalChatId`. The Core API can also
accept optional query params later:

```text
GET /v1/conversations/{id}?externalSessionId=...&externalChatId=...
```

For this cleanup, prefer changing desktop detail calls to use the runtime IDs
already available on the selected conversation object.

### `GET /v1/conversations/{conversation_id}/messages`

Current behavior:

- Returns `conversation_messages` first.
- Falls back to Hermes only if Core has no materialized messages.

Target behavior:

- Always read transcript messages from the runtime adapter.
- For Hermes, call `HermesStore.conversation_detail(profile, externalSessionId)`.
- If only `externalChatId` is known, resolve the current Hermes session by
  scanning Hermes conversations for matching `origin.chatId`.
- Return normalized messages.
- Do not read `conversation_messages`.

### `POST /v1/conversations/{conversation_id}/messages`

Current behavior:

- Appends Core user event.
- Upserts Core user message.
- Sends to Hermes.
- Hermes delivery later appends Core assistant events/messages.

Target behavior:

- Do not persist user or assistant messages in Core.
- Send to Hermes through the adapter.
- Maintain a short-lived in-memory active request map:

```text
request_id -> runtime_id, profile, chat_id, connected client stream ids
```

- Live Hermes deliveries should be pushed to connected desktop clients through
  SSE or short polling from this in-memory delivery buffer.
- After completion, the desktop refreshes detail from Hermes source of truth.

If persistent replay is removed, event replay after process restart is no longer
guaranteed. That is acceptable for this phase because Core is local to Hermes and
conversation history is read from Hermes.

### `GET /v1/events` And `GET /v1/events/stream`

Current behavior:

- Reads persisted `message_events` by cursor.

Target behavior:

- Events are live delivery events only.
- Use an in-memory ring buffer per agent/profile/chat with a small bounded size,
  for example the last 500 delivery events or 15 minutes.
- Cursors are process-local and best-effort.
- On missed events, clients reconcile by loading messages from Hermes.

This keeps streaming responsive without making Core a transcript database.

### `POST /v1/runtime-deliveries/hermes`

Current behavior:

- Resolves/creates Core conversation rows.
- Appends Core events.
- Upserts Core messages.

Target behavior:

- Validate runtime delivery token.
- Normalize the delivery.
- Publish to the in-memory live delivery bus.
- Do not create Core conversations.
- Do not write `message_events` or `conversation_messages`.
- Include `runtimeId`, `profile`, `chatId`, `messageId`, `replyTo`, `source`,
  `content`, and metadata so clients can merge the active stream.

### `GET /v1/automations`

Current behavior:

- Syncs Hermes jobs into Core `automations`.
- Returns stored Core rows.

Target behavior:

- Call `adapter.list_automations(profile)`.
- For Hermes, call Hermes Jobs API.
- Normalize job records to the existing response shape.
- Do not store full job records in Core.

Create/update/delete/pause/resume/run should call the adapter and then return
the adapter's current job representation. If Core needs future app-only fields,
store those in `automation_overlays`, not in a duplicate `automations` table.

## Adapter Interface Changes

Add explicit runtime-source methods instead of hiding source reads inside Core
store sync functions:

```python
class RuntimeAdapter:
    def list_agents(self) -> list[dict]: ...
    def get_agent(self, agent_id: str) -> dict | None: ...
    def list_conversations(self, agent: dict, limit: int = 80) -> list[dict]: ...
    def get_conversation(self, agent: dict, external_id: str, chat_id: str = "") -> dict | None: ...
    def get_conversation_messages(self, agent: dict, external_id: str, chat_id: str = "") -> list[dict]: ...
    def send_message(self, agent: dict, target: dict, message: dict) -> dict: ...
    def cancel_message(self, agent: dict, target: dict) -> dict: ...
    def list_automations(self, agent: dict) -> list[dict]: ...
    def create_automation(self, agent: dict, automation: dict) -> dict: ...
    def update_automation(self, agent: dict, external_id: str, updates: dict) -> dict: ...
    def delete_automation(self, agent: dict, external_id: str) -> dict: ...
    def control_automation(self, agent: dict, external_id: str, action: str) -> dict: ...
```

For Hermes, implement these by composing:

- `HermesStore.profiles()`
- `HermesStore.conversations(profile, limit)`
- `HermesStore.conversation_detail(profile, session_id)`
- `HermesRuntimeAdapter.send_message(...)`
- Hermes Jobs API through `HermesRuntimeAdapter.jobs_request(...)`
- Existing model/slash command adapter endpoints.

## Desktop Changes

Update `desktop/src/lib/agentuiCore.ts` and `desktop/src/lib/hermes.ts` so the
frontend carries runtime identifiers from list responses through detail/send
calls.

Required data to preserve on conversation objects:

- `id`
- `runtimeId`
- `runtimeProfile`
- `externalSessionId`
- `externalChatId`
- `origin`

`getHermesConversationDetail()` should be able to request detail using
`externalSessionId` or `externalChatId` when a Core deterministic ID alone is
not enough to reverse-map.

`useHermesChat.ts` should keep optimistic local messages while a send is active,
but completed history should reconcile from Hermes, not from Core materialized
messages.

Remove any frontend assumptions that `/v1/events` is durable history. Treat it
as live delivery only.

## Database Cleanup

Add a migration path for existing `~/.agent-ui/core.sqlite3`.

### Safety Rules

- Back up the existing database before destructive cleanup.
- Never delete `devices`, `runtimes`, `device_cursors`, or `schema_meta`.
- Do not delete Hermes data under `~/.hermes`.
- Do not require users to manually remove the database.
- The migration should be idempotent.
- Migrate the default Core database location from `~/.agent-ui/core.sqlite3` to
  `~/.iris/core.sqlite3` before dropping duplicate tables.
- Do not migrate explicit custom paths supplied through `IRIS_CORE_STORE` or
  `AGENTUI_CORE_STORE`; for custom paths, clean up the database in place.

### Backup

Before schema cleanup:

```text
~/.iris/core.sqlite3.backup-before-source-of-truth-<timestamp>
```

Use SQLite backup APIs or a filesystem copy after closing active connections.
For default-path migrations, also leave a pre-migration copy at:

```text
~/.agent-ui/core.sqlite3.backup-moved-to-iris-<timestamp>
```

After the move succeeds, Core should read and write only `~/.iris/core.sqlite3`.

### Cleanup Strategy

Implement `CoreStore.migrate_source_of_truth_schema()`:

1. Resolve the Core database path.
2. If using the default path and `~/.agent-ui/core.sqlite3` exists while
   `~/.iris/core.sqlite3` does not, create `~/.iris/`, copy the database there,
   and leave the old file as a timestamped backup.
3. Ensure `schema_meta.source_of_truth_migration = pending|complete`.
4. Create replacement overlay tables only if the implementation needs them.
5. Copy any app-owned fields from old tables into overlays.
6. Drop duplicate runtime-owned tables:

```sql
drop table if exists agents;
drop table if exists conversations;
drop table if exists conversation_runtime_links;
drop table if exists message_events;
drop table if exists conversation_messages;
drop table if exists automations;
```

7. Recreate only the kept Core-owned tables if missing:

```text
schema_meta
devices
runtimes
device_cursors
```

8. Set:

```text
schema_meta.schema_version = 2
schema_meta.source_of_truth_migration = complete
```

### CLI/Manual Cleanup Command

Add a sidecar CLI command:

```bash
agentui-core migrate-source-of-truth --backup
```

or, if keeping the current CLI shape:

```bash
hermes-management-server migrate-source-of-truth --backup
```

The command should print:

- Core database path.
- Backup path.
- Tables dropped.
- Tables preserved.
- Migration status.

### Startup Behavior

On Core startup:

- Run the migration automatically unless disabled by:

```text
IRIS_CORE_DISABLE_SOURCE_OF_TRUTH_MIGRATION=1
```

- If migration fails, do not silently continue using duplicate tables.
- Return a clear health/status warning and keep old data untouched.

## Implementation Phases

### Phase 1: Runtime-Backed Read Paths

Files:

- `sidecar/src/hermes_management_server/runtime_registry.py`
- `sidecar/src/hermes_management_server/runtime_adapters/hermes.py`
- `sidecar/src/hermes_management_server/main.py`
- `sidecar/src/hermes_management_server/core_store.py`
- `sidecar/tests/test_api.py`
- `sidecar/tests/test_core_store.py`

Work:

- Add adapter-backed `list_agents`, `list_conversations`,
  `get_conversation_messages`, and `list_automations`.
- Change `/v1/agents`, `/v1/conversations`, conversation detail, messages, and
  automations to use adapters directly.
- Stop calling `sync_agents_from_profiles()`, `maybe_sync_core_conversations()`,
  `sync_core_conversations()`, and `sync_core_automations()` from read routes.
- Keep old methods temporarily for migration tests, then delete them when no
  callers remain.

Acceptance criteria:

- Creating/deleting/renaming a Hermes profile is reflected in `/v1/agents`
  without stale Core rows.
- Creating/deleting/updating a Hermes session is reflected in
  `/v1/conversations` without writing Core conversation rows.
- A conversation with Core materialized messages still loads transcript content
  from Hermes after the change.
- Hermes job changes appear in `/v1/automations` without Core automation sync.

### Phase 2: Live Delivery Without Persistent Transcript Duplication

Files:

- `sidecar/src/hermes_management_server/main.py`
- `sidecar/src/hermes_management_server/core_store.py`
- `agentui-platform/adapter.py`
- `desktop/src/features/chat/useHermesChat.ts`
- `desktop/src/lib/agentuiCore.ts`

Work:

- Add an in-memory delivery bus/ring buffer to the FastAPI app state.
- Update `/v1/runtime-deliveries/hermes` to publish live events only.
- Update `/v1/events` and `/v1/events/stream` to read the in-memory bus.
- Remove `append_event()` and `upsert_message()` calls from send and delivery
  paths.
- Make desktop reconcile completed active chats by reloading Hermes detail.

Acceptance criteria:

- Streaming still appears in the desktop chat.
- Refreshing a completed conversation reloads the Hermes transcript.
- Restarting Core does not lose conversation history because history comes from
  Hermes.
- No new rows are written to `message_events` or `conversation_messages`.

### Phase 3: Database Migration And Cleanup

Files:

- `sidecar/src/hermes_management_server/core_store.py`
- `sidecar/src/hermes_management_server/main.py`
- `sidecar/tests/test_core_store.py`
- `sidecar/README.md`

Work:

- Add schema version 2 migration.
- Add backup-before-drop behavior.
- Drop duplicate tables.
- Preserve `devices`, `runtimes`, `device_cursors`, and `schema_meta`.
- Add CLI or startup migration path.
- Document the migration and rollback.

Acceptance criteria:

- Existing `~/.agent-ui/core.sqlite3` is backed up.
- Default Core storage moves to `~/.iris/core.sqlite3`.
- New installs do not create `~/.agent-ui/`.
- Duplicate tables are removed or empty/unused after migration.
- Device pairing and runtime configuration continue working.
- Core health reports schema version 2.
- Re-running the migration is safe.

### Phase 4: Remove Dead Code And Tests

Files:

- `sidecar/src/hermes_management_server/core_store.py`
- `sidecar/src/hermes_management_server/main.py`
- `sidecar/tests/*`
- `features/AGENT_UI_CORE_API.md`

Work:

- Delete unused sync/materialization helpers.
- Update tests that asserted Core-owned conversation/message persistence.
- Add tests that assert adapter-backed reads.
- Add a short note to the old Core API plan pointing at this corrective doc.

Acceptance criteria:

- No code path reads conversation history from Core duplicate tables.
- No code path writes Hermes transcript or job records into Core SQLite.
- Tests fail if a future change reintroduces persistent transcript duplication.

## Test Plan

Backend:

```bash
npm run sidecar:test
```

Add tests for:

- `/v1/agents` reflects Hermes profile changes without stored `agents`.
- `/v1/conversations` reflects Hermes SQLite/session JSON changes without
  stored `conversations`.
- `/v1/conversations/{id}/messages` always calls Hermes detail, even when old
  Core duplicate tables exist in a pre-migration test database.
- `/v1/runtime-deliveries/hermes` publishes live events but does not write
  `message_events` or `conversation_messages`.
- `/v1/automations` returns adapter job data without stored `automations`.
- Migration backs up and drops duplicate tables while preserving devices and
  runtimes.

Desktop:

```bash
npm --workspace desktop run test
npm --workspace desktop run build
```

Add/update tests for:

- Conversation detail request carries runtime/session identifiers.
- Active optimistic messages reconcile from Hermes detail after completion.
- Live event polling/SSE is treated as best-effort delivery, not durable
  history.

Full repo:

```bash
npm run check
```

Final app verification for any visible chat behavior change:

```bash
npm run build:mac:app
```

Then launch the fresh app bundle and test through Computer Use against:

```text
com.nousresearch.hermes-agent.desktop
```

## Manual Verification

Use a real local Hermes profile.

1. Start Core and Hermes.
2. Open desktop app.
3. Send a message in a Hermes-backed chat.
4. Confirm streaming appears.
5. Confirm the completed transcript is visible.
6. Stop Core.
7. Start Core again.
8. Confirm the completed transcript still appears from Hermes.
9. Inspect Core SQLite:

```bash
sqlite3 ~/.iris/core.sqlite3 ".tables"
sqlite3 ~/.iris/core.sqlite3 "select * from schema_meta;"
```

Expected:

- No `conversations` table.
- No `conversation_messages` table.
- No `message_events` table.
- No `automations` table.
- No `agents` table unless it has been replaced by a clearly named overlay
  table that stores only Core-owned metadata.

Also inspect Hermes:

```bash
sqlite3 ~/.hermes/state.db "select count(*) from sessions; select count(*) from messages;"
```

Expected:

- Hermes remains untouched except through supported Hermes interfaces.
- Hermes contains the canonical session/message history.

## Rollback

If migration causes issues:

1. Stop Core.
2. Restore the backup:

```bash
cp ~/.iris/core.sqlite3.backup-before-source-of-truth-<timestamp> ~/.iris/core.sqlite3
```

3. Start Core with migration disabled:

```bash
IRIS_CORE_DISABLE_SOURCE_OF_TRUTH_MIGRATION=1 npm run dev
```

Rollback restores the old duplicate Core data, but that data should be treated
as a temporary recovery path, not the desired architecture.

## Open Questions

- Should `/v1/conversations/{id}` grow query parameters for `externalSessionId`
  and `externalChatId`, or should desktop always pass a richer request object to
  message/detail endpoints?
- Should short-lived live delivery buffers be global, per agent, or per
  `profile/chatId`?
- Should Core keep any automation overlay fields now, or should all automation
  fields come directly from Hermes Jobs until a specific app-owned field exists?
- Should the old `/v1/profiles/{profile}/conversations` Hermes-direct endpoints
  remain as compatibility aliases after `/v1/conversations` becomes
  adapter-backed?
