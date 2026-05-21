# Routing, Deep Linking, and Route Persistence

## Goal

Add first-class app routing to Iris so the visible view, selected chat/session, selected project, selected agent detail, and top-level settings/automations destinations survive browser refresh and can be opened through deep links on web, desktop, and eventually mobile.

End state:

1. Refreshing the Vite/web surface preserves the current route and reopens the same view when the referenced data still exists.
2. Packaged Tauri desktop app can reopen or refresh directly into a chat, project chat, agent detail, automation view, or settings without falling back to the default new chat screen.
3. Desktop deep links such as `iris://chat/session_123?profile=default` route into the existing app window.
4. Future mobile app links and universal links can reuse the same route schema and parser.
5. Programmatic navigation in the sidebar, command menu, native menu events, delivery notifications, project menus, profile menus, and chat history all go through one routing layer instead of scattered `setActiveView()` calls.
6. Runtime state remains owned by existing hooks. Routing should select and restore state, not replace chat/runtime/project data stores.

## Product Model

Use URLs for durable navigation state:

- Which major surface is open.
- Which chat/session is selected.
- Which project context is selected.
- Which runtime profile is selected for a chat when the URL needs to disambiguate.
- Which agent profile and section is open.
- Whether the user is on automations or settings.

Do not put ephemeral UI state in the URL:

- Sidebar width/collapse state.
- Pinned sessions.
- Collapsed sidebar sections/projects.
- Command menu open state.
- Dialog open state.
- Draft composer input.
- Onboarding dismissal.
- Toasts.
- Runtime request progress.
- Scroll positions in transcript/sidebar unless a future feature explicitly needs this.

The route should answer "where is the user in the app?" Existing hooks should continue to answer "what data is available and what is currently happening?"

## Current Repo State

Relevant files:

- `desktop/src/main.tsx`
  - Renders `<App />` directly with no router.
- `desktop/src/App.tsx`
  - Owns `activeView`, `chatProfile`, `agentDetailProfile`, `agentSection`, and wires app-level transitions.
  - `selectView()` calls `setActiveView()`.
  - Session selection handlers call `setActiveView("chat")`, `projects.selectProject(...)`, `setChatProfile(...)`, and `chat.loadSession(...)`.
  - Agent/settings handlers call `setActiveView(...)` directly.
  - Native app commands arrive over the Tauri event `iris://app-command`.
- `desktop/src/app/types.ts`
  - Defines `View = "chat" | "agents" | "jobs" | "settings"`.
- `desktop/src/app/navigation.ts`
  - Defines sidebar nav items for chat, agents, and jobs.
  - Uses `"jobs"` for automations.
- `desktop/src/layout/AppShell.tsx`
  - Receives `activeView`, selected session/project state, and event handlers.
  - Sidebar and session search are currently callback-driven.
- `desktop/src/features/chat/useIrisChat.ts`
  - Owns `selectedSessionId`, session lists, message detail loading, optimistic session replacement, and refresh/reconcile behavior.
  - Exposes `loadSession()` and `startNewSession()`.
  - Resets route-scoped chat state when the Core route key changes.
- `desktop/src/features/projects/useIrisProjects.ts`
  - Owns `selectedProjectId`.
  - Persists `selectedProjectId` to localStorage under `iris.desktop.selectedProjectId`.
- `desktop/src/features/automations/AutomationsView.tsx`
  - Uses the selected project as delivery/schedule context.
- `desktop/src-tauri/src/lib.rs`
  - Emits native app commands like `new-chat`, `command-menu`, `search`, and `refresh`.
  - No deep-link plugin or single-instance plugin is configured today.
- `desktop/src-tauri/tauri.conf.json`
  - No `plugins.deep-link` configuration exists.
- `desktop/package.json`
  - Does not include a router package or Tauri deep-link JS bindings.
- `desktop/src-tauri/Cargo.toml`
  - Does not include `tauri-plugin-deep-link` or `tauri-plugin-single-instance`.

## Architecture Decision

Use TanStack Router for the first implementation.

Reasons:

- Iris is already a strongly typed React/TypeScript app, and route params/search params should be typed rather than hand-parsed throughout the app.
- The app has domain identifiers where accidental route typos matter: session IDs, project IDs, runtime profiles, agent profiles, and agent sections.
- TanStack Router supports browser, hash, and memory history through a shared router model, which lets web, desktop, tests, and eventual mobile use the same route definitions with different history implementations.
- Search params are first-class enough to carry optional profile/project context without building a parallel URL state library.

Use a small app-specific route intent layer on top of the router:

```ts
export type IrisRouteIntent =
  | { type: "new-chat"; profile?: string; projectId?: string }
  | { type: "chat"; sessionId: string; profile?: string; projectId?: string }
  | { type: "agents"; profile?: string; section?: AgentDetailSection }
  | { type: "automations"; projectId?: string }
  | { type: "settings" };
```

This intent layer is important because Tauri deep links, future mobile app links, command menu actions, and sidebar clicks should all target the same navigation contract. UI code should not manually construct ad hoc URLs in many places.

## Route Schema

Initial route set:

```text
/                                  -> redirect/normalize to /chat/new
/chat/new                          -> empty chat composer
/chat/$sessionId                   -> unprojected chat session
/projects/$projectId/chat/new      -> new chat in a project context
/projects/$projectId/chat/$sessionId
/agents                            -> agents list
/agents/$profile                   -> agent profile detail, overview section
/agents/$profile/$section          -> agent profile detail section
/automations                       -> automations view
/settings                          -> settings view
```

Search params:

```text
profile=default
```

Rules:

- `profile` is optional on chat routes.
- If a session route omits `profile`, Iris should infer from session metadata when available, otherwise fall back to the currently selected/default profile.
- Project routes should set project context even before sessions finish loading.
- `section` must be validated against the `AgentDetailSection` union.
- Unknown routes should normalize to `/chat/new` after optionally surfacing a non-blocking toast.
- The legacy `"jobs"` view name should remain an internal type until it is renamed separately, but URLs should use `/automations`.

Examples:

```text
/chat/session_abc?profile=default
/projects/project_123/chat/session_abc?profile=research
/agents/default/memory
/automations?project=project_123
/settings
```

## Platform URL Strategy

Use clean browser history for web when the serving environment supports SPA fallback.

Use hash history for packaged Tauri desktop unless packaged-app verification proves clean history paths reload safely in the webview.

Rationale:

- Web users expect clean paths like `/chat/session_abc`.
- Vite dev server and production web hosts can serve `index.html` for client routes.
- Tauri packaged apps load static frontend assets. Hash history avoids relying on a webview/static-file fallback for paths that do not exist on disk.
- The app can still expose clean external links such as `iris://chat/session_abc` and map them internally to a hash-history route.

Implementation detail:

```ts
const history = isTauri()
  ? createHashHistory()
  : createBrowserHistory();
```

If later verification proves packaged Tauri can reliably refresh on clean paths across macOS/Windows/Linux/iOS/Android, this can switch to browser history for desktop without changing the route schema.

## Deep Link Strategy

Use Tauri v2 deep-link support for desktop.

Add Rust dependencies:

```toml
tauri-plugin-deep-link = "2"

[target."cfg(any(target_os = \"macos\", windows, target_os = \"linux\"))".dependencies]
tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }
```

Add JS dependency:

```json
"@tauri-apps/plugin-deep-link": "^2"
```

Configure schemes:

```json
{
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["iris"]
      }
    }
  }
}
```

Future mobile config should support both:

- Custom scheme: `iris://chat/session_abc`
- Universal/app links: `https://iris.app/open/chat/session_abc`

The mobile work should reuse the same parser and route intent types; only registration/configuration should differ by platform.

Deep-link handling rules:

- On startup, call `getCurrent()` and process any startup URLs.
- While running, call `onOpenUrl()` and process incoming URLs.
- On Windows/Linux, register the single-instance plugin first so the already-running app receives deep-link events instead of opening duplicate windows.
- Validate incoming URLs strictly.
- Accept only known schemes/hosts/path prefixes.
- Ignore or toast unsupported deep links rather than throwing during app startup.
- Bring the main window to the front when a valid link is received.

## Shared Route Parser

Add a platform-neutral parser:

```text
desktop/src/app/routing/routeIntent.ts
```

Responsibilities:

- Convert web/router state to `IrisRouteIntent`.
- Convert `IrisRouteIntent` to router navigation targets.
- Convert external URL strings to `IrisRouteIntent`.
- Validate route params and search params.
- Encode/decode IDs and profile names safely.

Suggested exported API:

```ts
export function parseIrisDeepLink(rawUrl: string): IrisRouteIntent | null;
export function routeIntentToPath(intent: IrisRouteIntent): {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string | undefined>;
};
export function isAgentDetailSection(value: string): value is AgentDetailSection;
```

Do not perform data loading in this module. It should be pure and easy to test.

## Router File Structure

Keep routes close to app architecture but separate from feature internals:

```text
desktop/src/app/routing/
  router.tsx
  history.ts
  routeIntent.ts
  deepLinks.ts
  __tests__/
    routeIntent.test.ts
    deepLinks.test.ts
```

Use code-based routes initially rather than file-based route generation.

Reasons:

- The current app is not route-split into page files.
- A code-based route tree keeps the migration low-churn.
- File-based routing/codegen can be adopted later once page boundaries are clearer.

Suggested route components can all render the existing `App` shell at first. The router's job in phase one is selection and persistence, not a page architecture rewrite.

## App State Synchronization

Add a single route controller near `App`.

Suggested shape:

```ts
function useApplyIrisRoute({
  intent,
  chat,
  projects,
  iris,
  setChatProfile,
  setAgentDetailProfile,
  setAgentSection,
}: ApplyIrisRouteOptions) {
  // one effect that reconciles route -> existing app state
}
```

Responsibilities:

- For `new-chat`:
  - Select project if `projectId` exists.
  - Set `chatProfile` if provided.
  - Call `chat.startNewSession()` only when transitioning into a new-chat route from a selected session route.
- For `chat`:
  - Select project if `projectId` exists, otherwise clear project selection.
  - Set `chatProfile` from the URL or inferred session profile.
  - Call `chat.loadSession(sessionId, profile)` when the selected session differs.
- For `agents`:
  - Open the agents surface.
  - Set `agentDetailProfile` and `agentSection` from route params.
  - Trigger `iris.refreshIris(profile, ..., { loadProfileData: true, selectProfile: false })` when opening a profile detail, matching current behavior.
- For `automations`:
  - Open automations.
  - Preserve or apply selected project context if present.
- For `settings`:
  - Open settings.

Guard against loops:

- Route-to-state effects should compare current state before writing.
- State-to-route helpers should navigate only from user/programmatic actions, not from every state change.
- Optimistic chat session replacement should update the URL when a temporary session ID becomes a canonical session ID.

## Navigation API

Add one app navigation hook:

```text
desktop/src/app/routing/useIrisNavigate.ts
```

Suggested API:

```ts
export function useIrisNavigate() {
  return {
    openNewChat(options?: { profile?: string; projectId?: string }): void;
    openChat(options: { sessionId: string; profile?: string; projectId?: string }): void;
    openAgent(options?: { profile?: string; section?: AgentDetailSection }): void;
    openAutomations(options?: { projectId?: string }): void;
    openSettings(): void;
    openIntent(intent: IrisRouteIntent): void;
  };
}
```

Replace direct `setActiveView()` calls with this API over time.

High-priority replacements:

- Sidebar nav items in `AppShell`.
- `onNewSession`.
- `onSelectSession`.
- `onSelectProjectSession`.
- `onEditProfile`.
- `AgentTopbar` back/section changes.
- Command menu view commands.
- Native app command handler.
- Runtime diagnostics "Open settings".
- Onboarding "Open settings".
- Automations delivery "Open chat".
- Chat project/profile changes that alter durable context.

## Implementation Phases

### Phase 1: Add Router Without Behavioral Rewrite

Files:

- `desktop/package.json`
- `desktop/package-lock.json`
- `desktop/src/main.tsx`
- `desktop/src/app/routing/router.tsx`
- `desktop/src/app/routing/history.ts`
- `desktop/src/app/routing/routeIntent.ts`
- `desktop/src/app/routing/useIrisNavigate.ts`

Steps:

1. Install `@tanstack/react-router`.
2. Create code-based route tree for the initial route schema.
3. Wrap the app in `RouterProvider`.
4. Make `/` normalize to `/chat/new`.
5. Keep `App` rendering mostly unchanged.
6. Add pure route-intent tests.

Verification:

```bash
cd desktop
npm run test -- routeIntent
npm run build
```

Browser/Vite check:

- Open `http://localhost:1420/`.
- Open `http://localhost:1420/chat/new`.
- Open `http://localhost:1420/agents`.
- Refresh each route and confirm the app mounts.

### Phase 2: Route Top-Level Views

Files:

- `desktop/src/App.tsx`
- `desktop/src/app/navigation.ts`
- `desktop/src/layout/AppShell.tsx`
- Router files from phase 1.

Steps:

1. Derive the active view from the route intent.
2. Replace `selectView()` internals with router navigation.
3. Update nav commands:
   - Chat/new session -> `/chat/new`
   - Agents -> `/agents`
   - Jobs/Automations -> `/automations`
   - Settings -> `/settings`
4. Keep `View = "jobs"` internally for minimal churn, but map route `automations` to view `"jobs"`.
5. Add tests for top-level route-to-view mapping.

Verification:

```bash
cd desktop
npm run test -- AppShell
npm run build
```

Browser/Vite check:

- Click each sidebar nav item.
- Confirm URL changes.
- Refresh on each route.
- Confirm selected nav state matches route.

### Phase 3: Chat, Session, Project, and Profile Persistence

Files:

- `desktop/src/App.tsx`
- `desktop/src/features/chat/useIrisChat.ts`
- `desktop/src/features/projects/useIrisProjects.ts`
- `desktop/src/features/chat/ChatView.tsx`
- `desktop/src/features/chat/components/ProjectMenu.tsx`
- Routing files.

Steps:

1. Add route controller behavior for:
   - `/chat/new`
   - `/chat/$sessionId`
   - `/projects/$projectId/chat/new`
   - `/projects/$projectId/chat/$sessionId`
2. Update session selection callbacks to navigate instead of manually selecting state.
3. Update project session selection callbacks to include project route params.
4. Update `chat.startNewSession()` and `chat.loadSession()` interactions so route changes do not cause duplicate resets.
5. When an optimistic chat receives a canonical session ID, replace the current URL with the canonical session URL.
6. Decide whether `useIrisProjects` should continue persisting `selectedProjectId`.
   - Preferred: keep localStorage as a fallback for non-route workflows, but route param wins when present.
7. Add tests for route-to-chat state reconciliation.

Important behavior:

- `/chat/new?profile=research` should open a blank composer with `chatProfile = "research"`.
- `/projects/project_123/chat/new` should set project context before sending.
- `/projects/project_123/chat/session_abc?profile=research` should call `chat.loadSession("session_abc", "research")`.
- If a project ID no longer exists, keep the route visible but clear project context and show a small non-blocking warning.
- If a session no longer exists, let the existing session-load error path surface the failure; do not silently rewrite the URL.

Verification:

```bash
cd desktop
npm run test -- useIrisChat
npm run test -- AppShell
npm run build
```

Browser/Vite check:

- Open a normal chat.
- Confirm URL becomes `/chat/<sessionId>?profile=<profile>`.
- Refresh and confirm the same chat loads.
- Open a project chat.
- Confirm URL includes `/projects/<projectId>/chat/<sessionId>`.
- Refresh and confirm project context remains selected.
- Start a new chat from a project and confirm URL is `/projects/<projectId>/chat/new`.

### Phase 4: Agent Detail Route Persistence

Files:

- `desktop/src/App.tsx`
- `desktop/src/features/agents/AgentsView.tsx`
- `desktop/src/features/agents/AgentTopbar.tsx`
- Routing files.

Steps:

1. Map `/agents` to list view.
2. Map `/agents/$profile` to profile overview detail.
3. Map `/agents/$profile/$section` to profile detail section.
4. Replace agent detail callbacks with router navigation.
5. Replace topbar back button with navigation to `/agents`.
6. Replace section tab changes with navigation to `/agents/$profile/$section`.
7. Validate invalid sections and normalize to overview.

Verification:

```bash
cd desktop
npm run test -- Agent
npm run build
```

Browser/Vite check:

- Open agents list.
- Open a profile.
- Switch sections.
- Refresh on each section route.
- Confirm profile detail and topbar state persist.

### Phase 5: Automations and Settings Routes

Files:

- `desktop/src/App.tsx`
- `desktop/src/features/automations/AutomationsView.tsx`
- `desktop/src/features/runtime/RuntimeDiagnosticsDialog.tsx`
- `desktop/src/features/polish/OnboardingOverlay.tsx`
- Routing files.

Steps:

1. Route `/automations` to the current jobs view.
2. Support optional project context on automations:
   - Either `/automations?project=project_123`
   - Or keep selected project in localStorage only if URL project context is not needed.
3. Route `/settings` to settings.
4. Replace all "open settings" callbacks with `openSettings()`.
5. Replace automations delivery open-chat behavior with `openChat()`.

Verification:

```bash
cd desktop
npm run test -- Automations
npm run build
```

Browser/Vite check:

- Open automations.
- Refresh.
- Open settings from diagnostics and onboarding.
- Confirm URL and visible view stay in sync.

### Phase 6: Desktop Deep Links

Files:

- `desktop/package.json`
- `desktop/package-lock.json`
- `desktop/src-tauri/Cargo.toml`
- `desktop/src-tauri/Cargo.lock`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src/app/routing/deepLinks.ts`
- `desktop/src/App.tsx`

Steps:

1. Add `@tauri-apps/plugin-deep-link`.
2. Add `tauri-plugin-deep-link`.
3. Add desktop `iris` scheme configuration.
4. Add `tauri-plugin-single-instance` with the `deep-link` feature for desktop builds.
5. Register single-instance plugin before deep-link plugin.
6. Add frontend startup and runtime listeners:

   ```ts
   import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
   ```

7. Parse incoming URLs with `parseIrisDeepLink()`.
8. Navigate through `openIntent()`.
9. Bring/show the main window on valid deep-link events.

Supported first-pass deep links:

```text
iris://chat/new
iris://chat/session_abc?profile=default
iris://projects/project_123/chat/new
iris://projects/project_123/chat/session_abc?profile=research
iris://agents/default
iris://agents/default/memory
iris://automations
iris://settings
```

Security/robustness:

- Reject unknown schemes.
- Reject unknown hosts/path shapes.
- Validate section names.
- Treat all IDs/profile names as opaque strings; do not execute or interpolate into shell commands.
- Keep parsing pure and covered by tests.

Verification:

```bash
cd desktop
npm run test -- deepLinks
npm run build:mac:app
```

Packaged desktop check:

- Launch the newly built app bundle.
- Trigger a deep link with macOS `open 'iris://settings'`.
- Trigger `open 'iris://chat/new?profile=default'`.
- Trigger an agent detail link.
- Confirm the existing app window is focused and routed.
- Confirm invalid links do not crash startup.

### Phase 7: Web Deployment Fallback

Files depend on deployment target. At minimum:

- `desktop/vite.config.ts`
- Future web hosting config if/when Iris web is deployed.

Steps:

1. Confirm Vite dev server serves app routes directly.
2. Document the production web requirement:
   - Serve static assets normally.
   - Rewrite unknown non-asset paths to `index.html`.
   - Do not rewrite API paths if web and API share a domain.
3. Add deployment-specific fallback config when a web host is chosen.

Verification:

```bash
cd desktop
npm run build
npm run preview
```

Browser check:

- Open `/chat/new` directly against preview server.
- Open `/agents/default` directly.
- Refresh nested routes.

### Phase 8: Mobile-Ready Link Contract

This phase can be mostly design/docs until the mobile shell exists.

Files:

- `desktop/src/app/routing/routeIntent.ts`
- `docs` or `.plans` follow-up for mobile link registration.
- Future mobile Tauri config.

Steps:

1. Keep route intent parser free of browser-only globals.
2. Keep external URLs parseable from plain strings.
3. Add test cases for:
   - `https://iris.app/open/chat/session_abc?profile=default`
   - `https://iris.app/open/projects/project_123/chat/session_abc`
   - `iris://chat/session_abc`
4. Document expected mobile registration:
   - Custom scheme for no-server links.
   - Universal/app links for shareable HTTPS links.

## Testing Plan

Unit tests:

- `parseIrisDeepLink()`.
- `routeIntentToPath()`.
- Section validation.
- Route-to-view mapping.
- Unknown/invalid route behavior.
- Optimistic session URL replacement helper.

React/component tests:

- AppShell nav calls routing callbacks.
- Session search selection navigates to the expected route.
- Agent section selection navigates to the expected route.
- Settings/automations command actions navigate to the expected route.

Integration/Vite checks:

- Direct load and refresh for each route.
- Browser back/forward between chat, agents, automations, and settings.
- Project chat selection and refresh.
- Agent detail section refresh.

Packaged Tauri checks:

- Build fresh macOS app bundle with `npm run build:mac:app`.
- Launch built bundle.
- Verify normal route navigation.
- Verify refresh/reopen behavior.
- Verify `iris://` deep links.
- Verify only one app instance handles links.

Do not run packaged desktop verification for every small intermediate UI-only iteration. Use Browser/Vite checks while developing, then serialize final packaged app verification according to `AGENTS.md`.

## Migration Notes

This should be done as a route-layer migration, not a feature rewrite.

Keep these existing abstractions:

- `useIrisRuntime()` for runtime/profile/status data.
- `useIrisChat()` for session lists, messages, sending, streaming, and selected session internals.
- `useIrisProjects()` for project lists and project-session loading.
- `AppShell` for layout.
- `AgentsView`, `ChatView`, `AutomationsView`, and `SettingsView` for feature UI.

Change these responsibilities:

- URL/router owns durable navigation target.
- `App` route controller applies durable navigation target to existing hooks.
- Existing click handlers navigate by intent.

Avoid:

- Moving Core/network fetching into route loaders in the first pass.
- Splitting every feature into page files.
- Putting dialogs and sidebar preferences into search params.
- Replacing localStorage preferences unrelated to routing.
- Introducing a global state library only for routing.

## Risks and Mitigations

### Route/state loops

Risk:

Route changes call existing state setters, and existing state changes navigate back, causing loops.

Mitigation:

- Use explicit user-action navigation helpers.
- Keep route-to-state in one controller.
- Compare current state before calling setters/loaders.
- Use `replace` for canonicalization and optimistic ID replacement.

### Session profile ambiguity

Risk:

A session ID may not identify the profile until history is loaded.

Mitigation:

- Prefer explicit `profile` in generated URLs.
- Infer from loaded session metadata when possible.
- Fall back to selected/default profile only when needed.
- Keep load failures visible.

### Project context mismatch

Risk:

The URL says project A but the session belongs to project B or no longer belongs to any project.

Mitigation:

- Treat URL project ID as the requested context.
- Refresh project sessions after session metadata resolves, as the app already does.
- If Core reports different metadata later, update the URL with `replace` only when the mismatch is certain.

### Packaged Tauri clean-path reload

Risk:

Browser history paths may not reload against static assets in packaged desktop.

Mitigation:

- Use hash history in Tauri initially.
- Keep route schema independent from the history implementation.
- Verify packaged behavior before considering clean desktop paths.

### Deep-link duplicate instances

Risk:

Windows/Linux may open a second app instance for a link.

Mitigation:

- Add `tauri-plugin-single-instance` with `deep-link` feature.
- Register it before the deep-link plugin.

### Mobile assumptions

Risk:

Desktop-only deep-link decisions make mobile awkward later.

Mitigation:

- Centralize parsing as string -> `IrisRouteIntent`.
- Support both custom-scheme and HTTPS universal/app link URL shapes in tests before mobile implementation.
- Keep platform registration separate from route semantics.

## Open Questions

1. Should project chat routes always include project ID, or should project context be represented only as `?project=` on `/chat/...`?

   Recommendation: use `/projects/$projectId/chat/...` for project-owned chat context. It is more readable and easier to share.

2. Should `jobs` be renamed to `automations` internally during this work?

   Recommendation: not in the routing migration. Map `/automations` to internal `"jobs"` and do the naming cleanup separately.

3. Should desktop use clean paths or hash paths?

   Recommendation: start with hash history only in Tauri. Revisit after packaged verification across target platforms.

4. Should route loaders fetch Core data?

   Recommendation: no for the first migration. Existing hooks already encode retries, runtime route keys, Core connectivity, event streams, and optimistic chat behavior.

5. Should the app restore the last route on bare `/`?

   Recommendation: initially normalize `/` to `/chat/new`. Add explicit last-route restoration later if users ask for it, because startup restoration can make broken/deleted sessions feel sticky.

## Suggested First PR Scope

Keep the first PR narrow:

1. Add TanStack Router.
2. Add route schema and route intent parser.
3. Route top-level views only:
   - `/chat/new`
   - `/agents`
   - `/automations`
   - `/settings`
4. Replace sidebar and command menu navigation for those views.
5. Add unit tests for route parsing/mapping.
6. Verify with Vite/browser refresh.

Then follow with separate PRs for:

- Chat/session/project persistence.
- Agent detail persistence.
- Tauri deep links.
- Mobile/universal link contract.

This keeps reviewable behavioral change small while establishing the final routing architecture.

