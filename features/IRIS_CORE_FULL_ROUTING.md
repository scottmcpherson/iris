# Route All Iris Desktop Work Through Iris Core

## Goal

Make Iris Core the single desktop-facing API and control plane. Iris Desktop, Tauri bridge code, and UI hooks must not call Hermes APIs directly and must not read or write `.hermes` files directly. Hermes can remain the first runtime backend, but every Hermes-specific read, write, command, and delivery must cross an Iris Core endpoint or an Iris Core runtime adapter boundary.

The finished implementation should leave exactly two Hermes-aware places:

1. `sidecar/src/hermes_management_server/runtime_adapters/hermes.py`, or a package split from it, as the Core-owned Hermes runtime adapter.
2. `agentui-platform/adapter.py`, because that code runs inside Hermes and is the Hermes-side bridge that posts runtime deliveries back into Iris Core.

Everything else should use Iris/Core naming and Core API calls.

## Current Audit

### Desktop Already Mostly Uses Core For Chat And Jobs

`desktop/src/lib/agentuiCore.ts` is the main Core client. It calls `/v1/agents`, `/v1/conversations`, `/v1/conversations/{id}/messages`, `/v1/events`, `/v1/attachments`, `/v1/automations`, `/v1/agents/{id}/models`, and `/v1/agents/{id}/slash-commands`.

`desktop/src/features/chat/useHermesChat.ts` sends chat through `createAgentUICoreConversation()` and `sendAgentUICoreMessage()`, streams from `agentUICoreEventStreamUrl()`, and polls `getAgentUICoreEvents()`. It still imports Hermes-shaped compatibility helpers from `desktop/src/lib/hermes.ts`.

`desktop/src/features/jobs/useHermesJobs.ts` uses Core automation APIs and Core events. Its remaining Hermes coupling is naming and the `agentui:desktop` delivery convention.

### Desktop Still Bypasses Core For Profile, Memory, And Skill Writes

`desktop/src/lib/hermes.ts` still exposes bridge-backed calls:

- `getHermesStatus()` -> bridge `status`
- `getHermesMemory()` -> bridge `memory`
- `saveHermesMemoryFile()` -> bridge `memory_save`
- `resetHermesMemoryFile()` -> bridge `memory_reset`
- `getHermesSkills()` -> bridge `skills`
- `getHermesSkillDetail()` -> bridge `skill_detail`
- `saveHermesSkill()` -> bridge `skill_save`
- `createHermesProfile()`, `cloneHermesProfile()`, `renameHermesProfile()`, `switchHermesProfile()`, `deleteHermesProfile()` -> bridge profile actions

The bridge read paths usually proxy to Core, but `memory_save`, `memory_reset`, `skill_save`, and several local profile fallback paths still write directly to `HERMES_HOME` / `~/.hermes`.

### Tauri Bridge Still Knows Too Much About Hermes

`desktop/src-tauri/python/hermes_bridge.py` still contains direct `.hermes` filesystem logic:

- `hermes_root()` defaults to `~/.hermes`.
- `active_profile_name()` reads `active_profile`.
- `write_active_profile()` writes `active_profile`.
- `profile_dir()`, `profile_scaffold()`, `clone_ignore()`, and `discover_profiles()` model Hermes profile layout.
- `memory_save()` and `memory_reset()` write `memories/MEMORY.md`, `memories/USER.md`, and `.history.json`.
- `skill_save()` writes profile-local `skills/**/SKILL.md` and `.history/*.json`.
- `local_profile_create()`, `local_profile_clone()`, `profile_rename()`, `profile_switch()`, and `local_profile_delete()` create, copy, rename, delete, or switch Hermes profile directories.

It also still stores and reads a Hermes API credential kind (`hermes-api-token`) and probes `profileApiUrls` / Hermes gateway URLs. After this work, the bridge should only be a Core transport fallback and local file-upload helper for Core attachment uploads.

### Core Reads `.hermes` Directly Through HermesStore

`sidecar/src/hermes_management_server/hermes_store.py` is the Core-side source of direct `.hermes` reads and profile mutations:

- `normalize_hermes_home()` defaults to `~/.hermes`.
- `HermesStore.active_profile_name()` reads `active_profile`.
- `HermesStore.discover_profile_names()` reads `profiles/`.
- `HermesStore.profile_summary()` reads `config.yaml`, `memories/`, `skills/`, and `gateway.pid`.
- `HermesStore.create_profile()`, `clone_profile()`, and `delete_profile()` mutate Hermes profile directories.
- `HermesStore.memory_files()`, `skills()`, and `skill_detail()` read profile-local memory and skills.
- `HermesStore.conversations()` and `conversation_detail()` delegate to direct conversation store discovery.

This direct access is currently server-side, but the goal is stronger: the Core API should own the abstraction, and Hermes file access should be encapsulated inside the Hermes runtime adapter instead of exposed as generic profile endpoints that clients can treat as Hermes management APIs.

### Core Reads Hermes SQLite And Session JSON Directly

`sidecar/src/hermes_management_server/conversations.py` opens profile-local `state.db`, `conversations.db`, `sessions.db`, `responses.db`, and `history.db` with read-only SQLite. It also falls back to `sessions/*.json`.

This is acceptable only as a private implementation detail of the Hermes runtime adapter. It should not be reachable through `/v1/profiles/{profile}/conversations` or used by desktop code directly.

### Core Calls Hermes Runtime APIs Directly

`sidecar/src/hermes_management_server/runtime_adapters/hermes.py` calls Hermes-side endpoints:

- `POST /agentui/messages` on the Iris Hermes adapter inbound listener.
- `GET /agentui/models`, `GET /agentui/slash-commands`, and `POST /agentui/slash-complete`.
- Hermes Jobs API paths under `/api/jobs`.
- Hermes gateway and adapter health probes.

These calls are legitimate if they remain inside the Core runtime adapter. They should be hidden behind Core endpoints and typed adapter interfaces.

### Settings Still Exposes Hermes API As A Desktop Route

`desktop/src/features/settings/SettingsView.tsx` shows a `Hermes API` service card, token field, and profile API URL. `desktop/src/app/runtimeConfig.ts` still persists:

- `gatewayUrl`
- `profileApiUrls`
- `profileSidecarUrls`
- `customHermesPath`

After this work, desktop should configure Core only. Runtime route details belong in Core runtime configuration, not desktop local storage.

### Scripts Still Bootstrap Hermes Directly

`scripts/dev.mjs` defaults `HERMES_HOME` to `~/.hermes`, reads `$HERMES_HOME/.env` for `API_SERVER_KEY`, exports `HERMES_API_TOKEN`, and starts `hermes-sidecar`.

`scripts/install-agentui-platform.mjs` copies `agentui-platform` into Hermes plugin directories and runs `hermes plugins enable agentui-platform`.

The install script can remain Hermes-aware because it installs the Hermes adapter. The dev script should be renamed and cleaned so the service is Iris Core first, with Hermes runtime details passed only to Core.

### AgentUI Platform Is The Hermes-Side Boundary

`agentui-platform/adapter.py` runs inside Hermes. It receives Iris messages at `/agentui/messages`, discovers models and slash commands using Hermes modules, and delivers responses to Iris Core at `/v1/runtime-deliveries/hermes`.

This file should remain Hermes-aware. It is not a desktop bypass. Its public environment names should prefer `IRIS_*`, with legacy `AGENTUI_*` aliases retained only where compatibility is needed.

## Target Architecture

Iris Desktop should talk to:

- `GET /v1/health`
- `GET /v1/status`
- `GET /v1/runtimes`
- `GET /v1/agents`
- `GET /v1/agents/{agent_id}`
- `GET /v1/agents/{agent_id}/memory`
- `PUT /v1/agents/{agent_id}/memory/{file}`
- `DELETE /v1/agents/{agent_id}/memory/{file}`
- `GET /v1/agents/{agent_id}/skills`
- `GET /v1/agents/{agent_id}/skills/{skill_id}`
- `PUT /v1/agents/{agent_id}/skills/{skill_id}`
- `POST /v1/agents/{agent_id}/skills`
- `POST /v1/agents`
- `POST /v1/agents/{agent_id}/clone`
- `PATCH /v1/agents/{agent_id}`
- `DELETE /v1/agents/{agent_id}`
- `POST /v1/agents/{agent_id}/activate`
- Existing Core chat, event, attachment, model, slash-command, and automation endpoints.

Hermes-specific endpoints under `/v1/profiles/**` must be removed from desktop usage. Public tests and docs should use the agent-scoped Core endpoints. Any retained `/v1/profiles/**` handlers must be marked deprecated compatibility shims and must delegate through the same Core runtime adapter interface as the agent endpoints.

Keep the Tauri command name `hermes_bridge` for Rust compatibility, but make its implementation Core-only:

- `core_request`
- `core_upload_path`
- sidecar/Core credential status/save/delete

No Tauri bridge action should read or write `.hermes`.

## Implementation Instructions

### 1. Add Core Agent Resource Endpoints

In `sidecar/src/hermes_management_server/main.py`, add agent-scoped equivalents for every profile-scoped operation:

- `GET /v1/agents/{agent_id}/memory`
- `PUT /v1/agents/{agent_id}/memory/{file}`
- `DELETE /v1/agents/{agent_id}/memory/{file}`
- `GET /v1/agents/{agent_id}/skills`
- `GET /v1/agents/{agent_id}/skills/{skill_id}`
- `POST /v1/agents/{agent_id}/skills`
- `PUT /v1/agents/{agent_id}/skills/{skill_id}`
- `POST /v1/agents`
- `POST /v1/agents/{agent_id}/clone`
- `PATCH /v1/agents/{agent_id}`
- `DELETE /v1/agents/{agent_id}`
- `POST /v1/agents/{agent_id}/activate`

Resolve the agent through `RuntimeRegistry.agent(agent_id)`, then call adapter methods. Do not let route handlers import or call `HermesStore` directly for these operations.

### 2. Move Profile, Memory, And Skill Operations Into The Runtime Adapter Interface

Create a runtime adapter contract, either as a protocol in `runtime_registry.py` or a new module such as `sidecar/src/hermes_management_server/runtime_adapters/base.py`.

The contract should include:

- `list_agents()`
- `get_agent(agent_id)`
- `create_agent(name, metadata)`
- `clone_agent(source_agent, name)`
- `rename_agent(agent, name)`
- `activate_agent(agent)`
- `delete_agent(agent)`
- `agent_memory(agent)`
- `save_agent_memory(agent, file, content, expected_updated_at)`
- `reset_agent_memory(agent, file)`
- `list_agent_skills(agent)`
- `get_agent_skill(agent, skill_id)`
- `create_agent_skill(agent, payload)`
- `save_agent_skill(agent, skill_id, payload)`
- existing conversation, message, model, slash-command, automation, probe, and send methods.

Implement the Hermes version in `runtime_adapters/hermes.py`. It may call helper code that reads or writes `.hermes`, but that code must be reachable only through Core runtime adapter methods.

### 3. Encapsulate Direct Hermes Filesystem Helpers

Move or rename `HermesStore` so it is clearly private to the Hermes adapter. A good shape is:

- `runtime_adapters/hermes/filesystem.py`
- `runtime_adapters/hermes/conversations.py`
- `runtime_adapters/hermes/jobs.py`
- `runtime_adapters/hermes/catalogs.py`

Keep the direct `.hermes` operations in those modules, and make them private adapter implementation details. The rest of Core should depend on the adapter interface, not on `HermesStore`.

Profile create, clone, rename, activate, delete, memory save/reset, and skill save should be implemented once in the Hermes adapter and called by Core endpoints. Delete the duplicate local implementations from `desktop/src-tauri/python/hermes_bridge.py`.

### 4. Replace Desktop Hermes Facade Calls With Core Calls

In `desktop/src/lib/agentuiCore.ts`, add typed client functions for the new endpoints:

- `getAgentUICoreStatus()`
- `getAgentUICoreAgentMemory(agentId)`
- `saveAgentUICoreAgentMemory(agentId, file, payload)`
- `resetAgentUICoreAgentMemory(agentId, file, payload)`
- `getAgentUICoreAgentSkills(agentId)`
- `getAgentUICoreAgentSkill(agentId, skillId)`
- `createAgentUICoreAgentSkill(agentId, payload)`
- `saveAgentUICoreAgentSkill(agentId, skillId, payload)`
- `createAgentUICoreAgent(payload)`
- `cloneAgentUICoreAgent(agentId, payload)`
- `renameAgentUICoreAgent(agentId, payload)`
- `activateAgentUICoreAgent(agentId)`
- `deleteAgentUICoreAgent(agentId)`

Then update `desktop/src/lib/hermes.ts` so these functions no longer call bridge actions for status, memory, skills, skill detail, skill save, or profile actions. Keep Hermes-shaped export names only as compatibility wrappers that immediately call `agentuiCore.ts`.

After this step, any remaining bridge calls from `desktop/src/lib/hermes.ts` must be Core credential helpers.

### 5. Make The Tauri Bridge Core-Only

Refactor `desktop/src-tauri/python/hermes_bridge.py` so its handler table contains only:

- `core_request`
- `core_upload_path`
- `remote_credential_status`
- `remote_credential_save`
- `remote_credential_delete`

Remove:

- `status`
- `profiles`
- `memory`
- `memory_save`
- `memory_reset`
- `skills`
- `skill_detail`
- `skill_save`
- `profile_create`
- `profile_clone`
- `profile_rename`
- `profile_switch`
- `profile_delete`
- all local profile, memory, skill, and `.hermes` filesystem helper functions.

Rename credential constants and token kinds from Hermes-centered names to Core-centered names:

- `HERMES_API_TOKEN_ACCOUNT` -> remove
- `SIDECAR_TOKEN_ACCOUNT` -> `IRIS_CORE_TOKEN_ACCOUNT`
- `REMOTE_TOKEN_SERVICE` -> `Iris Desktop`
- `credential_kind()` should accept `core` and retain `sidecar` as a compatibility alias.

The bridge may still use `urllib` to call Iris Core and `Path.read_bytes()` to upload a user-selected local attachment file to Core. It must not infer `HERMES_HOME`, read `active_profile`, inspect `profiles/`, or mutate `memories/` or `skills/`.

### 6. Collapse Desktop Runtime Config To Core Configuration

In `desktop/src/app/runtimeConfig.ts` and Settings UI:

- Replace `gatewayUrl`, `profileApiUrls`, and `profileSidecarUrls` with a single `coreApiUrl`.
- Keep a migration reader that maps old `managementApiUrl` or `profileSidecarUrls[selectedProfile]` into `coreApiUrl`.
- Stop exposing `Hermes API` URL and token fields in Settings.
- Show Core health and runtime health separately: Core health comes from `/v1/health`; runtime health comes from `/v1/runtimes/{runtime_id}/probe`.
- Remove `customHermesPath` from desktop configuration. Hermes home belongs to Core startup/runtime config.

Update all route-key memoization in chat, model catalog, slash commands, and automations to depend on `coreApiUrl` and selected agent/profile identity, not Hermes gateway URLs.

### 7. Update Core Runtime Configuration Ownership

Move Hermes gateway URL, Hermes adapter inbound URL, Hermes Jobs API token, and Hermes home into Iris Core runtime configuration.

Store these in the Core `runtimes` table:

- `connection.gatewayUrl`
- `connection.managementUrl` only if it refers to a Hermes-owned management endpoint; otherwise remove this confusing field.
- `connection.agentuiGatewayUrls`
- `connection.hermesHome`
- `connection.network`

Core should read environment defaults at startup, persist the effective runtime row with `CoreStore.upsert_runtime()`, and expose editable runtime settings through Core endpoints. Desktop should update these through Core, not local storage.

### 8. Replace Profile Endpoints In Desktop And Tests

Update desktop code to stop calling:

- `/v1/profiles`
- `/v1/profiles/{profile}`
- `/v1/profiles/{profile}/memory`
- `/v1/profiles/{profile}/skills`
- `/v1/profiles/{profile}/skills/{skill_id}`
- `/v1/profiles/{profile}/conversations`
- `/v1/profiles/{profile}/conversations/{conversation_id}`

Update tests that currently assert profile endpoints as the public API. Add tests for the agent-scoped replacements.

Any old profile endpoints retained for compatibility must have deprecation coverage, must delegate through the runtime adapter interface, and must not appear in desktop code, README happy paths, or new feature docs.

### 9. Preserve Core-Owned SQLite Semantics

Keep `CoreStore` focused on Core-owned state:

- `schema_meta`
- `devices`
- `runtimes`
- `device_cursors`
- `client_message_metadata`
- `attachments`
- `message_attachments`

Do not reintroduce Core-owned transcript, agent, message, or automation mirrors. Runtime-owned records should be normalized on read through adapters. Attachments and client message metadata can remain Core-owned because Iris creates them before delivery to the runtime.

### 10. Update Naming Without Breaking Compatibility

Rename new source toward Iris/Core naming:

- New hooks should use `useIrisRuntime`, `useIrisChat`, and `useIrisAutomations`.
- Keep aliases such as `useHermesRuntime`, `useHermesChat`, and `useHermesJobs` as compatibility exports while active imports are migrated.
- New types should use `IrisRuntimeConfig`, `IrisAgent`, `IrisConversation`, and `IrisAutomation`.
- Existing Hermes-shaped types can remain in a compatibility module while the UI migrates.

Do not add new Hermes-named wrappers.

### 11. Update Scripts And Docs

Update `scripts/dev.mjs`:

- Prefer `IRIS_CORE_HOST`, `IRIS_CORE_PORT`, `IRIS_CORE_TOKEN`, and `IRIS_CORE_STORE`.
- Pass Hermes-specific values only to Core startup, not to desktop.
- Rename log output from sidecar/Hermes management language to Iris Core language.
- Keep `HERMES_HOME` support as a Core runtime default, not a desktop setting.

Keep `scripts/install-agentui-platform.mjs` Hermes-aware because it installs the Hermes runtime adapter plugin. Rename user-facing output to `iris-hermes-adapter` language where possible while preserving the existing package path if changing the plugin directory would break Hermes installs.

Update:

- `README.md`
- `sidecar/README.md`
- `desktop/README.md`
- `desktop/PROJECT_STATUS.md`
- tests and fixtures that describe direct profile APIs or `.hermes` reads as client behavior.

### 12. Verification

Run:

```bash
npm run sidecar:test
npm --workspace desktop run check
npm run build
```

Add or update tests to prove:

- Desktop Core client functions hit agent-scoped Core endpoints.
- Tauri bridge no longer exposes profile, memory, skill, or status actions.
- Memory save/reset and skill create/save go through Core agent endpoints.
- Agent create/clone/rename/activate/delete go through Core and adapter methods.
- Core profile endpoints are unused by desktop.
- `rg -n "\\.hermes|HERMES_HOME|active_profile|state\\.db|/api/jobs|/agentui/|profileApiUrls|gatewayUrl|Hermes API" desktop/src desktop/src-tauri/python` returns no desktop bypasses, except test fixtures or compatibility labels intentionally tracked for removal.
- `rg -n "HermesStore|discover_conversations|state\\.db|/api/jobs|/agentui/" sidecar/src/hermes_management_server` shows Hermes-specific access only under the runtime adapter package.

Because this changes visible Settings/profile behavior and Core routing, run:

```bash
npm run build:mac:app
```

Launch the newly built macOS app bundle and verify with Computer Use against `com.nousresearch.hermes-agent.desktop`:

- App starts and connects to Iris Core.
- Settings shows Iris Core and runtime health without a desktop Hermes API route editor.
- Profile/agent list loads through Core.
- Memory loads, saves, and resets through Core.
- Skill list/detail loads through Core; creating or saving a skill works through Core.
- Agent/profile create, clone, rename, activate, and delete work through Core.
- New chat sends through Core and receives Hermes adapter delivery.
- Existing conversation list and detail load through Core.
- Model picker and slash-command menu still load through Core.
- Automations list, create, pause, resume, run, delete, and delivery rendering still work through Core.

## Completion Criteria

The work is complete when:

- Desktop has no direct Hermes API route configuration or direct Hermes credential path.
- Desktop and Tauri bridge do not read or write `.hermes`.
- Core exposes agent-scoped APIs for all UI-visible agent/profile, memory, skill, chat, model, slash command, automation, and runtime health operations.
- Hermes filesystem and Hermes HTTP/API calls are encapsulated inside the Core Hermes runtime adapter or inside `agentui-platform/adapter.py`.
- Existing Core SQLite cleanup behavior remains intact and duplicate runtime-owned tables are not recreated.
- Fresh Tauri app verification passes with the built bundle and Computer Use.
