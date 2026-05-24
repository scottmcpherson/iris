# Iris mobile app Expo preparation

## Goal

Prepare the Iris monorepo for a first mobile app under `apps/mobile/`, built with React Native and Expo. The mobile app should reuse Iris Core API logic, query behavior, chat state helpers, and the Iris theme, while keeping native UI components separate from the desktop Tauri/React DOM interface.

The first mobile version is intentionally small:

1. Pair with a host Iris desktop machine by scanning a QR code shown in the desktop app.
2. Connect only through SSH to the host machine.
3. Show connection status.
4. Create and view projects.
5. View sessions.
6. Open a session and chat back and forth with the same Core-backed message flow as desktop.
7. Use the same Iris visual theme tokens as desktop, translated to React Native styles.

This plan should be implemented after the `apps/desktop/` layout migration has landed.

## Non-Goals For V1

- No packaged desktop verification unless the pairing UI adds Tauri bridge or backend behavior that cannot be tested in Vite.
- No mobile attachments, voice dictation, memory editing, skills management, automations, model management, profile configuration, local Hermes control, or desktop-like dense sidebars.
- No attempt to share desktop TSX UI components with mobile. Desktop components are CSS/Tauri/DOM-shaped; mobile should be native React Native UI.
- No private keys or long-lived secrets encoded in QR codes.
- No direct Core URL/manual LAN mode in mobile. Mobile connects to Iris Core through SSH only.

## Recommended Technology

Use Expo with a custom development build, not Expo Go.

Reasons:

- Expo Router is the current recommended routing approach for Expo apps and gives a file-based navigation model that fits `projects -> sessions -> chat`.
- Expo Camera supports QR scanning for the pairing flow.
- SSH, secure key storage, and any local port-forward/tunnel behavior may require native modules, which means Expo Go is too constrained. A development build includes the native libraries needed by the app.

Useful docs:

- Expo development builds: https://docs.expo.dev/develop/development-builds/introduction/
- Expo Router: https://docs.expo.dev/router/introduction/
- Expo navigation recommendation: https://docs.expo.dev/develop/dynamic-routes/
- Expo Camera: https://docs.expo.dev/versions/latest/sdk/camera/
- React Native style model: https://reactnative.dev/docs/style
- React Native colors: https://reactnative.dev/docs/colors

## Target Repo Shape

Create a shared package layer instead of importing from `apps/desktop/src/*`.

```text
apps/
  desktop/
  mobile/

packages/
  core-client/
  iris-query/
  chat-core/
  theme/
```

Update root workspaces:

```json
{
  "workspaces": [
    "apps/*",
    "packages/*"
  ]
}
```

Add root scripts:

```json
{
  "scripts": {
    "mobile:dev": "npm --workspace apps/mobile run start",
    "mobile:ios": "npm --workspace apps/mobile run ios",
    "mobile:android": "npm --workspace apps/mobile run android",
    "mobile:test": "npm --workspace apps/mobile run test",
    "mobile:typecheck": "npm --workspace apps/mobile run typecheck"
  }
}
```

Keep `apps/desktop` as the desktop app workspace. Keep `iris-core` and `iris-platform` in place.

## Shared Package Boundaries

### `packages/core-client`

Owns platform-neutral Iris Core HTTP types and API calls.

Move or copy the reusable parts of:

- `apps/desktop/src/lib/irisCore.ts`
- platform-neutral parts of `apps/desktop/src/lib/irisRuntime.ts`
- shared Core type declarations currently mixed into desktop modules
- `apps/desktop/src/lib/irisCoreMappings.ts` if it does not depend on DOM/Tauri

Do not move:

- Tauri `invoke` imports
- desktop runtime config storage
- browser `File` upload assumptions
- DOM `EventSource` implementation details unless injected
- UI-specific helper functions

Desired package structure:

```text
packages/core-client/
  package.json
  tsconfig.json
  src/
    index.ts
    types.ts
    transport.ts
    projects.ts
    sessions.ts
    agents.ts
    events.ts
    health.ts
    messages.ts
    mappings.ts
```

Core client transport API:

```ts
export type IrisCoreTransport = {
  baseUrl: string;
  fetch: typeof fetch;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
};

export type IrisCoreEventStream = {
  close(): void;
};

export type IrisCoreEventStreamFactory = (
  url: string,
  handlers: {
    onMessage: (event: IrisCoreEvent) => void;
    onError: (error: unknown) => void;
  },
) => IrisCoreEventStream;
```

All API functions should accept an explicit client or transport:

```ts
export type IrisCoreClient = {
  transport: IrisCoreTransport;
};

export function createIrisCoreClient(transport: IrisCoreTransport): IrisCoreClient;

export function getProjects(client: IrisCoreClient): Promise<IrisProjectListResponse>;
export function createProject(client: IrisCoreClient, payload: CreateProjectPayload): Promise<CreateProjectResponse>;
export function getSessions(client: IrisCoreClient, options: GetSessionsOptions): Promise<IrisSessionListResponse>;
export function getSessionDetail(client: IrisCoreClient, options: GetSessionDetailOptions): Promise<IrisSessionDetailResponse>;
export function sendMessage(client: IrisCoreClient, sessionId: string, payload: SendMessagePayload): Promise<SendMessageResponse>;
export function getLatestEventCursor(client: IrisCoreClient): Promise<LatestEventCursorResponse>;
export function getEvents(client: IrisCoreClient, options: GetEventsOptions): Promise<IrisCoreEventsResponse>;
```

Desktop adapter:

- `apps/desktop/src/lib/irisCore.ts` can become a thin wrapper that creates a client from the existing desktop runtime config and re-exports app-specific helpers.
- Keep Tauri-specific attachment upload logic in desktop for now.

Mobile adapter:

- `apps/mobile/src/lib/coreClient.ts` creates a Core client using the active SSH tunnel's local forwarded Core URL, usually `http://127.0.0.1:<localPort>/v1`.

Acceptance criteria:

- `packages/core-client` imports no `@tauri-apps/*`, no React, no React Native, no DOM-only globals except `fetch` types.
- Desktop still compiles after replacing direct implementation with shared client calls.
- Mobile can call `GET /v1/health`, project list, session list, session detail, and send message through this package.

### `packages/iris-query`

Owns TanStack Query keys, query options, and mutations shared by desktop and mobile.

Move reusable pieces from:

- `apps/desktop/src/lib/query/projects.ts`
- `apps/desktop/src/lib/query/sessions.ts`
- `apps/desktop/src/lib/query/ensureOk.ts`
- `apps/desktop/src/lib/query/runtimeKey.ts`, but rename concepts away from Hermes-specific runtime where possible

Desired package structure:

```text
packages/iris-query/
  package.json
  tsconfig.json
  src/
    index.ts
    ensureOk.ts
    clientKey.ts
    projects.ts
    sessions.ts
```

Query APIs should accept `IrisCoreClient`:

```ts
export function projectsQueryOptions(client: IrisCoreClient, clientKey: string);
export function projectSessionsQueryOptions(client: IrisCoreClient, clientKey: string, projectId: string);
export function sessionsQueryOptions(client: IrisCoreClient, clientKey: string, profile?: string);
export function sessionDetailQueryOptions(client: IrisCoreClient, clientKey: string, sessionId: string);
export function useCreateProjectMutation(client: IrisCoreClient, clientKey: string);
export function useSendMessageMutation(client: IrisCoreClient, clientKey: string);
```

Keep desktop-only query modules in desktop if they touch:

- memory files
- skills
- automations
- slash commands
- local runtime service controls

Acceptance criteria:

- Mobile project/session screens use `packages/iris-query`.
- Desktop project/session features still use the same query keys, or a compatibility wrapper maps old keys to the new shape.

### `packages/chat-core`

Owns platform-neutral chat state helpers.

Move pure helpers from:

- `apps/desktop/src/features/chat/chatHistory.ts`
- `apps/desktop/src/features/chat/chatStreamMerging.ts`
- `apps/desktop/src/features/chat/chatSessionState.ts`
- `apps/desktop/src/features/chat/chatCoreEvents.ts`
- pure types from `apps/desktop/src/features/chat/chatTypes.ts`

Do not move:

- React DOM components
- attachment upload code that assumes browser `File`
- desktop composer UI state
- slash command menu UI
- voice dictation

Desired package structure:

```text
packages/chat-core/
  package.json
  tsconfig.json
  src/
    index.ts
    types.ts
    history.ts
    eventParsing.ts
    streamMerging.ts
    sessionState.ts
    optimistic.ts
```

Mobile should get a simpler hook:

```ts
export function useMobileIrisChat({
  client,
  clientKey,
  profile,
  sessionId,
}: {
  client: IrisCoreClient;
  clientKey: string;
  profile: string;
  sessionId: string | null;
}) {
  // Uses packages/iris-query for session detail and send mutation.
  // Uses packages/chat-core for message normalization and stream merge.
}
```

Event streaming for V1:

1. Prefer Server-Sent Events if a reliable React Native/EventSource implementation works over the SSH tunnel.
2. If SSE is unstable, use polling:
   - call `getLatestEventCursor()`
   - poll `getEvents({ afterCursor })` every 1-2 seconds while a chat is open
   - poll more slowly, around 10-15 seconds, when only list screens are open

Polling is acceptable for V1 if it keeps the SSH/mobile native surface simpler.

Acceptance criteria:

- Desktop keeps current streaming behavior.
- Mobile receives assistant deltas or completed messages reliably.
- Shared tests cover event parsing, optimistic send replacement, and completed/error stream merge.

### `packages/theme`

Owns the Iris visual theme as platform-neutral tokens.

Current desktop theme source is CSS custom properties in:

- `apps/desktop/src/styles/tokens.css`
- `apps/desktop/src/App.css` imports the token file

React Native does not consume CSS variables or Tailwind classes directly. React Native styles are JavaScript objects with camel-cased style names. Therefore, the theme should be extracted into a token source that generates both desktop CSS and native TypeScript.

Desired package structure:

```text
packages/theme/
  package.json
  tsconfig.json
  scripts/
    generate-theme.mjs
  src/
    index.ts
    tokens.ts
  generated/
    desktop-tokens.css
    native-theme.ts
```

Preferred token source:

```ts
export const irisTheme = {
  radius: {
    sm: 6,
    md: 8,
    lg: 10,
    xl: 12,
  },
  colors: {
    background: "#07080b",
    foreground: "#f5f2ea",
    card: "#0d0f14",
    cardForeground: "#f4f0e8",
    mutedForeground: "#8e96a5",
    accentSuccess: "#...",
  },
  spacing: {
    1: 4,
    2: 8,
    3: 12,
    4: 16,
  },
  typography: {
    fontFamily: {
      sans: "system",
      mono: "mono",
    },
  },
} as const;
```

Generator output:

- `generated/desktop-tokens.css` contains the current `:root` token names and the `@theme inline` Tailwind mappings.
- `generated/native-theme.ts` exports `irisNativeTheme`, using React Native-friendly values.

Desktop migration:

- Replace the token block in `apps/desktop/src/styles/tokens.css` with an import or generated file content.
- Keep existing desktop semantic token names stable, such as `--background`, `--foreground`, `--menu`, `--border`, etc.
- Do not redesign colors while extracting them.

Mobile usage:

```ts
import { irisNativeTheme as theme } from "@iris/theme/native";

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
});
```

Acceptance criteria:

- Desktop visual appearance does not change.
- Mobile uses `@iris/theme` for all colors/radii/spacing.
- No raw color literals are introduced in mobile screens except inside the token package.

## Mobile App Scaffolding

Create app:

```bash
npx create-expo-app@latest apps/mobile
```

Use the default Expo Router setup unless the generated template changes. If prompted, choose a TypeScript Expo Router template.

Install required Expo packages:

```bash
npm --workspace apps/mobile install @tanstack/react-query
npm --workspace apps/mobile install @iris/core-client @iris/iris-query @iris/chat-core @iris/theme
npm --workspace apps/mobile exec expo install expo-dev-client expo-camera expo-secure-store expo-crypto expo-application expo-linking
```

SSH package selection is an implementation spike. Evaluate these options before committing UI work:

1. A maintained React Native SSH/libssh2 wrapper that supports local port forwarding on iOS and Android.
2. A small custom native module wrapping libssh2, added via Expo config plugin.
3. If local port forwarding is not feasible, a native module that exposes request forwarding over SSH directly to JS.

Do not use a JavaScript-only SSH implementation unless it is proven to support modern keys, host key verification, and stable mobile performance.

Add development build support:

```bash
npm --workspace apps/mobile exec expo install expo-dev-client
npm --workspace apps/mobile exec expo run:ios
npm --workspace apps/mobile exec expo run:android
```

For team device builds, add EAS later:

```bash
npm --workspace apps/mobile exec eas build --profile development --platform ios
npm --workspace apps/mobile exec eas build --profile development --platform android
```

Recommended mobile package scripts:

```json
{
  "scripts": {
    "start": "expo start --dev-client",
    "ios": "expo run:ios",
    "android": "expo run:android",
    "typecheck": "tsc --noEmit",
    "test": "jest"
  }
}
```

If Metro cannot resolve workspace packages, add `apps/mobile/metro.config.js`:

```js
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
```

## Mobile App File Structure

```text
apps/mobile/
  app/
    _layout.tsx
    index.tsx
    pair.tsx
    projects/
      index.tsx
      new.tsx
      [projectId].tsx
    sessions/
      index.tsx
      [sessionId].tsx
  src/
    connection/
      pairingPayload.ts
      secureConnectionStore.ts
      sshTunnel.ts
      useIrisConnection.ts
    lib/
      coreClient.ts
      queryClient.ts
    screens/
      PairScreen.tsx
      ConnectionStatusScreen.tsx
      ProjectListScreen.tsx
      ProjectCreateScreen.tsx
      ProjectDetailScreen.tsx
      SessionListScreen.tsx
      ChatScreen.tsx
    components/
      AppScreen.tsx
      Button.tsx
      TextField.tsx
      StatusPill.tsx
      ProjectRow.tsx
      SessionRow.tsx
      MessageBubble.tsx
      ChatComposer.tsx
    theme/
      useTheme.ts
```

Navigation model:

- `index.tsx`: redirects to `/projects` if paired, otherwise `/pair`.
- `/pair`: QR scanner and manual troubleshooting state.
- `/projects`: project list and create button.
- `/projects/[projectId]`: project sessions and "new session" affordance.
- `/sessions`: all recent sessions.
- `/sessions/[sessionId]`: chat thread.

## Desktop Pairing UI

Add a small "Pair mobile device" surface to desktop.

Likely location:

- Settings -> Local/Connection
- or a command/menu entry that opens a modal

Files likely touched:

- `apps/desktop/src/features/settings/SettingsView.tsx`
- `apps/desktop/src/features/iris/*` for connection helpers
- new `apps/desktop/src/features/mobile-pairing/MobilePairingDialog.tsx`
- new `apps/desktop/src/features/mobile-pairing/mobilePairing.ts`
- optional CSS in `apps/desktop/src/features/mobile-pairing/mobile-pairing.css`

Use a QR library in desktop, for example `qrcode` or a React QR component. Keep it desktop-only.

QR payload schema:

```ts
export type IrisMobilePairingPayloadV1 = {
  kind: "iris-mobile-pairing";
  version: 1;
  hostId: string;
  hostLabel: string;
  ssh: {
    host: string;
    port: number;
    userHint?: string;
  };
  core: {
    remoteHost: "127.0.0.1";
    remotePort: number;
    apiBasePath: "/v1";
  };
  pairing: {
    nonce: string;
    expiresAt: number;
    desktopPublicKey?: string;
  };
};
```

Example payload:

```json
{
  "kind": "iris-mobile-pairing",
  "version": 1,
  "hostId": "macbook-pro-scott",
  "hostLabel": "Scott's MacBook Pro",
  "ssh": {
    "host": "macbook-pro.local",
    "port": 22,
    "userHint": "scott"
  },
  "core": {
    "remoteHost": "127.0.0.1",
    "remotePort": 8765,
    "apiBasePath": "/v1"
  },
  "pairing": {
    "nonce": "base64url-random",
    "expiresAt": 1780000000
  }
}
```

Security rules:

- QR expires quickly, around 5 minutes.
- QR contains no private key, password, Core token, or long-lived credential.
- Mobile must still verify SSH host key on first connection.
- Mobile stores accepted host key fingerprint and connection profile in secure storage.
- If the host name in the QR is not reachable, mobile should allow editing the SSH host before saving.

Desktop UX:

- Show QR.
- Show host, port, user hint, and expiration.
- Show a "Regenerate QR" action.
- Show a warning that the phone must be able to SSH into this Mac.
- Do not expose direct Core URL/manual Core connection settings for mobile.

## Mobile Pairing Flow

1. User opens mobile app.
2. If no saved connection exists, app shows `/pair`.
3. User scans QR using Expo Camera.
4. App validates:
   - `kind === "iris-mobile-pairing"`
   - `version === 1`
   - `expiresAt > Date.now() / 1000`
   - required SSH/Core fields exist
5. App prompts for SSH auth method:
   - use existing key if imported/available
   - or enter username/password if the selected SSH library supports secure password auth
   - or "Open setup instructions" if key setup is required outside the app
6. App connects to SSH host and establishes local port forwarding:
   - local ephemeral port, e.g. `127.0.0.1:49152`
   - remote `127.0.0.1:8765`
7. App calls `GET http://127.0.0.1:<localPort>/v1/health`.
8. If healthy, app saves the connection profile and routes to `/projects`.

Secure storage:

- Use `expo-secure-store` for connection profile metadata and any credential material that must be stored.
- Store host key fingerprint and compare it on future connects.
- If host key changes, block and show a clear warning.

Connection state model:

```ts
type MobileConnectionState =
  | { status: "unpaired" }
  | { status: "connecting"; profile: SavedConnectionProfile }
  | { status: "connected"; profile: SavedConnectionProfile; localCoreUrl: string }
  | { status: "disconnected"; profile: SavedConnectionProfile; error?: string }
  | { status: "blocked"; profile: SavedConnectionProfile; reason: "host-key-changed" | "auth-required" };
```

## SSH Spike Requirements

Do this before the main mobile UI implementation.

Create a throwaway mobile screen or dev-only module that proves:

1. iOS can connect to SSH host.
2. Android can connect to SSH host.
3. Local port forwarding to remote `127.0.0.1:8765` works.
4. Mobile can fetch `/v1/health` through the forwarded local port.
5. The connection survives at least 5 minutes in foreground.
6. App can disconnect and reconnect cleanly.
7. Host key fingerprint can be read, displayed, saved, and compared.

If local port forwarding is not available:

- Do not continue building full UI on a weak assumption.
- Switch the mobile Core transport abstraction to request-forwarding over SSH.
- Keep the shared `IrisCoreTransport` API unchanged so UI/query code does not care.

## Core API Coverage Needed For V1

Confirm Iris Core exposes these routes or add them before mobile UI:

- `GET /v1/health`
- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/projects/:projectId/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/:sessionId`
- `POST /v1/sessions` or an equivalent session creation endpoint
- `POST /v1/sessions/:sessionId/messages`
- `GET /v1/events/latest-cursor`
- `GET /v1/events?after=<cursor>` or SSE equivalent

If desktop currently relies on profile-specific session APIs, preserve compatibility but add mobile-friendly Core client wrappers.

## Mobile UI Details

### App Shell

Use quiet native screens, not a desktop sidebar. The app should feel like Iris, but mobile-native.

Basic surfaces:

- top header with current host connection state
- list rows for projects/sessions
- simple floating or header action for create project
- full-screen chat thread
- composer fixed above keyboard using React Native keyboard handling

Theme:

- Use `@iris/theme/native` tokens everywhere.
- Use native `Pressable`, `Text`, `TextInput`, `FlatList`, `ScrollView`, and `KeyboardAvoidingView`.
- Use `lucide-react-native` if icon parity with desktop is desired.

### Project List

Data:

- `useProjectsQuery(client, clientKey)`
- `useCreateProjectMutation(client, clientKey)`

UI:

- Empty state: "No projects yet"
- Row: project name, updated timestamp, session count if available
- Create: simple name input and optional default agent selection only if Core requires it

If Core requires `defaultAgentId`, mobile should fetch the default agent or expose a minimal default-agent resolver in `packages/core-client`.

### Sessions

Data:

- all sessions: `useSessionsQuery(client, clientKey, "default")`
- project sessions: `useProjectSessionsQuery(client, clientKey, projectId)`

UI:

- Row: title, summary, updated time, unread state
- Tap opens `/sessions/[sessionId]`

### Chat

Data:

- initial messages from `sessionDetailQueryOptions`
- send via `useSendMessageMutation`
- receive via polling or SSE

Composer:

- multiline `TextInput`
- send button
- disabled while empty or disconnected
- optimistic user message
- assistant typing/streaming state

V1 composer does not need:

- attachments
- model menu
- slash command picker
- voice input

## Desktop Changes Needed

1. Add mobile pairing dialog and QR generation.
2. Add pairing payload type, validation helper, and tests.
3. Add a Settings entry point.
4. Make sure the desktop app can identify:
   - likely SSH host
   - SSH port
   - user hint
   - remote Core port
5. Add docs to `README.md` and `apps/desktop/README.md` explaining mobile pairing.

Potential host detection:

- Prefer explicit user-editable fields in the dialog for v1.
- Defaults:
  - host: local hostname if available, otherwise blank
  - port: `22`
  - user: current OS username if available
  - remote Core port: current Iris Core port, usually `8765`

Avoid over-automating host discovery in v1.

## Package Implementation Sequence

### Phase 1: Workspace and Expo scaffold

1. Update root `package.json` workspaces to include `packages/*`.
2. Create `apps/mobile` with Expo Router.
3. Add `expo-dev-client`, `expo-camera`, `expo-secure-store`, `expo-crypto`, `expo-linking`, `@tanstack/react-query`.
4. Add mobile scripts.
5. Confirm:
   - `npm install`
   - `npm --workspace apps/mobile run typecheck`
   - `npm --workspace apps/mobile run start`

### Phase 2: Theme package

1. Create `packages/theme`.
2. Move token source into `packages/theme/src/tokens.ts`.
3. Generate desktop CSS and native TS outputs.
4. Update desktop `tokens.css` to use generated output.
5. Update mobile to import native theme.
6. Confirm desktop build and mobile typecheck.

### Phase 3: Core client package

1. Create `packages/core-client`.
2. Move platform-neutral Core types and project/session/message APIs.
3. Add fetch transport.
4. Update desktop wrappers to use the shared client without behavior changes.
5. Add unit tests for URL construction, error handling, and core response parsing.

### Phase 4: Query package

1. Create `packages/iris-query`.
2. Move project/session query keys/options/mutations.
3. Update desktop project/session consumers.
4. Use the same query package in mobile.

### Phase 5: Chat core package

1. Create `packages/chat-core`.
2. Move pure helpers only.
3. Add tests around stream merge and optimistic replacement.
4. Build a mobile-specific `useMobileIrisChat` that uses shared helpers and mobile transport.

### Phase 6: Desktop QR pairing

1. Add pairing payload schema and tests.
2. Add QR dialog.
3. Add Settings entry point.
4. Add docs.
5. Verify with Vite/browser checks against `http://localhost:1420/`.

### Phase 7: Mobile SSH pairing spike

1. Implement QR scan.
2. Implement SSH connection profile parsing.
3. Implement SSH tunnel or request-forwarding transport.
4. Prove `/v1/health` through SSH on iOS and Android development builds.
5. Store profile securely.

### Phase 8: Mobile V1 screens

1. Pair screen.
2. Connection status state.
3. Projects list/create.
4. Project sessions.
5. Session list.
6. Chat screen and composer.
7. Basic error/reconnect states.

## Testing And Verification

### Root/workspace checks

```bash
npm install
npm run build
npm --workspace apps/desktop run test -- src/app/__tests__/tauriConfig.test.ts
npm --workspace apps/desktop run test:bridge
npm --workspace apps/desktop run build
npm --workspace apps/mobile run typecheck
```

### Shared package checks

Each package should have:

```bash
npm --workspace packages/core-client run test
npm --workspace packages/iris-query run test
npm --workspace packages/chat-core run test
npm --workspace packages/theme run test
```

At minimum, add package typechecks if no tests are useful yet:

```bash
npm --workspace packages/core-client run typecheck
npm --workspace packages/iris-query run typecheck
npm --workspace packages/chat-core run typecheck
npm --workspace packages/theme run typecheck
```

### Desktop pairing verification

Use Browser/Vite checks:

1. Open `http://localhost:1420/`.
2. Navigate to Settings.
3. Open "Pair mobile device".
4. Verify QR renders.
5. Verify payload text/debug copy is valid JSON if exposed in dev.
6. Verify regenerate changes nonce and expiration.
7. Verify no raw secrets are present in QR payload.

### Mobile verification

Run in development build:

```bash
npm --workspace apps/mobile run ios
npm --workspace apps/mobile run android
```

Manual test flow:

1. Fresh install opens Pair screen.
2. Scan desktop QR.
3. Mobile shows parsed host/user/port.
4. Connect through SSH.
5. App verifies `/v1/health`.
6. App opens project list.
7. Create project.
8. Open project.
9. Create/open session.
10. Send chat message.
11. Assistant response appears.
12. Kill and reopen mobile app; saved connection reconnects or shows clear reconnect state.

## Risks And Mitigations

### SSH on mobile is the largest risk

Mitigation:

- Spike SSH before building all screens.
- Keep Core transport abstract so local tunnel and request-forwarding can swap without UI rewrites.
- Do not encode a direct Core URL fallback in product UI unless requirements change.

### Token extraction may accidentally redesign desktop

Mitigation:

- Generate desktop CSS with the same variable names and values.
- Run desktop Vite visual smoke checks.
- Do not rename tokens during extraction.

### Desktop chat hook is too large to share directly

Mitigation:

- Move pure helpers first.
- Build mobile chat hook small and focused.
- Do not force desktop hook structure onto mobile.

### React Native cannot share CSS/Tailwind classes

Mitigation:

- Share design tokens, not stylesheets.
- Build mobile primitive components that consume `@iris/theme/native`.

### Event streaming may be unreliable over mobile SSH

Mitigation:

- Support polling as V1 fallback.
- Keep polling interval conservative.
- Upgrade to SSE once proven reliable.

## Handoff Checklist

Status as of May 24, 2026: local source work is implemented through the managed Expo app plus a local native SSH request-forwarding bridge. Remaining proof requires real iOS and Android development builds connected to a reachable SSH host running Iris Core.

- [ ] `apps/mobile` exists and runs as an Expo development build. Source exists and iOS generic device build succeeded; real device/simulator launch is still unverified.
- [x] Root workspaces include `packages/*`.
- [x] `packages/theme` exports desktop CSS and native TS theme.
- [x] Desktop still uses the same visual tokens.
- [x] `packages/core-client` contains platform-neutral project/session/message APIs.
- [x] `packages/iris-query` contains shared project/session query logic.
- [x] `packages/chat-core` contains platform-neutral chat/event helpers.
- [x] Desktop pairing dialog generates expiring QR payloads.
- [ ] Mobile scans QR payloads with Expo Camera. Implemented, but not camera-tested in a native development build.
- [ ] Mobile establishes SSH-only Core connectivity. Native bridge and JS transport are implemented, but real SSH connectivity is unverified.
- [ ] Mobile can list/create projects. Screens and shared queries are implemented; end-to-end mobile/Core proof is still pending.
- [ ] Mobile can list/open sessions. Screens and shared queries are implemented; end-to-end mobile/Core proof is still pending.
- [ ] Mobile can send and receive chat messages. Chat screen, send, and polling are implemented; end-to-end mobile/Core proof is still pending.
- [x] Docs explain mobile pairing setup and SSH requirements.

## Final Notes

The important architectural rule is: **Iris Core is the shared contract, not the desktop app.**

Share Core API code, query semantics, chat reconciliation, and theme tokens. Rebuild the actual UI natively for mobile.
