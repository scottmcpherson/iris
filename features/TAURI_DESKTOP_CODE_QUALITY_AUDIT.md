# Tauri Desktop Code Quality Audit

## Goal

Reduce the maintenance burden in the Tauri desktop app without changing product behavior, runtime contracts, persistence semantics, or Hermes/Iris Core business logic.

This audit covers the desktop app surface under `desktop/src` and `desktop/src-tauri`. The Python bridge is included because it is invoked directly by the Tauri shell. The sidecar service is out of scope except where desktop code depends on its API shape.

## Non-Goals

- Do not change runtime behavior, message ordering, streaming reconciliation, profile selection, attachment upload behavior, or Core/Hermes routing.
- Do not change API endpoints, request payloads, localStorage keys, Tauri command names, Python bridge action names, or persisted file locations.
- Do not redesign the visible UI as part of the cleanup.
- Do not edit Hermes under `~/.hermes`.
- Do not fold the sidecar into the desktop app.

## Current Hotspots

| File | Lines | Why it is hard to maintain |
| --- | ---: | --- |
| `desktop/src/App.css` | 5,101 | One global stylesheet owns shell, chat, jobs, agents, settings, preview, profile dialogs, and responsive states. Selector ownership is unclear and unrelated changes can collide. |
| `desktop/src/features/chat/useHermesChat.ts` | 2,196 | One hook owns send flow, conversation identity migration, optimistic rows, Core event streaming, polling fallback, attachment uploads, message conversion, stream coalescing, model-switch handling, and many pure helpers. |
| `desktop/src-tauri/python/hermes_bridge.py` | 1,408 | One bridge script contains dispatch, HTTP transport, multipart upload, credential storage, profile filesystem fallbacks, memory editing, skill editing, status normalization, and Core proxying. |
| `desktop/src/features/chat/ChatView.tsx` | 1,307 | The chat view owns message rendering, composer state, file drag/drop, attachment tray, profile menu, model picker, slash-command menu, link opening, markdown rendering, and tool-event rendering. |
| `desktop/src/layout/AppShell.tsx` | 887 | The shell owns app layout plus profile tree, conversation search, global shortcuts, profile action menus, profile action dialogs, sidebar persistence, and conversation preload behavior. |
| `desktop/src/features/settings/SettingsView.tsx` | 668 | Settings, remote credential management, profile actions, URL normalization, service cards, token fields, and low-level form widgets are in one file. |
| `desktop/src/App.tsx` | 518 | Root orchestration mixes feature routing, global shortcuts, notification lifecycle, onboarding state, preview artifact editing/export, profile action notices, and chat wiring. |
| `desktop/src/lib/agentuiCore.ts` | 467 | Typed API client, direct fetch transport, bridge fallback, timeout policy, attachment URL rewriting, multipart uploads, SSE URL building, and automations are all in one module. |
| `desktop/src/lib/hermes.ts` | 446 | Hermes-named facade now maps Iris Core entities into Hermes-shaped types, which hides ownership boundaries and makes future refactors confusing. |

The total audited desktop app footprint is about 19.5k lines across TypeScript, CSS, Python, and Rust. The biggest issue is not line count alone; it is that the largest files combine UI rendering, transport, persistence, compatibility mapping, and state reconciliation.

## Findings

### 1. Chat State Is Too Concentrated

`desktop/src/features/chat/useHermesChat.ts` is the highest-risk file. It currently combines at least these responsibilities:

- Text input state and selected conversation state.
- Per-profile conversation list loading.
- Conversation detail loading.
- Optimistic conversation creation and replacement.
- Core conversation creation and legacy selection linking.
- Message send state, idempotency keys, and active request tracking.
- Attachment upload preparation.
- SSE setup and polling fallback.
- Core event parsing and delivery merging.
- Stream snapshot coalescing and completed-delivery repair.
- History-to-UI message conversion.
- Model-switch filtering and hidden metadata filtering.

This makes small behavior changes hard to reason about because a change to one branch can affect retries, optimistic rows, message migration, and streaming finalization at once.

Recommended extraction, preserving the existing `useAgentUIChat` return shape:

- `desktop/src/features/chat/chatTypes.ts`
  Shared local types such as `SendableAttachment`, pending selection records, and internal state maps.
- `desktop/src/features/chat/chatAttachments.ts`
  `uploadAttachmentsForSend`, `mergeUploadedAttachment`, attachment prompt summaries, attachment size formatting.
- `desktop/src/features/chat/chatHistory.ts`
  `toAppMessages`, `toAppMessage`, hidden metadata filtering, history tool-call conversion.
- `desktop/src/features/chat/chatStreamMerging.ts`
  `mergeStreamDelivery`, `mergeCompletedDelivery`, `coalescePostStreamAttachments`, overlap/duplicate detection.
- `desktop/src/features/chat/conversationIdentity.ts`
  Optimistic ID checks, Core ID checks, chat ID mapping, replacement detection, active marker migration.
- `desktop/src/features/chat/useCoreEventDeliveries.ts`
  EventSource setup, polling fallback, cursor tracking, Core event parsing, delivery dedupe.
- `desktop/src/features/chat/useConversationHistory.ts`
  Conversation list refresh, detail refresh, transient retry scheduling, history errors.
- Keep `desktop/src/features/chat/useHermesChat.ts` as the facade that wires those pieces together.

Refactor rule: first move pure helpers with their existing tests. Only then extract hooks around the existing state variables. The facade should keep its public fields and function names until the final pass.

### 2. Chat Rendering Contains Several Components In One File

`desktop/src/features/chat/ChatView.tsx` is mixing independent UI controls that now deserve their own files:

- Composer shell and send handling.
- Attachment tray and file drag/drop.
- Profile selector menu.
- Model picker menu.
- Slash-command menu.
- Message list.
- Message content and markdown rendering.
- Tool-event rendering and legacy tool-event parsing.

Recommended extraction:

- `desktop/src/features/chat/components/Composer.tsx`
- `desktop/src/features/chat/components/AttachmentTray.tsx`
- `desktop/src/features/chat/components/ProfileMenu.tsx`
- `desktop/src/features/chat/components/ModelMenu.tsx`
- `desktop/src/features/chat/components/SlashCommandMenu.tsx`
- `desktop/src/features/chat/components/MessageList.tsx`
- `desktop/src/features/chat/components/MessageContent.tsx`
- `desktop/src/features/chat/components/ToolEvents.tsx`
- `desktop/src/features/chat/filePreview.ts`

The first extraction should be `ToolEvents.tsx` because similar tool parsing already exists in `useHermesChat.ts`; pulling it out creates a shared, testable boundary without touching the send path.

### 3. Global CSS Has No Ownership Boundary

`desktop/src/App.css` is the largest file by far. It includes about 5.1k lines and hundreds of selectors across unrelated feature areas. This makes UI fixes fragile because the cascade is the dependency graph.

Recommended split:

- `desktop/src/styles/base.css`
- `desktop/src/styles/layout.css`
- `desktop/src/styles/buttons.css`
- `desktop/src/styles/menus.css`
- `desktop/src/features/chat/chat.css`
- `desktop/src/features/jobs/jobs.css`
- `desktop/src/features/agents/agents.css`
- `desktop/src/features/memory/memory.css`
- `desktop/src/features/skills/skills.css`
- `desktop/src/features/settings/settings.css`
- `desktop/src/features/preview/preview.css`
- `desktop/src/features/polish/polish.css`

Keep class names unchanged during the split. Import the new CSS files from `App.tsx` or a single `desktop/src/styles/index.css`. Do not convert to CSS modules in the same pass; that would make visual regressions harder to isolate.

### 4. The Python Bridge Needs Module Boundaries

`desktop/src-tauri/python/hermes_bridge.py` is currently both a command router and a service layer. It should stay behaviorally identical but be split into modules:

- `desktop/src-tauri/python/hermes_bridge/main.py`
  CLI parsing, action dispatch, JSON emit/error handling.
- `desktop/src-tauri/python/hermes_bridge/config.py`
  Runtime payload normalization, URL helpers, profile URL routing.
- `desktop/src-tauri/python/hermes_bridge/http.py`
  JSON requests, multipart requests, error parsing, auth headers.
- `desktop/src-tauri/python/hermes_bridge/credentials.py`
  Keychain, env token, and test-file credential behavior.
- `desktop/src-tauri/python/hermes_bridge/profiles.py`
  Profile discovery, safe names, local create/clone/delete fallback.
- `desktop/src-tauri/python/hermes_bridge/memory.py`
  Memory read/save/reset and history.
- `desktop/src-tauri/python/hermes_bridge/skills.py`
  Skill listing/detail/save/history.
- `desktop/src-tauri/python/hermes_bridge/core.py`
  Core proxy request and local-path upload.

Keep `desktop/src-tauri/python/hermes_bridge.py` as a compatibility entrypoint that imports and calls `main()`. This avoids changing the Rust command in `desktop/src-tauri/src/lib.rs`.

### 5. Hermes/Iris Core Naming Is Blurry

`desktop/src/lib/hermes.ts` now exposes Hermes-named functions while internally using Iris Core APIs from `desktop/src/lib/agentuiCore.ts`. This compatibility layer is useful, but the naming makes ownership hard to understand.

Recommended cleanup:

- Keep all existing exported Hermes-named functions for compatibility.
- Move Core-to-Hermes mapping helpers into `desktop/src/lib/coreHermesCompat.ts`.
- Add a short module comment explaining that this file is a compatibility facade for existing UI code.
- Prefer new feature code to call the Core client or a clearly named facade, not new Hermes-named wrappers.

Do not rename the public functions in this pass. That would create churn across the app with no behavior improvement.

### 6. Utility Code Is Duplicated

Duplicated or near-duplicated helpers exist across chat, settings, jobs, and model catalog code:

- `formatAttachmentSize` exists in both `ChatView.tsx` and `useHermesChat.ts`.
- `stringValue` exists in chat, settings, jobs, and model catalog modules.
- `titleCase`, path segment helpers, and skill display helpers exist in both chat render and chat history logic.
- Tool-event classification appears in both history conversion and legacy render fallback paths.

Recommended extraction:

- `desktop/src/shared/strings.ts`
  `stringValue`, `titleCase`, compact text helpers.
- `desktop/src/shared/files.ts`
  Attachment size formatting, filename/path helpers, MIME helpers.
- `desktop/src/features/chat/toolEvents.ts`
  Tool event classification, labels, status, detail formatting.

Add unit tests for the extracted helpers before replacing call sites.

### 7. Local Storage Is Scattered

Local storage is used in `App.tsx`, `AppShell.tsx`, `runtimeConfig.ts`, `MemoryView.tsx`, `previewArtifacts.ts`, `useHermesJobs.ts`, and `useHermesModelCatalog.ts`. The behavior is mostly legitimate UI preference state, but the keys are scattered and some still use the old `hermes.desktop.*` namespace.

Recommended cleanup:

- Create `desktop/src/app/storage.ts` with safe JSON/string load/save helpers.
- Centralize storage key constants in that file.
- Preserve existing keys initially to avoid data migration risk.
- Later, add a separate explicit migration from legacy `hermes.desktop.*` keys to `iris.desktop.*` only if desired.

Do not remove profile/session collapse persistence during this cleanup; previous sidebar behavior depends on it.

### 8. Transport Policy Is Implicit

`desktop/src/lib/agentuiCore.ts` directly encodes timeout behavior, fetch-vs-bridge fallback, bearer-auth fallback, idempotency keys, attachment URL rewriting, and Core URL construction.

Recommended extraction:

- `desktop/src/lib/coreTransport.ts`
  `coreRequest`, bridge fallback, timeout behavior, base URL construction.
- `desktop/src/lib/coreAttachments.ts`
  attachment upload and URL normalization.
- `desktop/src/lib/coreAutomations.ts`
  automation endpoints.
- `desktop/src/lib/coreChat.ts`
  agents, conversations, messages, events, SSE URL.

Keep the exported functions from `agentuiCore.ts` as re-exports for the first pass.

### 9. App Root Owns Too Much Feature Behavior

`desktop/src/App.tsx` should mostly wire application state together. It currently includes preview artifact editing/export, onboarding persistence, notification lifecycle, global shortcuts, and view-specific render branching.

Recommended extraction:

- `desktop/src/app/useGlobalShortcuts.ts`
- `desktop/src/app/useNotifications.ts`
- `desktop/src/features/preview/usePreviewArtifacts.ts`
- `desktop/src/features/onboarding/useOnboarding.ts`
- `desktop/src/app/renderPrimaryPane.tsx` only if it stays simple; otherwise keep rendering inline.

Keep `App.tsx` as the composition root.

### 10. Shell Contains Sidebar, Search, And Dialog Logic

`desktop/src/layout/AppShell.tsx` is still understandable, but it has enough independent UI flows that future sidebar changes will be risky.

Recommended extraction:

- `desktop/src/layout/ProfileTree.tsx`
- `desktop/src/layout/ConversationSearchDialog.tsx`
- `desktop/src/layout/ProfileActionDialog.tsx`
- `desktop/src/layout/useCollapsedSessionProfiles.ts`
- `desktop/src/layout/useShellShortcuts.ts`

Preserve these UX rules exactly:

- Profiles remain visually passive; conversations own the active highlight.
- Clicking a profile expands/collapses that profile.
- Conversation rows stay one line with the age/status on the far right.
- Left edges remain aligned.
- Refresh must reflect profile rename/delete changes and should not preserve stale profile names.

### 11. Tests Are Good Around Pure Chat Helpers, But Thin Around Components

The repo already has strong helper tests for chat merging and model/markdown/slash logic. The main gap is component-level coverage around extracted UI pieces and bridge module boundaries.

Before refactoring, preserve or add characterization tests for:

- `useAgentUIChat` public return shape and send result semantics.
- EventSource-to-polling fallback behavior.
- Optimistic conversation replacement by Core conversation ID and chat ID.
- Hidden model-switch message filtering.
- Attachment upload and preview URL behavior.
- Profile tree expand/collapse persistence.
- Conversation search selection.
- Python bridge command dispatch and module import compatibility.

Do not rewrite tests to match the refactor. Move existing tests with the code where possible.

## Recommended Refactor Sequence

### Phase 1: Low-Risk Pure Extraction

1. Extract shared string/file helpers.
2. Extract chat stream merging helpers into `chatStreamMerging.ts`.
3. Extract chat history conversion into `chatHistory.ts`.
4. Extract tool-event parsing/render helpers.
5. Update tests to import from the new modules.

Verification:

- `npm --workspace desktop run test`
- `npm --workspace desktop run build`

### Phase 2: Chat UI Component Split

1. Extract `MessageContent` and `ToolEvents`.
2. Extract `AttachmentTray`.
3. Extract `SlashCommandMenu`.
4. Extract `ModelMenu`.
5. Extract `ProfileMenu`.
6. Keep `ChatView.tsx` as orchestration for the composer and message list.

Verification:

- `npm --workspace desktop run test`
- `npm --workspace desktop run build`
- Quick Vite/browser smoke test for chat rendering, model picker, slash menu, and file attachment UI.

### Phase 3: Chat Hook Boundary Split

1. Extract attachment upload.
2. Extract conversation identity helpers.
3. Extract conversation list/detail refresh helpers.
4. Extract Core event delivery hook.
5. Keep `useAgentUIChat` as the stable facade.

Verification:

- `npm --workspace desktop run test`
- Add at least one integration-style hook test if practical.
- Manual smoke: new chat, follow-up chat, conversation load, model switch on first message, cancellation, attachment send.

### Phase 4: CSS Ownership Split

1. Move global reset/tokens/layout first.
2. Move feature CSS one feature at a time without renaming classes.
3. Keep imports centralized.
4. After each feature split, verify visual parity.

Verification:

- `npm --workspace desktop run build`
- Browser or Vite screenshots for chat, agents, jobs, settings, preview, and mobile-ish narrow viewport.
- For any visible change that lands with this phase, run the required fresh Tauri app verification.

### Phase 5: Python Bridge Module Split

1. Add package modules under `desktop/src-tauri/python/hermes_bridge/`.
2. Convert old `hermes_bridge.py` into a compatibility entrypoint.
3. Move dispatch actions without changing action names.
4. Move tests gradually so failures identify one responsibility at a time.

Verification:

- `npm --workspace desktop run test:bridge`
- `npm --workspace desktop run build:mac:app` before final UI/runtime verification if any visible behavior or bridge behavior changed.

### Phase 6: Core/Hermes Facade Cleanup

1. Extract Core transport modules.
2. Extract Core-to-Hermes compatibility mapping.
3. Add module comments around compatibility surfaces.
4. Keep all public exports stable until downstream imports are intentionally migrated.

Verification:

- `npm --workspace desktop run test`
- `npm --workspace desktop run build`
- Manual chat/conversation smoke through Iris Core.

## Acceptance Criteria

- Existing business logic is unchanged.
- Existing public exports remain available unless a later implementation doc explicitly approves a rename.
- Existing localStorage keys continue to load.
- Tauri command `hermes_bridge` and Python action names continue to work.
- No new data caching layer is introduced.
- Hermes remains an external runtime/source dependency; repo-owned code handles compatibility.
- `npm --workspace desktop run check` passes.
- For visible UI changes or feature behavior changes, `npm run build:mac:app` is run from the repo root and the newly built bundle is tested with Computer Use against `com.nousresearch.hermes-agent.desktop`.
