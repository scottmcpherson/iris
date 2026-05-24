# Agent Profile Skills Management

## Goal

Finish the redesigned Agents -> Skills tab so Iris can manage skills for each agent profile correctly.

End state:

1. Opening `Agents -> <profile> -> Skills` always shows the skills for that profile, even when the globally selected chat profile is different.
2. The user can create, edit, save, install/copy, and remove skills for the selected profile.
3. The profile skill count updates after skill changes.
4. The UI does not present fake community/bundled rows as real installable inventory unless they are backed by Core data.
5. Core remains the only layer that reads/writes Hermes profile skill files. Desktop never writes `~/.hermes` directly.
6. The user gets clear feedback about whether a skill change is available immediately, requires a fresh chat, or may require a Hermes gateway restart.

## Product Contract

Definitions for this implementation:

- **Agent profile**: a Core agent row whose `runtimeProfile` points at a Hermes profile such as `default` or `health`.
- **Installed skill**: a `SKILL.md` file under the selected profile's skills directory.
  - For the default profile this is currently `~/.hermes/skills/**/SKILL.md`.
  - For non-default profiles this is `~/.hermes/profiles/<profile>/skills/**/SKILL.md`.
- **Available skill**: a skill Core can copy into the selected profile. First implementation should use local, Core-visible sources, not a remote marketplace.
- **Install**: copy a skill into the selected profile's skills directory.
- **Remove**: delete an installed skill from the selected profile only.

Recommended first implementation scope:

1. Treat the target profile's `skills` directory as the source of truth for installed skills.
2. Expose local available skills from other Hermes profiles, prioritizing the default profile as the library most users will expect.
3. Do not ship hardcoded "community" rows as if they are real marketplace entries. Either replace them with Core-backed catalog rows, or hide/remove them until a real marketplace exists.
4. Keep the editor focused on `SKILL.md` content. Asset-folder management can come later.

User-facing language:

- Use "Installed in <profile>" for skills in the selected profile.
- Use "Available from <source profile>" for local skills that can be copied in.
- Use "Remove from <profile>" for destructive removal.
- After save/install/remove, prefer a short notice such as:
  - "Saved for default. New chats use the updated skill."
  - "Installed for health. Open a fresh chat if an existing session does not pick it up."
  - "Removed from health. Restart the Hermes gateway if skills are still cached."

Avoid:

- Claiming a remote community marketplace exists unless Core actually supplies it.
- Saying a skill is globally installed when it only exists in one profile.
- Refreshing or mutating the globally selected chat profile when the user is editing another agent profile.

## Current Repo State

Desktop:

- `apps/desktop/src/features/skills/SkillsView.tsx`
  - Receives `skills` as a prop.
  - Mixes that prop with hardcoded `fallbackSkills` and `communitySkills`.
  - Loads skill detail with `useSkillDetailQuery(runtimeConfig, profile, selectedSkillId)`.
  - Saves with `useSaveSkillMutation(runtimeConfig)`.
  - Has no delete/remove action.
  - Has no real install-from-catalog flow.
- `apps/desktop/src/features/agents/AgentDetailView.tsx`
  - Passes `selectedProfile` and `skills` into `SkillsView`.
- `apps/desktop/src/features/agents/AgentsView.tsx`
  - Receives one `skills` array and passes it through to the selected agent detail.
- `apps/desktop/src/App.tsx`
  - Passes `iris.skills` to `AgentsView`.
  - Wires Skills refresh as `onRefresh={() => void iris.refreshIris()}`, which can refresh the wrong profile when `agentDetailProfile !== iris.selectedProfile`.
- `apps/desktop/src/features/iris/useIrisRuntime.ts`
  - Stores one global `skills` array.
  - `skillsQuery` is keyed by `selectedProfile`.
  - `refreshIris(profile, { selectProfile: false })` can set global `skills` for a non-selected profile, but the selected-profile query effect can overwrite it later.
- `apps/desktop/src/lib/query/skills.ts`
  - Has list/detail/save queries and mutation invalidation.
  - No catalog/install/delete query APIs.
- `apps/desktop/src/lib/irisRuntime.ts`
  - Resolves profile -> Core agent -> Core skill endpoints.
- `apps/desktop/src/lib/irisCore.ts`
  - Exposes `GET /agents/:id/skills`, `GET /agents/:id/skills/:skill_id`, `POST /agents/:id/skills`, and `PUT /agents/:id/skills/:skill_id`.

Core:

- `iris-core/src/hermes_management_server/main.py`
  - Exposes agent-scoped list/detail/create/save skill routes.
  - Does not expose delete, catalog, or install/copy routes.
- `iris-core/src/hermes_management_server/runtime_adapters/base.py`
  - Protocol includes list/get/create/save skill methods only.
- `iris-core/src/hermes_management_server/runtime_adapters/hermes.py`
  - Delegates skill list/detail/save to `HermesStore`.
- `iris-core/src/hermes_management_server/runtime_adapters/hermes_store.py`
  - `profile_dir(root, "default")` returns the Hermes root.
  - `profile_dir(root, non_default)` returns `root / "profiles" / name`.
  - `skills(profile)` lists `skills/**/SKILL.md` for exactly that profile.
  - `save_skill(profile, payload, skill_id)` writes `SKILL.md` inside the active profile skills directory.
  - Skill ids are URL-safe base64 encodings of a relative `SKILL.md` path.
- `iris-core/tests/test_api.py` and `iris-core/tests/test_profiles.py`
  - Cover existing skill list/detail/create/save and path safety.

## Architecture Decisions

### 1. Make SkillsView profile-query-owned

Do not pass `iris.skills` into `SkillsView`.

`SkillsView` should query its own profile-specific data using the `profile` prop:

```tsx
const skillsQuery = useSkillsQuery(runtimeConfig, profile, connected);
const installedSkills = skillsQuery.data?.skills ?? [];
```

This removes the global `iris.skills` cross-profile correctness risk for the Skills tab. The global `skills` state in `useIrisRuntime` can remain temporarily for other callers, but `SkillsView` should not depend on it.

### 2. Let Core own install/delete

Desktop should call Core APIs for install/delete. It should not read one skill, ferry the content through the browser, then write it into another profile unless there is no better option. Server-side copy keeps path validation, profile resolution, and overwrite checks in one place.

### 3. Keep hardcoded mock inventory out of management flows

The current hardcoded `communitySkills` and `fallbackSkills` were useful for layout, but they blur product truth. Replace them with one of:

1. Core-backed catalog data, preferred.
2. An empty-state message when no installed skills exist, acceptable if catalog is deferred.

Do not keep fake rows that can be "installed" by writing generated template content while claiming to be a community skill.

### 4. First catalog is local, not remote

First implementation should expose local available skills from Core-visible Hermes profiles:

- Installed skills for the target profile.
- Available skills from the default profile when editing a non-default profile.
- Optionally available skills from other non-target profiles.

Remote marketplace or bundled library integration can be added later with the same UI shape.

## Proposed Core API

Keep the existing endpoints:

```http
GET  /v1/agents/{agent_id}/skills
GET  /v1/agents/{agent_id}/skills/{skill_id}
POST /v1/agents/{agent_id}/skills
PUT  /v1/agents/{agent_id}/skills/{skill_id}
```

Add:

```http
GET    /v1/agents/{agent_id}/skills/catalog
POST   /v1/agents/{agent_id}/skills/install
DELETE /v1/agents/{agent_id}/skills/{skill_id}
```

Suggested response/request shapes:

```ts
type HermesSkillCatalogItem = HermesSkill & {
  catalogId: string;
  installed: boolean;
  sourceProfile: string;
  sourceAgentId: string;
  sourceSkillId: string;
  targetProfile: string;
  conflict?: boolean;
  contentHash?: string;
};

type HermesSkillCatalog = {
  ok: boolean;
  profile: string;
  installed: HermesSkill[];
  available: HermesSkillCatalogItem[];
  generatedAt: number;
  error?: string;
};

type HermesSkillInstallRequest = {
  sourceAgentId?: string;
  sourceProfile?: string;
  sourceSkillId: string;
  overwrite?: boolean;
};

type HermesSkillDeleteRequest = {
  confirm?: string;
};

type HermesSkillDeleteResult = {
  ok: boolean;
  profile: string;
  deletedSkillId: string;
  deletedPath: string;
  error?: string;
};
```

Implementation notes:

- `catalogId` can be `${sourceAgentId}:${sourceSkillId}`.
- `sourceSkillId` should remain the existing encoded relative `SKILL.md` id for the source profile.
- `installed` should be true only for target-profile skills.
- `conflict` means copying the source skill to the target profile would overwrite an existing target skill at the same relative path.
- `contentHash` is useful for dedupe/conflict display. It can be optional if adding it to `SkillSummary` is too broad for the first pass.

## Core Implementation Plan

### 1. Models

File: `iris-core/src/hermes_management_server/models.py`

Add request models near `AgentSkillSaveRequest`:

```py
class AgentSkillInstallRequest(BaseModel):
    sourceAgentId: str = ""
    sourceProfile: str = ""
    sourceSkillId: str
    overwrite: bool = False


class AgentSkillDeleteRequest(BaseModel):
    confirm: str = ""
```

If using `contentHash`, extend `SkillSummary`:

```py
contentHash: str | None = None
```

This is additive and should not break existing clients.

### 2. Runtime Adapter Protocol

File: `iris-core/src/hermes_management_server/runtime_adapters/base.py`

Add:

```py
def list_agent_skill_catalog(self, agent: dict[str, Any]) -> dict[str, Any]: ...
def install_agent_skill(self, agent: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]: ...
def delete_agent_skill(self, agent: dict[str, Any], skill_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]: ...
```

### 3. HTTP Routes

File: `iris-core/src/hermes_management_server/main.py`

Add routes beside the existing skill routes:

```py
@app.get("/v1/agents/{agent_id}/skills/catalog")
async def core_agent_skill_catalog(...):
    agent = app.state.runtime_registry.agent(agent_id)
    ...
    return await run_runtime_call(app, adapter.list_agent_skill_catalog, agent)


@app.post("/v1/agents/{agent_id}/skills/install")
async def core_install_agent_skill(..., request: AgentSkillInstallRequest, ...):
    agent = app.state.runtime_registry.agent(agent_id)
    ...
    return await run_runtime_call(app, adapter.install_agent_skill, agent, dump_model(request))


@app.delete("/v1/agents/{agent_id}/skills/{skill_id}")
async def core_delete_agent_skill(..., request: AgentSkillDeleteRequest | None = None, ...):
    agent = app.state.runtime_registry.agent(agent_id)
    ...
    return await run_runtime_call(app, adapter.delete_agent_skill, agent, skill_id, dump_model(request) if request else {})
```

Route-order warning:

- Put `/skills/catalog` and `/skills/install` before `/skills/{skill_id}` if route matching could treat `catalog` or `install` as `skill_id`.
- FastAPI usually handles static paths correctly, but keeping static routes first is clearer.

DELETE body note:

- Desktop `coreRequest` can send JSON bodies with DELETE.
- The Tauri `core_bridge.py` supports DELETE and JSON body already.

### 4. Hermes Adapter

File: `iris-core/src/hermes_management_server/runtime_adapters/hermes.py`

Add methods:

```py
def list_agent_skill_catalog(self, agent: dict[str, Any]) -> dict[str, Any]:
    profile = str(agent["runtimeProfile"])
    store = self.require_store()
    return store.skill_catalog(profile, target_agent=agent)


def install_agent_skill(self, agent: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    profile = str(agent["runtimeProfile"])
    summary, content = self.require_store().install_skill(profile, payload, agent_resolver=self.get_agent)
    return {"ok": True, "profile": profile, "skill": {"content": content, "history": [], **summary.model_dump()}}


def delete_agent_skill(self, agent: dict[str, Any], skill_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    profile = str(agent["runtimeProfile"])
    result = self.require_store().delete_skill(profile, skill_id)
    return {"ok": True, "profile": profile, **result}
```

The exact resolver may differ. If the adapter cannot easily resolve source agent id, make the install request use `sourceProfile` only and validate it through `HermesStore.validate_profile_name`.

### 5. HermesStore

File: `iris-core/src/hermes_management_server/runtime_adapters/hermes_store.py`

Add helper methods:

```py
def skill_catalog(self, profile: str) -> dict[str, Any]:
    target = validate_profile_name(profile)
    installed = self.skills(target)
    available = []
    for source_profile in self.discover_profile_names():
        if source_profile == target:
            continue
        for summary in self.skills(source_profile):
            available.append(catalog_item_for(source_profile, target, summary, installed))
    return {
        "ok": True,
        "profile": target,
        "installed": installed,
        "available": available,
        "generatedAt": checked_at(),
    }
```

Install behavior:

1. Validate target profile.
2. Resolve source profile from `payload["sourceProfile"]` or `payload["sourceAgentId"]`.
3. Use `skill_detail(source_profile, source_skill_id)` to get source summary/content.
4. Preserve source relative path by decoding `source_skill_id`.
5. Compute target path as `target_skills_dir / source_relative_path`.
6. Reject overwrite with HTTP 409 if target path exists and `overwrite` is false.
7. Write the exact source content to the target path.
8. Return the target summary/content.

Delete behavior:

1. Validate target profile.
2. Use `safe_skill_path(skills_dir, directory, skill_id)` to resolve target `SKILL.md`.
3. Return 404 if it does not exist.
4. Remove the skill directory that contains `SKILL.md`, not any ancestor category directory.
5. Safety checks before `shutil.rmtree`:
   - The directory to remove must be inside `skills_dir.resolve()`.
   - It must not equal `skills_dir.resolve()`.
   - It must contain the exact resolved `SKILL.md`.
6. After deletion, prune now-empty category directories up to but not including `skills_dir`.
7. Return `deletedSkillId` and `deletedPath`.

If deleting the whole skill directory feels too risky for the first patch, delete only `SKILL.md` and prune empty parents. In that case, label the UI "Remove skill entry" or document that assets are preserved. The product-preferred behavior is to remove the skill directory.

Path-safety tests are required.

### 6. README

File: `iris-core/README.md`

Update the Skills section to document:

- Catalog endpoint.
- Install endpoint.
- Delete endpoint.
- The fact that ids are still encoded relative `SKILL.md` paths.
- The endpoint only mutates the selected agent/profile's skills directory.

## Desktop Implementation Plan

### 1. Types

File: `apps/desktop/src/types/hermes.ts`

Add types:

```ts
export type HermesSkillCatalogItem = HermesSkill & {
  catalogId: string;
  installed: boolean;
  sourceProfile: string;
  sourceAgentId?: string;
  sourceSkillId: string;
  targetProfile: string;
  conflict?: boolean;
  contentHash?: string;
};

export type HermesSkillCatalog = {
  ok: boolean;
  profile: string;
  installed: HermesSkill[];
  available: HermesSkillCatalogItem[];
  generatedAt: number;
  error?: string;
};

export type HermesSkillDeleteResult = {
  ok: boolean;
  profile: string;
  deletedSkillId: string;
  deletedPath: string;
  error?: string;
};
```

Keep `HermesSkill["source"]` unchanged unless there is a real new source category. Use extra fields for profile/catalog metadata instead of overloading `"installed" | "bundled" | "community"`.

### 2. Core Client

File: `apps/desktop/src/lib/irisCore.ts`

Add:

```ts
export async function getIrisCoreAgentSkillCatalog(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesSkillCatalog>(runtime, "GET", `/agents/${encodeURIComponent(agentId)}/skills/catalog`);
}

export async function installIrisCoreAgentSkill(
  agentId: string,
  payload: { sourceAgentId?: string; sourceProfile?: string; sourceSkillId: string; overwrite?: boolean },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesSkillSaveResult>(runtime, "POST", `/agents/${encodeURIComponent(agentId)}/skills/install`, payload);
}

export async function deleteIrisCoreAgentSkill(agentId: string, skillId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesSkillDeleteResult>(
    runtime,
    "DELETE",
    `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
    {},
  );
}
```

Update `apps/desktop/src/lib/__tests__/irisCore.test.ts` route coverage to include the new paths.

### 3. Runtime Facade

File: `apps/desktop/src/lib/irisRuntime.ts`

Add profile-resolving functions:

```ts
export async function getIrisSkillCatalog(profile?: string, runtime?: HermesRuntimeConfig) { ... }
export async function installIrisSkill(payload: { profile?: string; sourceProfile?: string; sourceAgentId?: string; sourceSkillId: string; overwrite?: boolean; runtime?: HermesRuntimeConfig }) { ... }
export async function deleteIrisSkill(profile: string | undefined, skillId: string, runtime?: HermesRuntimeConfig) { ... }
```

Use the existing pattern:

1. Resolve `getIrisCoreAgentForProfile(profile || "default", runtime)`.
2. Return a shaped `ok: false` result if resolution fails.
3. Call the Core endpoint with `agentResult.agent.id`.
4. Preserve `agentResult.agent.runtimeProfile` in failure fallbacks.

Add helper fallbacks:

```ts
function emptySkillCatalog(profile: string, error = ""): HermesSkillCatalog { ... }
```

### 4. React Query

File: `apps/desktop/src/lib/query/skills.ts`

Add query keys:

```ts
catalog: (runtimeKey: string, profile: string) =>
  [...skillKeys.all(runtimeKey), "catalog", profile || "default"] as const,
```

Add:

```ts
export function skillCatalogQueryOptions(runtime: HermesRuntimeConfig, profile = "default", enabled = true) { ... }
export function useSkillCatalogQuery(runtime: HermesRuntimeConfig, profile = "default", enabled = true) { ... }
export function useInstallSkillMutation(runtime: HermesRuntimeConfig) { ... }
export function useDeleteSkillMutation(runtime: HermesRuntimeConfig) { ... }
```

Mutation invalidation:

- Invalidate `skillKeys.list(routeKey, profile)`.
- Invalidate `skillKeys.catalog(routeKey, profile)`.
- Invalidate matching detail only when known.
- Invalidate `statusKeys.all(routeKey)` so profile `skillCount` refreshes.

Import `statusKeys` from `./status`.

### 5. Remove Skills Prop Plumbing

Files:

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/features/agents/AgentsView.tsx`
- `apps/desktop/src/features/agents/AgentDetailView.tsx`
- `apps/desktop/src/features/agents/__tests__/AgentDetailView.test.tsx`

Change:

- Stop passing `skills={iris.skills}` into `AgentsView`.
- Remove `skills` from `AgentsViewProps`.
- Remove `skills` from `AgentDetailViewProps`.
- `SkillsView` should receive:

```ts
profile: string;
runtimeConfig: HermesRuntimeConfig;
connected: boolean;
onProfileSkillsChanged?: (profile: string) => void;
```

In `App.tsx`, wire `onProfileSkillsChanged` to refresh the correct profile without selecting it:

```ts
onProfileSkillsChanged={(profileName) =>
  void iris.refreshIris(profileName, iris.runtimeConfig, {
    loadProfileData: false,
    selectProfile: false,
    silent: true,
  })
}
```

If `refreshIris` options are not public enough for this call, add a small wrapper to `useIrisRuntime` rather than reusing the selected-profile refresh path.

### 6. SkillsView Data Flow

File: `apps/desktop/src/features/skills/SkillsView.tsx`

Replace prop data with query data:

```tsx
const skillsQuery = useSkillsQuery(runtimeConfig, profile, connected);
const catalogQuery = useSkillCatalogQuery(runtimeConfig, profile, connected);
const installedSkills = skillsQuery.data?.skills ?? [];
const availableSkills = catalogQuery.data?.available ?? [];
```

Recommended UI grouping:

- First group: installed skills, grouped by category as today.
- Optional second mode/filter: available skills from catalog.
- Keep search across name, description, category, tags, source profile.
- Keep source filter, but update options to match real data:
  - all
  - installed
  - available
  - profile/default or source profile if useful

Do not show `fallbackSkills` when the installed list is empty. Show a real empty state:

- "No skills installed for <profile>."
- Primary action: new skill.
- Secondary action: browse available if catalog has rows.

For available rows:

- Detail panel should show a read-only preview unless a user chooses Install.
- Primary button should say `Install`.
- On install success, switch selection to the installed skill returned by Core.
- If Core returns 409 conflict, show an overwrite confirmation or a clear notice.

For installed rows:

- Detail panel is editable.
- Primary button: `Save`.
- Secondary/destructive action: `Remove`.
- Remove should open a confirmation dialog naming the skill and profile.

Dirty-state behavior:

- Track `isDirty` by comparing `draftName`, `draftCategory`, and `draftContent` to the loaded detail.
- If the user selects another skill with unsaved changes, either:
  - show a discard confirmation, preferred, or
  - keep a simple notice and block selection until save/discard.

Accessibility/design:

- Use existing shadcn primitives already present in the repo.
- Use lucide icons for install/remove/save.
- Do not add explanatory instructional copy inside the app beyond needed empty/error states.
- Keep compact desktop-surface sizing consistent with the redesigned page.

### 7. Runtime Feedback

After mutations:

- Save: "Saved for <profile>. New chats use the updated skill."
- Install: "Installed for <profile>. Open a fresh chat if an existing session does not pick it up."
- Remove: "Removed from <profile>. Restart the Hermes gateway if skills are still cached."

Use the existing local `notice` area in the Skills tab for immediate inline feedback. A toast is optional if the rest of the app uses toasts for similar agent mutations.

When finishing the implementation, explicitly tell the user:

- Vite/dev session should pick up Desktop UI changes automatically.
- Iris Core must be restarted if Core Python routes changed and the existing `npm run dev` Core process does not reload.
- Hermes gateway/fresh chat guidance depends on the mutation as above.
- A packaged desktop build is required for final desktop verification of this visible UI change.

## Tests

### Core Tests

File: `iris-core/tests/test_api.py`

Add tests:

1. `test_agent_skill_delete_removes_only_target_profile_skill`
   - Create same skill relative path in default and `profiles/health`.
   - Delete from health agent.
   - Assert health skill is gone.
   - Assert default skill still exists.
   - Assert health `skillCount` updates to 0 after fetching agents/status.

2. `test_agent_skill_install_copies_from_default_profile`
   - Create source skill under default `skills/research/summarize/SKILL.md`.
   - Create target profile `health`.
   - POST install to health with `sourceProfile: "default"` and source skill id.
   - Assert target `profiles/health/skills/research/summarize/SKILL.md` content matches.
   - Assert response returns the target profile and target skill summary.

3. `test_agent_skill_install_rejects_conflict_without_overwrite`
   - Target already has same relative skill.
   - POST install without overwrite.
   - Assert 409.
   - Assert target content unchanged.

4. `test_agent_skill_catalog_marks_conflicts`
   - Source skill exists in default.
   - Target has same relative path.
   - Catalog for target includes available item with `conflict: true`.

5. Path safety tests
   - Deleting a malicious/non-decodable skill id returns 400.
   - Installing with unsafe source skill id returns 400.
   - Deleting cannot escape target profile skills directory.

File: `iris-core/tests/test_profiles.py`

Add lower-level `HermesStore` tests if the API tests become too broad:

- `delete_skill` prunes empty category directories but does not remove `skills_dir`.
- `install_skill` preserves source content and relative path.

### Desktop Tests

File: `apps/desktop/src/lib/__tests__/irisCore.test.ts`

- Add calls for catalog, install, and delete.
- Assert paths:
  - `GET /v1/agents/agent_default/skills/catalog`
  - `POST /v1/agents/agent_default/skills/install`
  - `DELETE /v1/agents/agent_default/skills/skill_1`

File: `apps/desktop/src/lib/query/__tests__/queryKeys.test.ts`

- Add catalog key coverage.
- Add mutation invalidation coverage if existing test helpers make this practical.

File: new `apps/desktop/src/features/skills/__tests__/SkillsView.test.tsx` if feasible.

Suggested tests:

1. Renders empty installed state for a profile with no installed skills and does not render hardcoded community rows.
2. Shows installed skills from the profile-specific query.
3. Shows available skills from catalog with source profile labels.
4. Calls install mutation with the selected profile and source skill id.
5. Calls delete mutation with the selected profile and selected installed skill id.

If hook mocking is awkward, prefer a focused integration test with `QueryClientProvider` and mocked Core transport/fetch.

### Existing Tests To Update

- `apps/desktop/src/features/agents/__tests__/AgentDetailView.test.tsx`
  - Remove `skills` fixture prop if the prop is removed.
  - Keep assertions that overview does not render skills previews.
- Any TypeScript compile errors from removed `skills` prop plumbing.

## Manual Verification

Lightweight dev checks while iterating:

1. Assume the user has `npm run dev` running.
2. Open the Vite surface in the Browser plugin at `http://localhost:1420/`.
3. Navigate to `Agents -> default -> Skills`.
4. Confirm:
   - Installed default skills load.
   - Search/filter works.
   - Editing and saving an installed skill updates that profile.
   - Profile skill count refreshes.
5. Create or use a non-default profile, for example `health`.
6. Navigate to `Agents -> health -> Skills`.
7. Confirm:
   - It does not show `default` installed skills as if they are installed in `health`.
   - Available default skills can be installed into `health`.
   - Removing a health skill does not remove the default profile's copy.
8. Switch back and forth between default and health while the selected chat profile is different.
9. Confirm the Skills tab keeps showing the route profile's data, not the globally selected chat profile's data.

Targeted commands:

```bash
npm --workspace apps/desktop run test -- apps/desktop/src/lib/__tests__/irisCore.test.ts
npm --workspace apps/desktop run test -- apps/desktop/src/lib/query/__tests__/queryKeys.test.ts
iris-core/.venv/bin/pytest iris-core/tests/test_api.py -k "skill"
```

Broader checks before handoff:

```bash
npm --workspace apps/desktop run build
npm run core:test
```

Final visible UI/desktop verification per repo instructions:

```bash
npm run build:mac:app
```

Then launch the newly built macOS app bundle and use the Computer Use plugin against `com.nousresearch.hermes-agent.desktop` for a packaged-app smoke test. Do not use raw `npm run tauri dev` for Computer Use verification.

## Implementation Order

Recommended sequence:

1. Add Core delete endpoint and tests.
2. Add Core catalog/install endpoints and tests.
3. Add Desktop Core client/runtime/query functions and route tests.
4. Remove `skills` prop plumbing from `App -> AgentsView -> AgentDetailView -> SkillsView`.
5. Make `SkillsView` query list/catalog by `profile`.
6. Remove hardcoded fake `fallbackSkills` and `communitySkills` from normal display.
7. Add install and remove UI flows.
8. Add mutation invalidation for skills, catalog, and status.
9. Add dirty-state handling.
10. Run targeted tests and Vite Browser checks.
11. Run build and packaged desktop verification.

## Acceptance Criteria

- `Agents/default/skills` and `Agents/health/skills` can be opened in either order and never leak the other profile's installed list.
- Creating a new skill under a non-default profile writes into `~/.hermes/profiles/<profile>/skills/...`, not `~/.hermes/skills/...`.
- Installing a default skill into a non-default profile copies the actual source `SKILL.md` content.
- Removing a skill from a non-default profile leaves the default profile copy untouched.
- `skillCount` refreshes after create/install/delete.
- Hardcoded community/bundled mock rows are no longer presented as real available inventory.
- Tests cover Core path safety and profile isolation.
- Browser/Vite and packaged app verification pass.

## Risks And Notes

- Deleting a whole skill directory may remove skill-specific assets. That is likely what users expect from "Remove skill", but keep path checks strict and never remove category or `skills` root directories.
- Existing Hermes/gateway behavior may cache skills. The UI should avoid promising live reload inside an existing chat.
- The current Core README still says "The service is read-only" in Security Notes, but Core now writes memory and skills. Update that wording if touched nearby.
- If memory profile-scoping work is still unmerged, avoid mixing this patch with memory changes. This plan is about skills only.
- The worktree currently has unrelated modified files. Do not revert them.
