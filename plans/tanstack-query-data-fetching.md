# TanStack Query Data Fetching Plan

## Goal

Introduce TanStack Query as the standard client-side server-state layer for Iris Desktop.

The intent is to reduce hand-rolled loading/error/cache state, make invalidation predictable after mutations, and give the UI a clearer data boundary now that Core transport is explicit and Iris supports only local and SSH loopback Core connections.

This plan assumes the local/SSH transport cleanup and `IRIS_TOKEN` loopback cleanup are complete or landing first. Query should not be introduced on top of hidden auth fallbacks or mixed remote transport behavior.

## Current State

TanStack Router is already installed, but TanStack Query is not currently in `desktop/package.json`.

Relevant data-fetching areas:

- `desktop/src/lib/coreTransport.ts`
  - Owns the explicit browser/native Core transport boundary.
- `desktop/src/lib/irisCore.ts`
  - Typed Iris Core endpoint wrappers.
- `desktop/src/lib/irisRuntime.ts`
  - Compatibility facade returning Hermes-shaped data from Core.
- `desktop/src/features/iris/useIrisRuntime.ts`
  - Owns runtime status, selected profile, memory, skills, refresh loops, and profile actions.
- `desktop/src/features/projects/useIrisProjects.ts`
  - Owns project list, selected project, project sessions, loading flags, and refresh behavior.
- `desktop/src/features/automations/useIrisAutomations.ts`
  - Owns automation list, automation delivery polling, mutations, and local loading/error state.
- `desktop/src/features/chat/useIrisChat.ts`
  - Owns session list, selected session details, optimistic message state, SSE/EventSource, polling fallback, and active stream reconciliation.
- `desktop/src/features/chat/useIrisModelCatalog.ts`
  - Hand-rolls model catalog loading/error state.
- `desktop/src/features/chat/useIrisSlashCommands.ts`
  - Hand-rolls slash command catalog loading/error state.
- `desktop/src/features/skills/SkillsView.tsx`
  - Fetches skill detail on selection via `useEffect`.
- `desktop/src/features/chat/components/MessageContent.tsx`
  - Fetches attachment data URLs and performs native media conversion as needed.

## Target Shape

Use TanStack Query for server state:

- Core status and runtime readiness.
- Agents/profiles.
- Memory and skills.
- Projects and project sessions.
- Automations and recent automation deliveries.
- Model catalogs.
- Slash command catalogs.
- Chat session lists and stable session details.

Do not use TanStack Query as the primary owner for:

- Composer input and draft UI state.
- Selected profile/project/session local UI state.
- Active chat streaming text.
- EventSource lifecycle.
- Native attachment conversion or local object URL lifecycle.
- SSH tunnel start/stop side effects, except as mutations that invalidate runtime/status queries afterward.

For chat, Query should own the persisted session list/details cache, while the existing stream reducer continues to own in-flight messages and applies server events into the Query cache.

## Design Principles

- Query functions should throw on failure. Current Core wrappers return `{ ok: false, error }`; add a small `ensureOk()` helper so Query sees failures as errors.
- Query keys must include runtime route identity. Local and SSH data for the same profile must not share cache entries.
- Mutations should invalidate the smallest useful query scope.
- SSE and polling events should update or invalidate Query caches explicitly; they should not create a second competing cache.
- Add Query incrementally, one feature slice at a time. Do not rewrite chat streaming first.
- Keep the existing typed Core client functions. Query should orchestrate caching and lifecycle, not replace endpoint wrappers.
- Keep Query code centralized and entity-oriented. Feature components should consume reusable query hooks/options instead of defining ad hoc keys and query functions inline.

## Implementation Plan

### 1. Install and Wire Query

Add dependencies:

- `@tanstack/react-query`
- Optional dev-only follow-up: `@tanstack/react-query-devtools`

Create a Query client module:

- `desktop/src/app/queryClient.ts`

Suggested defaults:

```ts
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      gcTime: 5 * 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});
```

Wire provider near the app root:

- `desktop/src/main.tsx`

Wrap the app in `QueryClientProvider`.

Keep retries disabled initially. Many Core errors represent runtime setup issues, not flaky internet requests, and automatic retries could make local/SSH diagnostics noisy.

### 2. Add Query Utilities and Entity Modules

Create:

- `desktop/src/lib/query/ensureOk.ts`
- `desktop/src/lib/query/runtimeKey.ts`
- `desktop/src/lib/query/index.ts`

Create entity modules under `desktop/src/lib/query/`:

- `agents.ts`
- `automations.ts`
- `events.ts`
- `memory.ts`
- `models.ts`
- `projects.ts`
- `sessions.ts`
- `skills.ts`
- `slashCommands.ts`
- `status.ts`

Each entity module should own its keys and reusable Query APIs for that domain. For example, `agents.ts` should contain agent list/detail/profile-resolution keys, query options/hooks, and CRUD mutations for create/clone/rename/activate/delete. `projects.ts` should do the same for project list/detail/session-linking operations. Avoid one giant `queryKeys.ts` file that becomes a dumping ground.

Suggested module shape:

```ts
export const agentKeys = {
  all: (runtimeKey: string) => ["agents", runtimeKey] as const,
  lists: (runtimeKey: string) => [...agentKeys.all(runtimeKey), "list"] as const,
  list: (runtimeKey: string) => [...agentKeys.lists(runtimeKey)] as const,
  detail: (runtimeKey: string, agentId: string) => [...agentKeys.all(runtimeKey), "detail", agentId] as const,
  byProfile: (runtimeKey: string, profile: string) => [...agentKeys.all(runtimeKey), "profile", profile] as const,
};

export function agentsQueryOptions(runtime: HermesRuntimeConfig) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: agentKeys.list(routeKey),
    queryFn: () => ensureOk(getIrisCoreAgents(runtime), "Could not load agents."),
  });
}

export function useAgentsQuery(runtime: HermesRuntimeConfig) {
  return useQuery(agentsQueryOptions(runtime));
}
```

Mutation hooks should live beside the matching entity keys so invalidation stays local and understandable:

```ts
export function useCreateAgentMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: (payload: CreateAgentPayload) =>
      ensureOk(createIrisCoreAgent(payload, runtime), "Could not create agent."),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.all(routeKey) });
      queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
    },
  });
}
```

Feature folders can still add thin feature-specific hooks when they combine multiple entity queries, but those hooks should compose the shared entity modules rather than inventing new keys.

`ensureOk()`:

```ts
export async function ensureOk<T extends { ok?: boolean; error?: string }>(
  promise: Promise<T>,
  fallback = "Request failed.",
) {
  const result = await promise;
  if (result.ok === false) throw new Error(result.error || fallback);
  return result;
}
```

Query key helpers should include a stable runtime route key. The keys should be exported from the relevant entity modules:

```ts
statusKeys.detail(runtimeKey, profile)
agentKeys.list(runtimeKey)
memoryKeys.agent(runtimeKey, agentId)
skillKeys.list(runtimeKey, agentId)
sessionKeys.list(runtimeKey, agentId)
sessionKeys.detail(runtimeKey, sessionId)
projectKeys.list(runtimeKey)
projectKeys.sessions(runtimeKey, projectId)
automationKeys.list(runtimeKey, agentId)
modelKeys.catalog(runtimeKey, agentId)
slashCommandKeys.catalog(runtimeKey, agentId)
```

Use `runtimeDataRouteKey(runtimeConfig)` from `runtimeConfig.ts` as the base cache partition. This is important because the same profile name can exist behind different local/SSH routes.

### 3. Migrate Runtime Status First

Start with `useIrisRuntime.ts`, because it is the app's central refresh loop.

Create:

- `desktop/src/features/iris/useIrisRuntimeQueries.ts`

Initial queries:

- status query: `getIrisStatus(runtimeConfig, selectedProfile)`
- active agent query if needed: `getIrisCoreAgentForProfile(profile, runtimeConfig)`
- memory query: `getIrisMemory(profile, runtimeConfig)`
- skills query: `getIrisSkills(profile, runtimeConfig)`

Keep local state for:

- `runtimeConfig`
- `selectedProfile`
- UI refresh spinners

Replace the manual 10-second status interval with `refetchInterval` on the status query, but keep SSH tunnel preparation explicit:

- Before status queries run, call `ensureActiveSshTunnel()` when the active runtime is SSH.
- If this is awkward inside a query function, introduce a small `usePreparedRuntimeConfig()` hook that ensures the tunnel and writes the updated forwarded port before dependent queries are enabled.

Mutation conversion:

- profile actions (`create`, `clone`, `rename`, `switch`, `delete`) become `useMutation`.
- On success, invalidate:
  - agents list
  - status
  - memory/skills for affected profiles when relevant
  - sessions list if profile identity changed

Acceptance for this phase:

- App status, selected profile, memory, and skills behave as before.
- Manual refresh maps to `queryClient.invalidateQueries()` or `refetch()`.
- Runtime offline state still renders the existing offline profile/status.

### 4. Migrate Model and Slash Catalogs

These are small, low-risk hooks.

Files:

- `desktop/src/features/chat/useIrisModelCatalog.ts`
- `desktop/src/features/chat/useIrisSlashCommands.ts`

Replace hand-rolled `useEffect` loading with `useQuery`.

Query keys:

- model catalog: runtime key + profile or resolved agent id
- slash commands: runtime key + profile or resolved agent id

Use `enabled` when:

- runtime is connected
- profile is known
- agent resolution succeeds

Retain local state for:

- model draft selection
- slash menu active/dismissed state

Acceptance:

- Model picker keeps current fallback selection behavior.
- Slash command menu still loads lazily and handles unavailable catalogs.

### 5. Migrate Projects

File:

- `desktop/src/features/projects/useIrisProjects.ts`

Queries:

- projects list: `getIrisProjects(runtimeConfig)`
- agents list: `getIrisCoreAgents(runtimeConfig)`
- project sessions: `getIrisProjectSessions(projectId, 80, runtimeConfig)`

Mutations:

- create project
- update project
- archive project
- link/unlink session if exposed by the hook

Invalidation:

- project mutations invalidate projects list.
- session link/unlink invalidates project sessions and affected chat session lists.

Keep local state for:

- selected project id
- local menu/dialog UI state

Acceptance:

- Project switching should not flash empty state unnecessarily.
- Use `placeholderData` or `keepPreviousData` behavior if TanStack Query version supports it cleanly.

### 6. Migrate Automations

File:

- `desktop/src/features/automations/useIrisAutomations.ts`

Queries:

- resolved agent
- automations list
- recent automation deliveries

Mutations:

- create automation
- update automation
- delete automation
- pause/resume/run automation

Invalidation:

- automation mutations invalidate automations list.
- run mutation also invalidates/pokes recent deliveries.

Polling:

- Replace the current manual interval for automations list with query `refetchInterval`.
- Keep delivery event polling separate at first if it depends on cursor refs.
- Later, delivery events can update Query cache via `queryClient.setQueryData()`.

Acceptance:

- Automation status updates within the same cadence as today.
- Running an automation surfaces delivery messages without a full page refresh.

### 7. Migrate Chat Session Lists and Stable Details

File:

- `desktop/src/features/chat/useIrisChat.ts`

This should be done after smaller feature slices, because chat owns streaming and optimistic UI.

Query-owned data:

- session list per runtime/profile/agent.
- selected session detail/messages once stable.

Hook-owned data that remains local:

- composer input.
- pending attachments.
- optimistic user message and assistant placeholder.
- active request ids.
- streaming assistant text.
- stream safety timers.
- EventSource lifecycle and polling fallback.

Suggested approach:

1. Replace `refreshSessions()` internals with a sessions query.
2. Keep the existing returned shape from `useIrisChat()` so `ChatView` does not change much.
3. On send:
   - Optimistically update local active messages as today.
   - Use a mutation for `sendIrisCoreMessage`.
   - On success, update sessions query data with returned session.
   - Invalidate selected session detail after the stream completes, not during every token.
4. On SSE event:
   - Continue feeding the stream reducer.
   - For completed/error events, invalidate or patch session detail and sessions list.

Do not try to model token-by-token streaming as a Query response. Query is the cache for persisted server state; streaming is an event subscription.

Acceptance:

- Existing chat tests continue to pass.
- Active streaming behavior is unchanged.
- Session list updates after send, rename, delete, project link, and assistant completion.

### 8. Attachment Handling

Leave attachment data loading outside the first Query migration.

Reasons:

- Attachment conversion can involve native bridge calls.
- Audio object URLs require explicit lifecycle and revocation.
- Some attachment fetches are user-triggered playback actions rather than general server state.

Possible later targeted Query use:

- Metadata/listing queries can use Query.
- Binary/data URL conversion should stay local or use a very narrow query with careful `gcTime` and cleanup.

### 9. Testing Strategy

Add focused tests per migration phase.

Runtime/status:

- Query provider test harness.
- Offline state when status query throws.
- Manual refresh invalidates/refetches.
- SSH runtime key changes partition cache.

Model/slash:

- Success, error fallback, and profile change behavior.

Projects:

- Mutation invalidation.
- Selected project persistence across refetch.

Automations:

- Mutation invalidation.
- Polling/refetch behavior.

Chat:

- Session list query loads on profile/runtime changes.
- Send mutation patches or invalidates session list.
- SSE completion invalidates stable detail without breaking active stream.

Test utilities:

- Add `renderWithQueryClient()` under the existing test helpers if one exists, or create `desktop/src/test/query.tsx`.
- Use a fresh `QueryClient` per test with retries disabled.

### 10. Verification

Lightweight checks during implementation:

- `npm --workspace desktop run test`
- Targeted Vitest files for each migrated feature.
- Browser/Vite check at `http://localhost:1420/` for visible data loading behavior.

Final verification for broad data fetching changes:

- `npm run build:mac:app`
- Launch fresh app bundle.
- Verify with Computer Use against `com.nousresearch.hermes-agent.desktop`.

Scenarios:

- Managed local startup/status.
- SSH profile connect and data load.
- Profile switch.
- Memory and skills load/save/reset.
- Project list and project session list.
- Automation list/create/pause/resume/run.
- Chat session list, send, stream completion, session refresh.
- Model and slash command catalogs.
- Attachment preview/playback for at least image and audio.

## Execution Sequence

Do this as one coordinated implementation, moving in dependency order so each later step can build on working Query infrastructure.

### Step 1: Query Foundation

- Install TanStack Query.
- Add `QueryClientProvider`.
- Add `ensureOk()` and query key helpers.
- Keep behavior unchanged beyond provider wiring.
- Add or update test utilities so component tests can render with a fresh `QueryClient`.

### Step 2: Runtime, Memory, Skills

- Migrate `useIrisRuntime`.
- Convert profile actions to mutations.
- Preserve SSH tunnel preparation before dependent Core queries run.
- Add runtime query tests.
- Verify manual refresh, status polling, profile switching, memory, and skills.

### Step 3: Model and Slash Catalogs

- Migrate model catalog loading.
- Migrate slash command loading.
- Preserve fallback catalog behavior and local draft/menu state.
- Add targeted success/error/profile-change tests.

### Step 4: Projects

- Migrate project list, agents list, and project session loading.
- Convert project mutations to Query mutations.
- Wire invalidation for project and session changes.
- Add targeted project cache/invalidation tests.

### Step 5: Automations

- Migrate automation list and automation mutations.
- Replace list polling with Query refetch behavior.
- Keep delivery cursor/event handling stable.
- Add invalidation and polling/refetch tests.

### Step 6: Chat Stable Server State

- Migrate session list and stable selected-session detail.
- Keep composer, optimistic messages, active streams, and EventSource lifecycle local.
- On send, completion, rename, delete, and project-link events, patch or invalidate the relevant Query caches.
- Add regression tests for active stream behavior.

### Step 7: Full Verification Pass

- Run targeted tests for every migrated feature.
- Run the full desktop test suite where the environment allows it.
- Use Browser against the Vite surface for visible data-loading checks.
- Build and verify the packaged app because this changes broad data-fetching behavior.

## Acceptance Criteria

- TanStack Query is the standard path for non-streaming Core server state.
- Query keys are partitioned by runtime route identity.
- Query functions throw on `{ ok: false }`.
- Mutations invalidate or patch the correct cache scopes.
- SSE/EventSource remains a subscription layer and updates Query cache only at stable boundaries.
- Chat streaming UX is unchanged.
- Native attachment conversion remains explicit and does not leak object URLs.
- Manual refreshes and setup retries still work.
- Local and SSH runtime data do not cross-contaminate caches.

## Open Questions

- Should the Query Devtools be included only in Vite dev builds, or skipped entirely for desktop?
- Should runtime status polling stay at the current cadence, or should status use a longer stale time once Core is healthy?
- Should Core endpoint wrappers eventually throw directly, or should `ensureOk()` stay at the Query boundary?
- Should chat session details use infinite queries if histories become large, or keep the current bounded session/message fetches?
