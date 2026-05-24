# Consolidate sidebar collapse-state hooks into `usePersistedBooleanMap`

## Goal
Replace the three duplicated "persisted boolean map with a toggle" implementations that back the sidebar's collapse/expand trees with a single hook (`usePersistedBooleanMap(storageKey)`). User-visible behavior — which sections start collapsed, which projects/agents remember their collapsed state, persistence across reloads — must be identical to today.

## Current Behavior
The sidebar has four collapse/expand "trees":

1. Top-level sections (pinned / projects / chats / agents) — state in `AppShell`.
2. Agent profile folders inside the "agents" section — state in `AppShell`.
3. Project folders inside the "projects" section — state in the `useIrisProjects` hook.
4. The whole sidebar (⌘B + responsive resize) — **out of scope** here; not a `Record<string, boolean>` shape.

Trees 1–3 each have an effectively identical implementation: a `useState(() => loader())` over `Record<string, boolean>`, a `toggle(key)` that flips one entry and calls `saveJsonValue(storageKey, next)`, and a loader that JSON-parses + coerces values to booleans. The only differences are the storage key, the key space (`SidebarSectionId` vs project id vs profile name), and a couple of bespoke helpers (`expandSessions`, `setCollapsedProjectsValue`).

Concretely today:
- `apps/desktop/src/layout/AppShell.tsx:218` — `collapsedSessionProfiles` state.
- `apps/desktop/src/layout/AppShell.tsx:221` — `collapsedSidebarSections` state.
- `apps/desktop/src/layout/AppShell.tsx:1232` — `toggleSessionsCollapsed(profileName)`.
- `apps/desktop/src/layout/AppShell.tsx:1240` — `toggleSidebarSection(section)`.
- `apps/desktop/src/layout/AppShell.tsx:1285` — `expandSessions(profileName)` (force-expand for the "new chat in profile" path).
- `apps/desktop/src/layout/AppShell.tsx:1788` — `loadCollapsedSessionProfiles()`.
- `apps/desktop/src/layout/AppShell.tsx:1797` — `loadCollapsedSidebarSections()` (typed `Record<SidebarSectionId, boolean>` with an explicit `{ pinned, projects, chats, agents }` fallback).
- `apps/desktop/src/layout/AppShell.tsx:1961` — `saveCollapsedSessionProfiles()`.
- `apps/desktop/src/layout/AppShell.tsx:1965` — `saveCollapsedSidebarSections()`.
- `apps/desktop/src/features/projects/useIrisProjects.ts:36` — `collapsedProjects` state.
- `apps/desktop/src/features/projects/useIrisProjects.ts:158` — `toggleProjectCollapsed(projectId)`.
- `apps/desktop/src/features/projects/useIrisProjects.ts:166` — `setCollapsedProjectsValue(projectId, collapsed)` (forced state, used by `createProject`).
- `apps/desktop/src/features/projects/useIrisProjects.ts:195` — `loadCollapsedProjects()`.
- `apps/desktop/src/features/projects/useIrisProjects.ts:202` — `saveCollapsedProjects()`.

Storage keys (`apps/desktop/src/app/storage.ts:7-10`):
- `iris.desktop.sidebar.collapsedSections`
- `hermes.desktop.sidebar.collapsedSessions` (note: legacy `hermes.` prefix — DO NOT migrate as part of this change)
- `iris.desktop.sidebar.collapsedProjects`

## Desired Behavior
A single shared hook `usePersistedBooleanMap(storageKey, options?)` lives in `apps/desktop/src/app/` (e.g. `apps/desktop/src/app/usePersistedBooleanMap.ts`) and is used by all three call sites. Its API:

```ts
function usePersistedBooleanMap<K extends string = string>(
  storageKey: string,
  options?: { fallback?: Record<K, boolean> },
): {
  map: Record<K, boolean>;
  toggle: (key: K) => void;
  set: (key: K, value: boolean) => void;
};
```

- `map` is the current `Record<K, boolean>`.
- `toggle(key)` flips `map[key]` and persists the result.
- `set(key, value)` writes a specific value and persists the result.
- The hook reads from `localStorage` via the existing `loadJsonValue` / `saveJsonValue` helpers in `apps/desktop/src/app/storage.ts`. Non-object payloads fall back to `options.fallback ?? {}`. All values from storage are coerced via `Boolean(value)` (matches the current loaders).
- Persistence happens on every state change, same as today.

After the refactor:
- `AppShell.tsx` calls the hook twice (once for sections with the typed fallback, once for session profiles).
- `useIrisProjects.ts` calls the hook once.
- The bespoke `expandSessions` and `setCollapsedProjectsValue` helpers either stay as thin wrappers (calling `set(key, false)` / `set(key, value)`) or are inlined at their single call sites — implementer's call. Their external API to callers must not change.

Reload behavior, key spaces, and which JSON shapes are accepted from storage must be byte-identical to today (existing `localStorage` values from prior versions still load correctly).

## Findings

- **Finding**: Three near-identical `Record<string, boolean>` + toggle + persist implementations exist.
  - **Evidence**: `apps/desktop/src/layout/AppShell.tsx:218,221,1232,1240,1788,1797,1961,1965`; `apps/desktop/src/features/projects/useIrisProjects.ts:36,158,166,195,202`.
  - **Why it matters**: Each implementation must be kept in sync when the persistence model changes. Currently they already drift in minor ways (e.g. `useIrisProjects` exposes a `set`-by-value helper; `AppShell` exposes a force-expand-only helper).
  - **Confidence**: high.

- **Finding**: `loadCollapsedSidebarSections` has a typed fallback `{ pinned: false, projects: false, chats: false, agents: false }` while the other two loaders fall back to `{}`.
  - **Evidence**: `apps/desktop/src/layout/AppShell.tsx:1797-1808`.
  - **Why it matters**: The hook must accept an optional `fallback` so this call site keeps the same shape (especially for TypeScript — the consumer expects `Record<SidebarSectionId, boolean>`, not `Record<string, boolean>`).
  - **Confidence**: high.

- **Finding**: All three loaders coerce stored values with `Boolean(value)` and reject non-object / array payloads.
  - **Evidence**: `apps/desktop/src/layout/AppShell.tsx:1788-1795,1797-1808`; `apps/desktop/src/features/projects/useIrisProjects.ts:195-200`.
  - **Why it matters**: The shared hook must apply the same validation so legacy/corrupt entries don't cause a runtime crash.
  - **Confidence**: high.

- **Finding**: `collapsedSessionProfiles` uses the legacy `hermes.` storage key prefix; the other two use `iris.`.
  - **Evidence**: `apps/desktop/src/app/storage.ts:9` (`hermes.desktop.sidebar.collapsedSessions`).
  - **Why it matters**: This is intentional legacy compat. Migrating the key would orphan existing users' state. Leave the key as-is.
  - **Confidence**: high.

- **Finding**: `AppShell.test.ts` exercises the sidebar via props and via `localStorage` reads, including the `collapsedSidebarSections` key directly.
  - **Evidence**: `apps/desktop/src/layout/__tests__/AppShell.test.ts:64,124,179,227,255,327` (`collapsedProjects` is passed as a prop; the test stubs `localStorage.getItem` and matches on `storageKeys.collapsedSidebarSections`).
  - **Why it matters**: The refactor must not change which `localStorage` keys are read/written, and the props surface of `AppShell` should not change.
  - **Confidence**: high.

- **Finding**: The project-node and agent-node renders in `AppShell.tsx` (`renderProjectNode` at line 891, agent inline block starting at line 718) share visual shape but diverge in actions, menus, lazy-load semantics, and pin-key schemes.
  - **Evidence**: `apps/desktop/src/layout/AppShell.tsx:718-794,891-996`.
  - **Why it matters**: This is intentionally **out of scope** here. Do not attempt to unify these two node renderers — they have different reasons to change.
  - **Confidence**: high.

## Claims To Verify
- [ ] `apps/desktop/src/layout/AppShell.tsx:218` — `collapsedSessionProfiles` is created via `useState(() => loadCollapsedSessionProfiles())` and mutated only through `toggleSessionsCollapsed` (line 1232), `expandSessions` (line 1285), and the dependency of the auto-refresh `useEffect` at line 317.
- [ ] `apps/desktop/src/layout/AppShell.tsx:221` — `collapsedSidebarSections` is created via `useState(() => loadCollapsedSidebarSections())` and mutated only through `toggleSidebarSection` (line 1240). The derived booleans at lines 224–227 are read-only.
- [ ] `apps/desktop/src/features/projects/useIrisProjects.ts:36` — `collapsedProjects` is created via `useState(() => loadCollapsedProjects())` and mutated only through `toggleProjectCollapsed` (line 158) and `setCollapsedProjectsValue` (line 166); the latter is called from `createProject` at line 137 to force-expand a newly created project.
- [ ] `apps/desktop/src/app/storage.ts:7-10` — exactly three collapse-state storage keys exist: `collapsedSidebarSections`, `collapsedSessionProfiles`, `collapsedProjects`. The `hermes.` prefix on `collapsedSessionProfiles` is intentional legacy compat (see CLAUDE.md "Legacy compat" note in the project root).
- [ ] All three current loaders reject non-object / array payloads and coerce values with `Boolean(value)`. `loadCollapsedSidebarSections` additionally returns a typed `{ pinned: false, projects: false, chats: false, agents: false }` fallback.
- [ ] `apps/desktop/src/layout/__tests__/AppShell.test.ts` references `storageKeys.collapsedSidebarSections` (line 227) and passes `collapsedProjects` as an `AppShell` prop (lines 64, 124, 179, 255, 327). The `AppShell` prop surface for collapse state therefore should not change.
- [ ] No code outside `AppShell.tsx` and `useIrisProjects.ts` imports the existing `load*` / `save*` collapse helpers — verify with `rg "loadCollapsedSessionProfiles|saveCollapsedSessionProfiles|loadCollapsedSidebarSections|saveCollapsedSidebarSections|loadCollapsedProjects|saveCollapsedProjects" apps/desktop/src`.

## Implementation Plan

1. **`apps/desktop/src/app/usePersistedBooleanMap.ts`** (new file) — Implement and export:
   - `usePersistedBooleanMap<K extends string = string>(storageKey: string, options?: { fallback?: Record<K, boolean> }): { map: Record<K, boolean>; toggle: (key: K) => void; set: (key: K, value: boolean) => void; }`
   - Internally: `useState` with a lazy initializer that calls a private `loadBooleanMap(storageKey, fallback)` helper. That helper uses `loadJsonValue` from `apps/desktop/src/app/storage.ts`, returns `options.fallback ?? {}` if the parsed value is not a plain object, and otherwise coerces every value with `Boolean(value)`.
   - `toggle` and `set` both use the functional `setState` form, build the next object, call `saveJsonValue(storageKey, next)`, and return it.
   - No `useEffect` — persistence is synchronous inside the setter, matching today.

2. **`apps/desktop/src/layout/AppShell.tsx:218-227`** — Replace the two `useState` declarations and the four derived booleans with two calls to the new hook:
   ```ts
   const collapsedSessionProfiles = usePersistedBooleanMap(storageKeys.collapsedSessionProfiles);
   const collapsedSidebarSections = usePersistedBooleanMap<SidebarSectionId>(
     storageKeys.collapsedSidebarSections,
     { fallback: { pinned: false, projects: false, chats: false, agents: false } },
   );
   ```
   Update the derived `projectsSectionCollapsed` / `chatsSectionCollapsed` / `agentsSectionCollapsed` / `pinnedSectionCollapsed` consts to read `collapsedSidebarSections.map.<key>`. Update the `useEffect` dependency at line 317 from `collapsedSessionProfiles` to `collapsedSessionProfiles.map` (and the lookup inside from `collapsedSessionProfiles[profile.name]` to `collapsedSessionProfiles.map[profile.name]`).

3. **`apps/desktop/src/layout/AppShell.tsx:694,772-793`** — Update agent-node render to read `collapsedSessionProfiles.map[profile.name]` instead of `collapsedSessionProfiles[profile.name]`.

4. **`apps/desktop/src/layout/AppShell.tsx:1232-1246`** — Delete `toggleSessionsCollapsed` and `toggleSidebarSection`. Replace their call sites:
   - Line 726 (agent profile-node click): `collapsedSessionProfiles.toggle(profile.name)`.
   - Line 1258 (`renderSidebarSectionToggle` onClick): `collapsedSidebarSections.toggle(section)`.

5. **`apps/desktop/src/layout/AppShell.tsx:1285-1292`** — Delete `expandSessions`. Replace call sites at lines 764 and 1138 with `collapsedSessionProfiles.set(profileName, false)`.

6. **`apps/desktop/src/layout/AppShell.tsx:1788-1808,1961-1967`** — Delete `loadCollapsedSessionProfiles`, `loadCollapsedSidebarSections`, `saveCollapsedSessionProfiles`, and `saveCollapsedSidebarSections`. The hook owns this now.

7. **`apps/desktop/src/features/projects/useIrisProjects.ts:36-38`** — Replace the `useState(() => loadCollapsedProjects())` with `const collapsedProjects = usePersistedBooleanMap(storageKeys.collapsedProjects);`. Update internal reads (lines 112, 117, 122) from `collapsedProjects[project.id]` to `collapsedProjects.map[project.id]`.

8. **`apps/desktop/src/features/projects/useIrisProjects.ts:137,158-172`** — Replace `toggleProjectCollapsed` and `setCollapsedProjectsValue` with thin wrappers (or inline at call sites):
   ```ts
   const toggleProjectCollapsed = (projectId: string) => collapsedProjects.toggle(projectId);
   const setCollapsedProjectsValue = (projectId: string, collapsed: boolean) =>
     collapsedProjects.set(projectId, collapsed);
   ```
   The single internal call site at line 137 (`setCollapsedProjectsValue(result.project.id, false)`) stays the same.

9. **`apps/desktop/src/features/projects/useIrisProjects.ts:174-192`** — Keep the hook's return shape unchanged: still expose `collapsedProjects` as `Record<string, boolean>`. That means returning `collapsedProjects.map` (renamed locally if needed to avoid shadowing) rather than the hook object. Verify `App.tsx:256` (which passes `projects.collapsedProjects` to `AppShell`) still receives the same shape.

10. **`apps/desktop/src/features/projects/useIrisProjects.ts:195-203`** — Delete `loadCollapsedProjects` and `saveCollapsedProjects`.

## Non-Goals / Must Not Change
- The `AppShell` prop surface — `collapsedProjects: Record<string, boolean>` (AppShell.tsx:108) and `onToggleProjectCollapsed: (projectId: string) => void` (line 125) must stay exactly as today. The refactor is internal.
- The three `localStorage` keys (including the legacy `hermes.desktop.sidebar.collapsedSessions` prefix). Do not migrate the key namespace.
- Project-node vs agent-node JSX (AppShell.tsx:718-794, 891-996) — these are intentionally duplicated; do not attempt to unify.
- The section toggle helper `renderSidebarSectionToggle` (AppShell.tsx:1248) — already factored; leave alone aside from updating the onClick call.
- The whole-sidebar collapse logic (`sidebarCollapsed`, ⌘B handler at AppShell.tsx:233-243, responsive resize at 245-267). Different shape, not a boolean map.
- Pinned-session storage (`pinnedSessions` at AppShell.tsx:201 + `storageKeys.pinnedSessions`). Also a `Record<string, boolean>` but uses a different schema (composite keys with `:`) and is out of scope.
- Do not add or remove fields on any existing test fixtures other than where necessary to keep them compiling.

## Tests
- Run the desktop unit suite: `npm --workspace apps/desktop run test`.
- Run the AppShell tests specifically: `npm --workspace apps/desktop run test -- src/layout/__tests__/AppShell.test.ts`.
- Run the full pre-commit gate before declaring done: `npm run check`.
- No new automated tests are required; the existing `AppShell.test.ts` already exercises the section and project collapse paths via `localStorage` and prop assertions. If the implementer adds a unit test for the new hook, it should live at `apps/desktop/src/app/__tests__/usePersistedBooleanMap.test.ts` and cover: lazy initial load, toggle persists to `localStorage`, `set` persists, non-object payload falls back to `fallback`, value coercion.

## Verification
- `npm run dev:web` and load `http://localhost:1420/`. With the sidebar visible:
  - [ ] Collapse and expand each top-level section (pinned / projects / chats / agents). Reload — collapsed states persist.
  - [ ] In the projects tree, collapse a project. Reload — it stays collapsed. Click "new session" on a collapsed project — it expands and selects the new session.
  - [ ] Switch sidebar organization to "agents" via the sliders icon. Collapse/expand an agent profile folder. Reload — state persists. Click the per-profile "new chat" (square-pen icon) on a collapsed profile — it expands the profile.
  - [ ] Open DevTools → Application → Local Storage and confirm the same three keys are still being written: `iris.desktop.sidebar.collapsedSections`, `hermes.desktop.sidebar.collapsedSessions`, `iris.desktop.sidebar.collapsedProjects`.
  - [ ] Create a new project (Plus icon in the projects section header). The new project should appear expanded, not collapsed (verifies `setCollapsedProjectsValue(result.project.id, false)` path at `useIrisProjects.ts:137`).
- No restart of Core or reinstall of the Hermes plugin is needed; this is a pure desktop/React change and Vite HMR will pick it up.
- Acceptance: `npm run check` passes and the manual checks above all hold.

## Open Questions
- Should `expandSessions` and `setCollapsedProjectsValue` survive as named wrappers or be inlined at their (single) call sites? Implementer's discretion — both are equally clean. Default: keep them as wrappers to preserve grep-ability of intent at call sites.
- The hook's return shape: object (`{ map, toggle, set }`) vs tuple (`[map, toggle, set]`). The plan above assumes object form because it gives the third action (`set`) a name and avoids ambiguous destructuring at call sites. Confirm before implementing if a tuple is preferred.
