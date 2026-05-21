# Hermes Profile Management Completion

## Goal

Finish Hermes agent profile management from Iris, within reason, now that the agent list and overview page exist and the Memory and Skills tabs are profile-scoped.

End state:

1. Iris manages Hermes profiles using the same rules and side effects Hermes itself expects.
2. Create, clone, rename, activate, and delete do not leave broken gateways, stale aliases, stale Iris adapter config, or invalid profile directories behind.
3. Users can inspect and safely edit the profile identity/config pieces that make one agent profile different from another.
4. Users can back up, restore, and install/update shareable profile distributions without leaving Iris for basic flows.
5. Iris does not try to reimplement every interactive Hermes wizard. When a workflow is too provider-specific or terminal-native, Iris should expose status, clear next steps, and a safe way to delegate to Hermes.

## Already Done

Treat these as complete enough for profile management unless a bug is found:

- Agent list and overview page redesign.
- Profile-local built-in memory management:
  - `MEMORY.md` and `USER.md` load for the selected agent profile.
  - Iris save/reset operations snapshot revisions before mutation.
  - UI renders memory capacity, editor, reset, history, and diffs.
- Profile-local skill management:
  - Skills load for the selected profile, not just the globally selected chat profile.
  - Users can create, edit, install/copy from another local profile, and remove skills.
  - Core owns all Hermes profile file reads/writes.
- Gateway status/control exists at the agent level.

Important caveat:

- Hermes external memory provider setup (`hermes memory setup/status/off`) and full Skills Hub lifecycle (`hermes skills browse/search/install/update/audit/...`) are advanced Hermes surfaces. They are not blockers for managing Hermes profiles from Iris. If added, treat them as later integrations, not as missing Memory/Skills basics.

## Product Contract

Definitions:

- **Hermes profile**: one isolated Hermes home. The default profile is `~/.hermes`; named profiles are `~/.hermes/profiles/<name>`.
- **Iris agent**: the Iris/Core representation of a Hermes profile, with `runtimeProfile` set to the Hermes profile name.
- **Profile identity**: files and settings that shape the agent profile, especially `SOUL.md`, `config.yaml`, `.env` status, `memories/MEMORY.md`, `memories/USER.md`, `skills/`, and distribution metadata.
- **Fully manage, within reason**: Iris should cover day-to-day lifecycle and safe profile file/config operations, but may delegate deep provider setup, OAuth, plugin marketplace flows, and terminal-native migrations to Hermes CLI.

User-facing language:

- Use "agent" in the main Iris UI where the current redesign already does.
- Use "Hermes profile" in technical details, file paths, diagnostics, and confirmation copy.
- Be explicit when an action may require restarting the Hermes gateway, reinstalling the Iris Hermes adapter, or opening a fresh chat.

Avoid:

- Desktop reading or writing `~/.hermes` directly.
- Fake inventory or fake config states.
- Saying a profile is fully ready when Core is reachable but its Hermes gateway or Iris adapter is stopped.
- Treating provider secrets as displayable text.

## Hermes Source Of Truth

Use these Hermes behaviors as the compatibility target:

- `hermes_cli/profiles.py`
  - A profile is an independent `HERMES_HOME` with config, `.env`, memory, sessions, skills, gateway, cron, logs, workspace, and per-profile subprocess home.
  - Profile names are normalized to lowercase and must match `^[a-z0-9][a-z0-9_-]{0,63}$`; `default` is special; reserved names are rejected.
  - New profiles scaffold: `memories`, `sessions`, `skills`, `skins`, `logs`, `plans`, `workspace`, `cron`, `home`.
  - `create` supports clone modes, default `SOUL.md` seeding, bundled-skill opt out, and alias creation.
  - `rename` stops gateways, renames the directory, migrates profile-scoped Honcho host state, updates wrappers, and updates active profile.
  - `delete` stops/cleans the gateway service, removes aliases, deletes the directory, and resets active profile when needed.
  - `export`/`import` use safe tar archive handling and exclude credentials as appropriate.
- `hermes_cli/profile_distribution.py`
  - A distribution is a git/local packaged profile with `distribution.yaml`.
  - Install/update preserve user-owned paths such as memories, sessions, auth, `.env`, logs, workspace, home, and plans.
  - Distribution-owned paths such as `SOUL.md`, `skills/`, `cron/`, `mcp.json`, and `distribution.yaml` can be replaced on update.
- Hermes docs:
  - `hermes profile`: list/use/create/delete/show/alias/rename/export/import/install/update/info.
  - `hermes config`: show/edit/set/path/env-path/check/migrate.
  - `hermes memory`: external provider setup/status/off only; built-in memory files are always active.
  - `hermes skills`: remote/hub skill management; this is separate from Iris' profile-local skill editor.

## Current Iris State

Primary Core files:

- `iris-core/src/hermes_management_server/runtime_adapters/hermes_store.py`
  - Lists Hermes profiles and summarizes model, memory bytes, skill count, and gateway-running state.
  - Profile validation currently allows uppercase letters and dots.
  - `profile_scaffold()` currently creates only `memories` and `skills`.
  - Create/clone/rename/activate/delete are direct filesystem operations.
- `iris-core/src/hermes_management_server/runtime_adapters/hermes.py`
  - Maps Core agent CRUD to HermesStore profile CRUD.
  - Renames/deletes Iris memory revision metadata with the profile.
  - Handles memory, skills, sessions, automations, gateway control, models, messages, and slash commands.
- `iris-core/src/hermes_management_server/main.py`
  - Exposes `/v1/agents` CRUD and agent-scoped memory/skills/gateway/model routes.
  - Installs the Iris Hermes plugin across profile homes using sorted profile order to derive inbound ports.
- `iris-core/src/hermes_management_server/core_store.py`
  - Owns Iris Core SQLite, including memory revision metadata.

Primary Desktop files:

- `desktop/src/features/agents/AgentOverviewView.tsx`
  - Shows profile metadata, runtime health, runtime configuration, and simple create/clone/rename/switch/delete controls.
- `desktop/src/features/agents/AgentDetailView.tsx`
  - Hosts Overview, Memory, and Skills tabs.
- `desktop/src/features/memory/MemoryView.tsx`
  - Profile-local built-in memory surface.
- `desktop/src/features/skills/SkillsView.tsx`
  - Profile-local skill surface.
- `desktop/src/features/iris/useIrisRuntime.ts`
  - Owns profile actions, selected profile, refreshes, notices, memory/skill callbacks.
- `desktop/src/lib/irisCore.ts` and `desktop/src/lib/irisRuntime.ts`
  - HTTP/Core wrappers and profile-to-agent resolution.

## Missing Work

### 1. Canonical Profile Lifecycle Parity

Iris should stop treating profile CRUD as a small filesystem utility and make it compatible with Hermes profile semantics.

Implementation approach:

1. Prefer CLI-first for operations with side effects outside the profile directory:
   - rename
   - delete
   - alias create/remove
   - export/import
   - distribution install/update/info
2. Keep direct filesystem reads for list/summary/memory/skills/session discovery.
3. Keep a direct fallback for create/clone/activate when the Hermes CLI is unavailable, but make the fallback match Hermes behavior closely.
4. If importing `hermes_cli.profiles` from the Core Python environment is reliable, use it for pure Python helpers. If not, shell out with `subprocess.run([...], shell=False)` and then read back the resulting profile summary from disk.

Core tasks:

- Add canonical profile-name helpers in `HermesStore`:
  - `normalize_profile_name(value) -> str`
  - `validate_profile_name(value) -> str`
  - reject names outside `^[a-z0-9][a-z0-9_-]{0,63}$`
  - allow only `default` as the special built-in name
  - reject Hermes reserved names: `hermes`, `test`, `tmp`, `root`, `sudo`
- Continue discovering existing non-canonical profile directories defensively.
  - Do not silently delete or rename them.
  - Prefer surfacing them as unmanaged/error profiles if they already exist.
  - New create/rename/import/install paths must produce canonical names only.
- Expand `profile_scaffold()` fallback to create:
  - `memories`
  - `sessions`
  - `skills`
  - `skins`
  - `logs`
  - `plans`
  - `workspace`
  - `cron`
  - `home`
- Seed `SOUL.md` for fresh profiles.
  - Prefer Hermes' `DEFAULT_SOUL_MD` when importable.
  - Otherwise use a minimal fallback and log that the Hermes template was unavailable.
- Fix active profile semantics:
  - activating `default` should remove `active_profile`, matching Hermes
  - activating a named profile should atomically write the canonical name
- Define clone semantics explicitly:
  - Default Iris "Clone" should match Hermes `--clone` identity semantics: config files, `.env`, `SOUL.md`, skills, and memory identity files, but not sessions, state DBs, gateway locks, logs, or caches.
  - Add an API field for future modes: `cloneMode: "identity" | "all"`.
  - Only expose `cloneMode: "all"` in UI after the destructive implications are clear.
- Rename/delete should use Hermes CLI when possible so gateway/service/wrapper/Honcho cleanup stays correct.
  - After CLI success, run Iris Core cleanup such as memory revision profile rename/delete.
  - If CLI is unavailable and fallback direct rename/delete is used, stop the gateway first when possible and return a warning that alias/service cleanup may need Hermes CLI.

Suggested Core API changes:

```http
POST   /v1/agents
POST   /v1/agents/{agent_id}/clone
PATCH  /v1/agents/{agent_id}
POST   /v1/agents/{agent_id}/activate
DELETE /v1/agents/{agent_id}
```

Extend existing request/response payloads instead of replacing the endpoints:

```ts
type AgentCreateRequest = {
  runtimeId?: string;
  name: string;
  metadata?: Record<string, unknown>;
  createAlias?: boolean;
  noAlias?: boolean;
  noSkills?: boolean;
};

type AgentCloneRequest = AgentCreateRequest & {
  cloneMode?: "identity" | "all";
  sourceProfile?: string;
};

type AgentMutationResult = {
  ok: boolean;
  agent: HermesAgent;
  warnings?: string[];
  restartRequired?: boolean;
  adapterInstallRequired?: boolean;
};
```

Desktop tasks:

- Replace the single text-field workflow with clearer actions:
  - Create agent
  - Clone current agent
  - Rename agent
  - Switch active agent
  - Delete agent
- Validate input with the canonical Hermes rules before submitting.
- Show destructive confirmations for clone-all and delete.
- After profile mutations:
  - refresh agents/status
  - navigate to the new profile when appropriate
  - preserve a clear success/failure toast
  - say when a gateway restart or adapter reinstall is required

Tests:

- Core profile tests:
  - rejects uppercase/dot/reserved names for new profiles
  - normalizes user input to lowercase where appropriate
  - scaffolds all expected directories
  - seeds `SOUL.md`
  - activating default removes `active_profile`
  - clone identity does not copy sessions/state/logs/gateway runtime files
  - clone all strips stale gateway locks and sibling `profiles`
  - rename migrates Iris memory revision metadata
  - delete removes Iris memory revision metadata
  - CLI unavailable fallback returns warnings for cleanup gaps
- Desktop tests:
  - invalid names disable submit and show useful copy
  - delete default is disabled
  - mutation warnings render in the overview action area

### 2. Profile Identity And Configuration

Iris should expose safe management for the files/configuration that define a profile, without becoming a full terminal replacement for every Hermes wizard.

First implementation scope:

- `SOUL.md` read/edit/save/reset-to-default.
- `config.yaml` read-only structured summary plus raw text editor for advanced edits.
- `.env` status and safe secret update flow.
- Hermes config diagnostics:
  - `hermes config check`
  - `hermes config path`
  - `hermes config env-path`
- Model/provider status:
  - show provider/model from `config.yaml`
  - link existing model discovery where possible
  - delegate provider setup/OAuth to Hermes CLI or a terminal action

Core tasks:

- Add store helpers for profile files:
  - `profile_file(profile, relative_path)`
  - `read_profile_file(profile, relative_path)`
  - `write_profile_file(profile, relative_path, content, expected_content_hash)`
  - path allowlist: `SOUL.md`, `config.yaml`, maybe `.env` for controlled write only
  - never allow arbitrary relative paths in the first pass
- Add config summary parsing:
  - PyYAML is optional in `iris-core`; if not installed, return raw text and a warning.
  - Never fail the whole profile overview because YAML parsing failed.
- Add redacted env status:
  - Return keys present, not values.
  - Allow setting/replacing selected keys through a write-only request.
  - Do not return secret values in API responses, logs, test snapshots, or UI.
- Add optional command wrapper for config diagnostics:
  - `hermes --profile <profile> config check`
  - `hermes --profile <profile> config path`
  - `hermes --profile <profile> config env-path`

Suggested Core API:

```http
GET  /v1/agents/{agent_id}/profile/identity
PUT  /v1/agents/{agent_id}/profile/soul
POST /v1/agents/{agent_id}/profile/soul/reset
GET  /v1/agents/{agent_id}/profile/config
PUT  /v1/agents/{agent_id}/profile/config
GET  /v1/agents/{agent_id}/profile/env
PUT  /v1/agents/{agent_id}/profile/env
POST /v1/agents/{agent_id}/profile/config/check
```

Suggested response shapes:

```ts
type ProfileFilePayload = {
  ok: boolean;
  profile: string;
  path: string;
  content: string;
  contentHash: string;
  updatedAt: number | null;
  error?: string;
};

type ProfileIdentity = {
  ok: boolean;
  profile: string;
  path: string;
  soul: ProfileFilePayload;
  config: {
    path: string;
    provider: string;
    model: string;
    raw: string;
    parseError?: string;
  };
  env: {
    path: string;
    keys: string[];
    requiredKeys?: string[];
  };
  distribution?: {
    name?: string;
    version?: string;
    source?: string;
  };
};
```

Desktop tasks:

- Add a configuration surface from the Overview tab.
  - A new tab named `Configuration` is acceptable if the overview becomes crowded.
  - A dialog from the Runtime configuration card is acceptable for the first pass.
- Include:
  - SOUL editor with save/reset and dirty-state handling.
  - Config summary with raw editor behind an advanced affordance.
  - Env status with redacted keys and "update secret" inputs.
  - Config check action with command output.
- Use existing shadcn/ui primitives where they fit.
- Keep dense desktop styling consistent with the redesigned agent pages.

Tests:

- Core:
  - path allowlist blocks traversal and unsupported files
  - soul save uses content hash conflict detection
  - soul reset writes default template
  - config parse errors return a warning, not a 500
  - env status redacts values
  - env update writes values but response redacts them
- Desktop:
  - SOUL editor renders profile-specific content
  - dirty save/reset confirmation behavior
  - env values are not rendered

### 3. Import, Export, And Profile Distributions

Users should be able to move or install profiles without leaving Iris for basic local/remote-safe flows.

Implementation preference:

- Use Hermes CLI or Hermes distribution functions for archive/distribution logic.
- Avoid reimplementing tar extraction security in Iris if Hermes already provides it.
- Make Core the boundary for file upload/download so SSH-connected remote Core can still work.

Core API:

```http
GET  /v1/agents/{agent_id}/profile/export
POST /v1/profiles/import
POST /v1/profiles/install
POST /v1/agents/{agent_id}/profile/distribution/update
GET  /v1/agents/{agent_id}/profile/distribution/info
```

Behavior:

- Export:
  - Return a tar.gz `StreamingResponse`.
  - Use Hermes export semantics, including credential exclusions.
  - Filename suggestion: `<profile>-hermes-profile.tar.gz`.
- Import:
  - Accept multipart tar.gz upload and optional target name.
  - Validate canonical target name before extraction/import.
  - Return the created agent summary.
- Install:
  - Accept `source`, optional `name`, `alias`, `force`.
  - Support git URLs and local paths if Core can access them.
  - Return a preview mode first if possible, then apply after confirmation.
- Update:
  - Only enabled when `distribution.yaml` exists.
  - Preserve user-owned paths.
  - Return changed/owned path summary when available.
- Info:
  - Return manifest data, source, required env vars, and version compatibility warnings.

Desktop tasks:

- Add profile menu actions:
  - Export profile
  - Import profile
  - Install distribution
  - Update distribution, only for distribution-backed profiles
  - Distribution info
- For export:
  - Use the browser/download path for web or Tauri save dialog for desktop, depending on existing app patterns.
  - Avoid showing raw archive contents.
- For import/install:
  - Require a target profile name before submit.
  - Show conflicts and distribution-owned/user-owned path explanations.

Tests:

- Core:
  - export excludes `.env` and auth files
  - import rejects unsafe archive names
  - import rejects `default`
  - import creates a profile and returns an agent
  - distribution install/update preserve user-owned paths
- Desktop:
  - import/install dialogs validate profile names
  - export action handles success/error states
  - distribution-backed profiles show info/update affordances

### 4. CLI Alias Management

Aliases are useful but optional. Implement after lifecycle/config/import-export unless the user needs CLI parity sooner.

Core API:

```http
GET    /v1/agents/{agent_id}/profile/alias
POST   /v1/agents/{agent_id}/profile/alias
DELETE /v1/agents/{agent_id}/profile/alias
```

Behavior:

- Show whether a wrapper alias exists.
- Create alias with default name or custom name.
- Detect collisions before creating.
- Remove aliases without deleting the profile.
- Use Hermes CLI/helpers when available.

Desktop tasks:

- Add a small `CLI alias` row in the configuration/profile metadata surface.
- Show alias path and collision errors.
- Do not make alias creation part of the primary create flow unless the UX explicitly asks for it.

Tests:

- alias collision returns a 409-style management error
- alias remove is idempotent or gives a clear "not found" result
- UI shows alias status without requiring gateway running

### 5. Runtime Hygiene And Stable Adapter Ports

This is important because Iris installs the Hermes adapter into every profile and currently derives inbound ports from sorted profile order.

Problem:

- `install_iris_hermes_plugin_for_app()` enumerates profile homes in sorted order and assigns `DEFAULT_IRIS_INBOUND_PORT + index`.
- Creating, deleting, or renaming profiles can shift later profile ports.
- A shifted port can leave existing Hermes adapter config stale until reinstall/restart.

Core tasks:

- Introduce stable per-profile Iris adapter port assignment.
- Store mapping in Iris Core SQLite, for example:

```sql
create table if not exists runtime_profile_ports (
  runtime_id text not null,
  runtime_profile text not null,
  inbound_port integer not null,
  created_at integer not null,
  updated_at integer not null,
  primary key(runtime_id, runtime_profile)
);
```

- Allocation rules:
  - `default` should keep the current default inbound port.
  - Existing profiles get their current discovered port if possible.
  - New profiles get the next unused port.
  - Rename migrates the row from old profile to new profile.
  - Delete can remove the row, or keep a tombstone if avoiding immediate port reuse is desired. Prefer no immediate reuse if there is any risk of stale gateway processes.
- Update `install_iris_hermes_plugin_for_app()` to use the stable mapping instead of sorted index.
- After profile create/import/install:
  - allocate a port
  - install/enable Iris Hermes adapter for the new profile
  - mark `restartRequired` when adapter config changed
- After rename:
  - migrate port mapping
  - reinstall/update adapter config for the renamed profile
  - restart or prompt to restart the gateway
- After delete:
  - stop gateway first
  - cleanup adapter/plugin state as part of profile deletion

Desktop tasks:

- In profile action results, show:
  - "Adapter installed. Restart Hermes gateway for this agent."
  - "Adapter install failed. Run Settings -> Install Hermes adapter."
  - "Profile created, but gateway is stopped."
- Ensure the Overview health card can refresh after these actions.

Tests:

- Core:
  - port mapping is stable when inserting a profile whose name sorts before existing profiles
  - rename migrates port mapping
  - delete does not cause another live profile to change ports
  - plugin install uses stored mapping
- Desktop:
  - profile action warnings render
  - health refresh happens after profile action

## Suggested Implementation Order

1. Canonical validation, scaffold, active-profile semantics, and clone-mode cleanup.
2. CLI-first rename/delete and lifecycle warnings.
3. Stable adapter port mapping.
4. Profile identity/config APIs and UI.
5. Export/import.
6. Distribution install/update/info.
7. Alias management.

This order reduces risk because lifecycle correctness and adapter stability affect every later profile feature.

## Verification

Core targeted tests:

```bash
npm run core:test
```

or during tight iteration:

```bash
iris-core/.venv/bin/python -m pytest iris-core/tests/test_profiles.py iris-core/tests/test_api.py
```

Desktop targeted tests:

```bash
npm --workspace desktop run test -- AgentDetailView MemoryView SkillsView
```

Full repo check before handoff:

```bash
npm run check
```

Visible UI verification:

- Use the existing Vite dev session at `http://localhost:1420/`.
- Verify normal flows in the Browser plugin:
  - create profile
  - clone profile
  - rename profile
  - switch profile
  - delete non-default profile
  - edit SOUL/config if implemented
  - export/import if implemented
- For final visible desktop behavior, build and launch a fresh packaged app:

```bash
npm run build:mac:app
```

Then test against `com.nousresearch.hermes-agent.desktop` with Computer Use, serialized with any other packaged-app checks.

## Restart Guidance For Final Answer

When this plan is implemented, final user-facing notes should say which reloads are needed:

- Pure desktop UI/query changes: existing dev session should hot-reload.
- Core API/store changes: restart Iris Core.
- Hermes adapter payload/config changes: reinstall/update the Hermes adapter plugin and restart the affected Hermes gateway.
- Skill or SOUL changes: open a fresh chat if an existing session does not pick them up.
- Stable adapter port changes: restart Hermes gateways after reinstalling adapter config.

## Open Questions

1. Should the one-click `Clone` button mean Hermes identity clone or full state clone?
   - Recommendation: identity clone by default; expose full-state clone only behind an advanced confirmation.
2. Should Iris create CLI aliases by default on profile create?
   - Recommendation: no. Show alias management separately to avoid shell PATH surprises.
3. Should imported/exported profiles include Iris memory revision history?
   - Recommendation: no. Profile archives should follow Hermes semantics; Iris revision snapshots are Core-owned safety history.
4. Should profile distribution install be allowed from arbitrary local paths on remote Core?
   - Recommendation: yes only when the path is Core-local and the UI makes that clear. For Desktop-local files, upload an archive or use a git URL.
