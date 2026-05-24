# Hermes Memory Revision History

## Goal

Make the redesigned Agents -> Memory tab work end to end with Hermes-backed memory files, including revision history for Iris-initiated edits and resets.

End state:

1. The Memory tab loads `MEMORY.md`, `USER.md`, and recent revisions for the selected agent/profile.
2. Saving either memory file creates a snapshot of the previous on-disk file before Iris overwrites it.
3. Resetting one file or all memory creates snapshots of any files that exist before Iris deletes them.
4. The revision history UI in `apps/desktop/src/features/memory/MemoryView.tsx` receives real `HermesMemory.history` entries and can render the existing revision list and diff.
5. Iris does not claim to have a complete audit log of all Hermes-authored memory updates. The first implementation is an Iris-managed safety history.
6. Profile-scoped memory data cannot be overwritten by the globally selected profile state while viewing a different agent detail route.

## Product Contract

Revision history should be framed as **Iris-managed snapshots**, not a complete Hermes memory audit log.

Iris should snapshot the file that is on disk immediately before Iris mutates it. This means:

- If Hermes updated `MEMORY.md` earlier, and the user later saves from Iris, Iris snapshots the Hermes-updated current file before writing.
- If Hermes updates a file and Iris never writes or resets it, Iris does not necessarily create a revision entry.
- If the user loaded stale memory and the file changed before save, Iris should block the save with a refresh-required conflict instead of snapshotting and overwriting.
- Reset operations are destructive, so they should snapshot the current file before unlinking it.

Do not word the UI as "complete history" or "all agent memory changes" unless a future implementation adds filesystem watching or Hermes-side event ingestion.

Recommended user-facing framing:

- "Revision history"
- "Saved snapshots"
- "Snapshots are saved before Iris edits or resets memory."

Avoid:

- "Complete history"
- "All Hermes memory writes"
- "Every agent memory change"

## Current Repo State

Primary Desktop files:

- `apps/desktop/src/features/memory/MemoryView.tsx`
  - Already renders the redesigned memory surface.
  - Expects `memory.history` to contain entries.
  - Filters entries by `entry.file === "MEMORY.md"` or `entry.file === "USER.md"`.
  - Renders `entry.action`, `entry.summary`, `entry.updatedAt`, `entry.bytes`, and `entry.content`.
  - Diffs `selectedHistory.content` against the current active file content.
  - Reset dialog currently promises "after saving a revision snapshot", so Core must make that true.
- `apps/desktop/src/types/hermes.ts`
  - Defines:
    - `HermesMemoryFile`
    - `HermesMemoryHistoryEntry`
    - `HermesMemory`
  - Current `HermesMemoryHistoryEntry.action` is `"save" | "reset"`.
- `apps/desktop/src/lib/query/memory.ts`
  - Uses `memoryKeys.agent(runtimeKey, profile)`.
  - Mutations already update and invalidate the profile-specific memory query.
- `apps/desktop/src/lib/irisRuntime.ts`
  - Resolves profile -> Core agent -> Core memory endpoints.
- `apps/desktop/src/App.tsx` and `apps/desktop/src/features/iris/useIrisRuntime.ts`
  - Still keep one `iris.memory` value tied mostly to `selectedProfile`.
  - Agent detail routes can view `agentDetailProfile`, which may differ from `iris.selectedProfile`.
  - This is a correctness risk for the redesigned profile-specific memory tab.

Primary Core files:

- `iris-core/src/hermes_management_server/main.py`
  - Exposes:
    - `GET /v1/agents/{agent_id}/memory`
    - `PUT /v1/agents/{agent_id}/memory/{file}`
    - `DELETE /v1/agents/{agent_id}/memory/{file}`
  - Save/reset responses already return `{"ok": true, "profile": ..., "memory": ...}`.
- `iris-core/src/hermes_management_server/runtime_adapters/base.py`
  - Defines the memory methods in the runtime adapter protocol.
- `iris-core/src/hermes_management_server/runtime_adapters/hermes.py`
  - `agent_memory()` returns `history: []` today.
  - `save_agent_memory()` delegates to `HermesStore.save_memory_file()`.
  - `reset_agent_memory()` delegates to `HermesStore.reset_memory_file()`.
- `iris-core/src/hermes_management_server/runtime_adapters/hermes_store.py`
  - Reads and writes `~/.hermes/<profile>/memories/MEMORY.md` and `USER.md`.
  - Uses `expected_updated_at` second-level mtime for save conflict detection.
  - Reset currently just unlinks files.
- `iris-core/src/hermes_management_server/core_store.py`
  - Owns Core SQLite at `~/.iris/core.sqlite3`.
  - Has `CORE_SCHEMA_VERSION = 7`.
  - Contains schema creation, migrations, helper methods, and row mappers.

Hermes plugin:

- `iris-platform/routes.py`
  - Inbound routes only cover health, models, slash commands, slash completion, and messages.
  - Memory history should not require Hermes plugin changes in the first implementation.

## Architecture Decision

Store revision snapshots in Iris Core SQLite, not inside Hermes memory files.

Rationale:

- Revision snapshots are an Iris safety feature, not Hermes source-of-truth data.
- Core runs on the machine that owns Hermes for both local and SSH setups, so Core can snapshot local-to-Core files safely.
- Desktop should not read or write Hermes files directly.
- Keeping snapshots in Core avoids adding extra files under `~/.hermes` that Hermes might interpret or sync.

The snapshot table should be Core-owned. Add it to `CORE_OWNED_TABLES`.

Do not add a Hermes plugin route for revision history unless Hermes later exposes a first-class memory history API.

## Data Model

Add a Core SQLite table, suggested name: `memory_revisions`.

Suggested schema:

```sql
create table if not exists memory_revisions (
  id text primary key,
  runtime_id text not null,
  runtime_profile text not null,
  file_key text not null,
  file_name text not null,
  action text not null,
  created_at integer not null,
  file_updated_at integer,
  content_hash text not null,
  bytes integer not null,
  summary text not null,
  content text not null,
  metadata_json text not null
);

create index if not exists idx_memory_revisions_profile_file_created
  on memory_revisions(runtime_id, runtime_profile, file_key, created_at desc);
```

Field notes:

- `id`: use `random_id("memory_revision")`.
- `runtime_id`: usually `runtime_local_hermes`.
- `runtime_profile`: Hermes profile name, such as `default` or `health`.
- `file_key`: normalized `"memory"` or `"user"`.
- `file_name`: `"MEMORY.md"` or `"USER.md"`.
- `action`: keep current UI-compatible values `"save"` or `"reset"` for initial implementation.
- `created_at`: snapshot creation time in seconds.
- `file_updated_at`: mtime seconds of the file being snapshotted, nullable.
- `content_hash`: SHA-256 of the snapshotted content.
- `bytes`: UTF-8 byte length of the snapshotted content.
- `summary`: short label for UI, for example:
  - `"Before Iris save"`
  - `"Before Iris reset"`
- `content`: the full previous file content.
- `metadata_json`: optional details such as:
  - `{"source":"iris","operation":"save","expectedUpdatedAt":123}`
  - `{"source":"iris","operation":"reset","target":"all"}`

Retention:

- Keep the most recent 50 revisions per `(runtime_id, runtime_profile, file_key)` by default.
- Implement pruning after insert.
- Make this a constant in Core, for example `MEMORY_REVISION_LIMIT = 50`.

Privacy:

- Memory content can contain user identity, preferences, and project facts.
- Do not log snapshot content.
- Do not include revisions in diagnostics dumps unless explicitly requested in a future feature.

## CoreStore Implementation

File: `iris-core/src/hermes_management_server/core_store.py`

1. Bump `CORE_SCHEMA_VERSION` from `7` to `8`.

2. Add `"memory_revisions"` to `CORE_OWNED_TABLES`.

3. Add table and index creation in `_initialize()`.

4. Add helper functions near existing row mappers:

```python
def memory_revision_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "file": str(row["file_name"]),
        "action": str(row["action"]),
        "updatedAt": int(row["created_at"]),
        "bytes": int(row["bytes"]),
        "summary": str(row["summary"]),
        "content": str(row["content"]),
        "metadata": loads(row["metadata_json"]),
    }
```

The current frontend type does not include `metadata`, so either:

- omit `metadata` from the returned object, or
- extend `HermesMemoryHistoryEntry` with optional `metadata?: Record<string, unknown>`.

5. Add methods on `CoreStore`:

```python
def create_memory_revision(
    self,
    *,
    runtime_id: str,
    runtime_profile: str,
    file_key: str,
    file_name: str,
    action: str,
    content: str,
    file_updated_at: int | None,
    summary: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ...

def list_memory_revisions(
    self,
    *,
    runtime_id: str,
    runtime_profile: str,
    file_key: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    ...

def rename_memory_revisions_profile(
    self,
    *,
    runtime_id: str,
    old_profile: str,
    new_profile: str,
) -> None:
    ...

def delete_memory_revisions_for_profile(
    self,
    *,
    runtime_id: str,
    runtime_profile: str,
) -> None:
    ...
```

6. Add pruning inside `create_memory_revision()` after insert:

```sql
delete from memory_revisions
where id in (
  select id from memory_revisions
  where runtime_id = ? and runtime_profile = ? and file_key = ?
  order by created_at desc, id desc
  limit -1 offset ?
)
```

Use `MEMORY_REVISION_LIMIT` as the offset.

## HermesStore Implementation

File: `iris-core/src/hermes_management_server/runtime_adapters/hermes_store.py`

Add small helpers rather than putting all revision behavior in `HermesStore`.

Recommended helpers:

```python
def normalized_memory_file_key(file_key: str) -> str:
    normalized = file_key.strip().lower()
    if normalized in {"memory", "memory.md"}:
        return "memory"
    if normalized in {"user", "user.md"}:
        return "user"
    raise ManagementError("Memory writes are limited to MEMORY.md and USER.md.", status_code=400)

def memory_file_name(file_key: str) -> str:
    return "MEMORY.md" if normalized_memory_file_key(file_key) == "memory" else "USER.md"
```

Then update `memory_file_path()` to use `normalized_memory_file_key()` internally.

Add a stronger file identity to `FileContent` if feasible:

- Preferred: add `contentHash: string` to Core and Desktop types.
- Acceptable first pass: keep `updatedAt` but document that it is second-level mtime and less robust.

Recommended stronger helper:

```python
def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
```

If adding `contentHash`:

- Add `contentHash` to `FileContent` in `iris-core/src/hermes_management_server/models.py`.
- Add `contentHash` to `HermesMemoryFile` in `apps/desktop/src/types/hermes.ts`.
- Return it from `file_payload()`.
- Keep `updatedAt` for display.

## Runtime Adapter Implementation

File: `iris-core/src/hermes_management_server/runtime_adapters/hermes.py`

The adapter already receives `core_store` in `__init__`.

### Read

Update `agent_memory()` so it includes revisions:

```python
history = []
if self.core_store:
    history = self.core_store.list_memory_revisions(
        runtime_id=str(self.runtime["id"]),
        runtime_profile=profile,
        limit=100,
    )
```

Return shape must stay compatible with `HermesMemory`:

```python
{
    "ok": True,
    "profile": profile,
    "path": str(directory / "memories"),
    "files": [memory_file, user_file],
    "memory": memory_file,
    "user": user_file,
    "history": history,
}
```

### Save

Current save path:

```python
self.require_store().save_memory_file(profile, file, content, expected_updated_at)
return self.agent_memory(agent)
```

Replace with an adapter-level orchestration:

1. Resolve `profile`.
2. Normalize `file` to `file_key`.
3. Read current file payload before writing.
4. Check conflict.
   - If using existing `expected_updated_at`, preserve the current behavior.
   - If adding `contentHash`, prefer checking `expectedContentHash`.
   - If conflict, raise `ManagementError(..., status_code=409)` before snapshot or write.
5. If the file exists and current content differs from the new content, create a `save` revision with current content.
6. Write the new content.
7. Return `agent_memory(agent)`.

Important: snapshot before write, not after.

Suggested summary:

```text
Before Iris save
```

If the file does not exist and the user creates it, do not create an empty snapshot unless product wants "created from empty" entries. The first pass should skip empty/nonexistent snapshots to reduce noise.

### Reset

Current reset path:

```python
self.require_store().reset_memory_file(profile, file)
return self.agent_memory(agent)
```

Replace with an adapter-level orchestration:

1. Resolve `profile`.
2. Resolve targets:
   - `"memory"` -> `["memory"]`
   - `"user"` -> `["user"]`
   - `"all"` -> `["memory", "user"]`
3. For each target:
   - Read current file payload.
   - If file exists, create a `reset` revision with current content.
   - If file does not exist, skip snapshot.
4. Delete target file(s).
5. Return `agent_memory(agent)`.

Suggested summary:

```text
Before Iris reset
```

Reset conflict handling:

- Current Desktop does not pass `expectedUpdatedAt` to reset.
- Prefer extending the reset request to include current file timestamps/hashes so reset does not delete a newer Hermes update without warning.
- If that is too much for the first pass, snapshot-before-delete makes data recoverable, but the UX is less protective.

Recommended reset request extension:

```python
class AgentMemoryResetRequest(BaseModel):
    confirm: str = ""
    expectedUpdatedAt: int | None = None
    expectedUpdatedAtByFile: dict[str, int | None] = Field(default_factory=dict)
    expectedContentHash: str | None = None
    expectedContentHashByFile: dict[str, str | None] = Field(default_factory=dict)
```

For `"all"`, check both files when expectations are provided.

### Profile Rename/Delete

Because agent IDs and profile names change on rename, memory revisions need lifecycle handling:

- On profile rename:
  - After the Hermes profile directory is renamed successfully, call `CoreStore.rename_memory_revisions_profile(runtime_id, old_profile, new_profile)`.
  - This keeps the history visible under the new agent/profile name.
- On profile delete:
  - After the Hermes profile directory is deleted successfully, call `CoreStore.delete_memory_revisions_for_profile(...)`.
  - This avoids retaining deleted profile memory indefinitely.
- On profile clone:
  - Do not clone revision history.
  - The cloned profile receives the current memory files, but its Iris revision history starts empty.

## Core API and Models

File: `iris-core/src/hermes_management_server/models.py`

Current `AgentMemorySaveRequest`:

```python
class AgentMemorySaveRequest(BaseModel):
    content: str
    expectedUpdatedAt: int | None = None
```

Recommended additions:

```python
expectedContentHash: str | None = None
```

Current `AgentMemoryResetRequest`:

```python
class AgentMemoryResetRequest(BaseModel):
    confirm: str = ""
```

Recommended additions are listed above.

File content response:

- Add `contentHash` if implementing stronger conflict detection.
- Keep `updatedAt` for display.
- Keep response backward-compatible for existing UI.

No new route is required for read-only revision history because the existing `GET /v1/agents/{agent_id}/memory` response already includes `history`.

Optional future restore route:

```text
POST /v1/agents/{agent_id}/memory/revisions/{revision_id}/restore
```

Do not implement restore unless the UI adds a restore action. The current UI only lists and diffs revisions.

## Desktop Implementation

### Profile-scoped memory loading

Fix the current risk where `AgentsView` receives a single `iris.memory` value.

Current path:

- `App.tsx` passes `memory={iris.memory}` to `AgentsView`.
- `useIrisRuntime()` keeps `memory` in state from `selectedProfile`.
- Agent detail route can view `agentDetailProfile`, which may differ from `selectedProfile`.

Recommended fix:

1. Move the memory query for agent detail into the detail path.
2. Use `useMemoryQuery(iris.runtimeConfig, detailAgentProfile.name, iris.connected && section === "memory")`.
3. Pass that query result into `MemoryView`.
4. Keep `useIrisRuntime().memory` only for selected-profile legacy uses, or remove it if no longer needed.

Alternative:

- Change `useIrisRuntime` to keep `memoryByProfile: Record<string, HermesMemory>`.
- This is more invasive and less necessary because React Query already has profile-scoped cache keys.

Mutation callbacks:

- Existing `useSaveMemoryMutation()` and `useResetMemoryMutation()` already use `payload.profile` and update `memoryKeys.agent(routeKey, payload.profile || "default")`.
- Ensure `App.tsx` passes the detail profile, not the selected profile, to `iris.saveMemoryFile()` and `iris.resetMemoryFile()`.
- After mutation, invalidate:
  - `memoryKeys.agent(routeKey, profile)`
  - `agentKeys.all(routeKey)` or `statusKeys.all(routeKey)` if memory byte counts are shown in the agent list/overview.

### Type updates

File: `apps/desktop/src/types/hermes.ts`

If Core adds `contentHash`:

```ts
export type HermesMemoryFile = {
  name: string;
  path: string;
  exists: boolean;
  updatedAt: number | null;
  bytes: number;
  content: string;
  contentHash?: string;
};
```

If Core returns metadata on revisions:

```ts
export type HermesMemoryHistoryEntry = {
  id: string;
  file: string;
  action: "save" | "reset";
  updatedAt: number;
  bytes: number;
  summary: string;
  content: string;
  metadata?: Record<string, unknown>;
};
```

### UI copy

Current empty copy says:

```text
Saved revisions appear here after the agent or you edit MEMORY.md.
```

Change this unless implementing external-change snapshots.

Recommended:

```text
Snapshots appear here after Iris saves or resets MEMORY.md.
```

Reason: Hermes-authored changes will not appear automatically unless Iris later snapshots them before an Iris mutation.

Current reset copy says:

```text
This removes the selected memory file from the active agent after saving a revision snapshot.
```

This is acceptable only after snapshots are implemented. If implementation is delayed, change it to "This cannot be undone." For this plan, implement snapshots and keep the promise true.

### Diff behavior

Current `diffLines()` is line-index based, not an LCS diff. That is acceptable for first implementation because the user asked for backend support, not a diff algorithm rewrite.

Potential later improvement:

- Use a real diff package or small LCS implementation for cleaner insertion/deletion rendering.

## Tests

### Core unit tests

File: `iris-core/tests/test_profiles.py`

Add tests for `HermesStore` helpers:

- `normalized_memory_file_key("memory") == "memory"`
- `normalized_memory_file_key("MEMORY.md") == "memory"`
- `normalized_memory_file_key("user") == "user"`
- invalid file keys raise `ManagementError`.

If adding `contentHash`, test that `memory_files()` returns stable hashes.

### Core API tests

File: `iris-core/tests/test_api.py`

Add tests:

1. Save creates a revision.

Setup:

- Create `root / "memories" / "MEMORY.md"` with `"before"`.
- Load agent id.
- GET memory and capture `updatedAt` or `contentHash`.
- PUT `/v1/agents/{id}/memory/memory` with `"after"`.

Assertions:

- Response status is 200.
- `response.json()["memory"]["memory"]["content"] == "after"`.
- `response.json()["memory"]["history"]` has one entry.
- Entry:
  - `file == "MEMORY.md"`
  - `action == "save"`
  - `content == "before"`
  - `summary == "Before Iris save"`

2. Reset creates a revision.

Setup:

- `USER.md` contains `"user facts"`.
- DELETE `/v1/agents/{id}/memory/user` with confirm.

Assertions:

- Response status is 200.
- `USER.md` no longer exists.
- History has a `USER.md` entry with action `"reset"` and content `"user facts"`.

3. Reset all creates two revisions when both files exist.

Assertions:

- One `MEMORY.md` reset revision.
- One `USER.md` reset revision.
- Both files are removed.

4. Save conflict does not create a revision.

Setup:

- GET memory to capture expected value.
- Mutate the file on disk.
- PUT with stale expected value.

Assertions:

- Response status is 409.
- No new revision is inserted.
- Existing file content remains the external/newer content.

5. Retention pruning.

Setup:

- Save repeatedly more than `MEMORY_REVISION_LIMIT` times.

Assertions:

- History for the file is capped at the limit.
- The newest revisions remain.

6. Profile rename carries revisions.

Setup:

- Save memory on profile `research`.
- Rename profile to `health`.
- GET memory for `health`.

Assertions:

- History appears under `health`.
- History no longer appears under `research` if that profile no longer exists.

7. Profile delete removes revisions.

Setup:

- Save memory on a non-default profile.
- Delete profile.

Assertions:

- `memory_revisions` rows for that runtime/profile are removed.

### Desktop tests

Existing targeted test command:

```bash
npm --workspace apps/desktop run test -- AgentDetailView.test.tsx irisCore.test.ts
```

Note: in this environment, `npm` may not be on PATH. The bundled Node runtime can run Vitest from the `desktop` directory:

```bash
/Users/scott/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node ../node_modules/.bin/vitest run src/features/agents/__tests__/AgentDetailView.test.tsx src/lib/__tests__/irisCore.test.ts
```

Add or update tests:

- `MemoryView` renders revision count and selected revision content from `memory.history`.
- `MemoryView` empty copy is honest about Iris snapshots.
- `irisCore.ts` includes expected hash fields if added.
- Agent detail memory route uses the detail profile query, not global selected profile memory.

Existing stale tests:

- `apps/desktop/src/features/agents/__tests__/AgentDetailView.test.tsx` currently has expectations for old readiness banner copy such as `"default gateway is stopped"` and `"Iris adapter is unreachable"`.
- The redesigned overview now renders diagnostic rows, so update those assertions when touching the tests.

### Manual checks

Use Vite/browser checks during iteration:

1. Assume the user may already have `npm run dev` running.
2. Open `http://localhost:1420/` with the Browser plugin.
3. Navigate to Agents -> a profile -> Memory.
4. Verify:
   - Existing memory loads for the selected detail profile.
   - History starts empty or shows previous snapshots.
   - Save creates a revision row.
   - Reset creates a revision row.
   - Switching between `MEMORY.md` and `USER.md` filters history correctly.
   - Viewing a non-selected agent does not show selected-profile memory.

Final visible/desktop verification:

1. Run root `npm run build:mac:app`.
2. Launch the newly built app bundle.
3. Use Computer Use against `com.nousresearch.hermes-agent.desktop`.
4. Verify the packaged app can save and reset memory, then show history.

## Implementation Order

1. CoreStore schema and methods.
2. HermesStore file-key/hash helpers.
3. HermesRuntimeAdapter read/save/reset integration.
4. Profile rename/delete lifecycle handling.
5. Core API tests for save/reset/history/conflict/retention.
6. Desktop type updates.
7. Agent detail profile-scoped memory query fix.
8. Desktop tests for revision rendering and profile scoping.
9. Browser/Vite visual check.
10. Packaged desktop verification.

## Acceptance Criteria

- `GET /v1/agents/{agent_id}/memory` returns `history` with real revision entries after saves/resets.
- Save snapshots the previous file content before writing new content.
- Reset snapshots existing file content before deleting.
- Failed save conflicts do not mutate the memory file and do not create misleading revisions.
- The Memory tab history card shows the correct count per active file.
- The diff pane compares selected revision content to current file content.
- A detail profile's Memory tab never shows another selected profile's memory.
- Agent list/overview memory byte counts refresh after save/reset.
- Tests cover Core revision creation, conflict behavior, retention, and profile rename/delete.

## Non-Goals

- No complete Hermes-authored memory audit log.
- No filesystem watcher in the first implementation.
- No Hermes plugin memory-history route.
- No restore button unless the UI adds one.
- No new external memory provider management for Honcho, Mem0, or similar providers.
- No desktop direct file reads or writes.

## Open Questions

1. Should `contentHash` be added now, or should the first pass keep `expectedUpdatedAt` and add hash in a follow-up?
   - Recommendation: add `contentHash` now because second-level mtime can miss quick external edits.
2. Should reset enforce expected hashes/timestamps?
   - Recommendation: yes, especially for `Reset all memory`.
3. Should revisions survive profile delete?
   - Recommendation: no, delete them with the profile to avoid retaining sensitive memory unexpectedly.
4. Should revisions be exported or included in diagnostics?
   - Recommendation: no for now.
