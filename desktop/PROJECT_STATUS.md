# Hermes Agent Desktop Project Status

Last updated: May 3, 2026

## Original Goal

Build a polished, production-ready Tauri desktop app for Hermes Agent by Nous Research. The app should feel like a premium modern macOS AI-agent desktop application, inspired by Codex, and become the primary interface for Hermes users.

## Tech Stack Status

- Tauri 2.x: implemented
- React 18: implemented
- TypeScript: implemented
- Tailwind CSS: implemented
- shadcn-style component primitives: partially implemented with custom high-quality primitives
- Rust Tauri commands: implemented for the bridge foundation
- Python bridge to Hermes: implemented for sidecar-backed inspection and API-backed chat
- Embedded preview webview: implemented as a sandboxed iframe inside the app
- Hot-reload development: implemented through Vite/Tauri dev workflow

## Completed

### Project Foundation

- Created the full Tauri project structure.
- Renamed the app to `Hermes Agent`.
- Configured macOS-style Tauri window chrome with hidden title and traffic-light positioning.
- Added native-looking dark desktop styling with refined spacing, typography, panel hierarchy, and restrained controls.
- Added project documentation in `README.md`.

### Main Window And Layout

- Built the main desktop shell with:
  - Sidebar navigation
  - Top bar
  - Main content workspace
  - Toggleable right preview pane
- Added navigation sections:
  - Chat
  - Agents
- Added a profile selector foundation.
- Added connection and summary indicators for memory and skills.

### Chat Foundation

- Added a chat workspace with user and assistant message bubbles.
- Added a composer with send behavior.
- Added simulated streaming response rendering.
- Wired chat send to the Hermes bridge.
- Added graceful offline handling when the Hermes API server is unreachable.

### Hermes Integration Layer

- Added Rust Tauri command bridge in `src-tauri/src/lib.rs`.
- Added Python Hermes bridge in `src-tauri/python/hermes_bridge.py`.
- Implemented management-sidecar reads for:
  - Hermes home and active profile metadata
  - Named profiles
  - `config.yaml` summaries
  - `memories/MEMORY.md`
  - `memories/USER.md`
  - `skills/**/SKILL.md`
  - `gateway.pid` status
- Kept `HERMES_HOME` support for remaining local profile-management actions.
- Added support for `HERMES_DESKTOP_PYTHON`.
- Routed chat send through the Hermes API server instead of spawning `hermes chat`.
- Added persistent desktop runtime settings for local API, remote API, management API, and per-profile API URLs.
- Added streaming chat bridge with Tauri events, request IDs, and API-backed cancellation behavior.
- Added local and remote Hermes API routing foundations.
- Added profile create, clone, rename, switch, and delete bridge actions and UI workflows.
- Added response event parsing for tool calls, artifacts, memory writes, and skill events.

### Memory UI

- Added Memory view.
- Displays `MEMORY.md` and `USER.md` content when available.
- Shows empty-state messaging when no memory files exist.
- Added memory size summary.
- Added foundation row for a future memory growth dashboard.

### Skills UI

- Added Skills view.
- Loads Hermes skills for the selected profile from the management sidecar when available.
- Shows fallback skill rows when the selected profile has no installed skills yet.
- Added foundation for future skill creation/editing.
- Added full skill browser workspace with detail pages, search, filtering, categories, and source badges.
- Added syntax-aware `SKILL.md` editor with frontmatter detection, metadata fields, line numbers, save/install flow, and Skills Hub starter templates.
- Added bridge support for skill detail loading, create/edit saves, metadata extraction, installed/bundled/community distinction, and local change history snapshots.

### Live Preview System

- Added toggleable right-side Live Preview pane.
- Added preview mode tabs:
  - HTML
  - React
  - Markdown
  - Diagram
- Added editable source panel.
- HTML preview renders in a sandboxed iframe.
- React preview renders executable JSX in a sandboxed iframe with a locally bundled runtime.
- Markdown preview renders locally.
- Diagram preview renders locally with bundled Mermaid.
- Removed CDN dependency for React and diagram preview.
- Replaced the static React approximation with a real sandboxed React runtime using locally bundled React, ReactDOM, and Babel.
- Replaced the simple diagram SVG renderer with locally bundled Mermaid rendering.
- Added a multi-artifact preview workspace with artifact naming, selection, duplication, deletion, local persistence, and per-artifact source editing.
- Added preview export for HTML, JSX, Markdown, and Mermaid artifacts.
- Implemented `Save as skill` by converting the active artifact into a generated `SKILL.md` draft artifact.
- Added preview runtime status and error overlays.
- Added per-artifact sandbox permission controls for scripts, forms, modals, and downloads.

### Settings UI

- Added Settings view.
- Displays:
  - Hermes root
  - Management API status
  - Selected profile API status
  - Local API status
  - Remote API status
  - Model/provider
  - Session count
  - Estimated cost
- Added editable runtime connection settings for local API, remote API, management API, and selected-profile API URLs.
- Added profile workflow controls for create, clone, rename, switch, and delete.

### Product Polish

- Added first-run onboarding for local API, remote API, profile, and model-routing setup.
- Added keyboard shortcuts and a command menu for view switching, preview toggling, refresh, and setup access.
- Added native macOS tray/menu bar integration with show, refresh, and quit actions.
- Added model/provider routing overrides that flow into local and remote API message requests.
- Added selected-profile API routing so profile selection can target separate Hermes gateways.
- Added a usage and cost dashboard across discovered Hermes profiles.
- Added in-app notification infrastructure and connection retry/error/loading surfaces.
- Added a refined Hermes visual identity mark and first-run empty/setup states.
- Added loading, error, and retry state polish around connection refresh and runtime status.

### Build And Manual Testing

- Verified `npm run build`.
- Verified `cargo check`.
- Built macOS app bundle with:
  - `npm run tauri build -- --debug --bundles app`
- Launched the native app bundle from:
  - `src-tauri/target/debug/bundle/macos/Hermes Agent.app`
- Verified:
  - App launches
  - Sidebar navigation works
  - Preview pane toggles
  - HTML preview renders
  - React preview renders
  - Markdown preview renders
  - Diagram preview renders
  - Chat composer sends
  - Missing Hermes API server produces a clear error instead of crashing
  - Settings runtime controls render in the native app
  - Profile bridge actions work against an isolated temporary Hermes home

## Known Constraints

- Hermes API is not currently running on `http://127.0.0.1:8642/v1` in this environment, so live Hermes chat cannot be fully exercised yet.
- The DMG packaging step previously hung when building all bundles. Building the app bundle only works.
- Buttons such as `New skill` and `Open folder` are UI foundations and are not fully wired yet.
- The current UI is optimized for desktop widths. Additional responsive polish is still needed for smaller windows.
- Chat send uses Hermes HTTP APIs: new chats use `/v1/responses`, and follow-ups in existing Hermes sessions use `/v1/chat/completions` with `X-Hermes-Session-Id`.
- Conversation listing and detail are management-sidecar scoped. The desktop app no longer reads local `state.db` history directly and no longer keeps a browser-side conversation index.
- Profile, memory, skill, and status reads are management-sidecar scoped. The desktop app no longer discovers those values by reading Hermes files directly.
- Runtime event parsing is heuristic until Hermes exposes structured event envelopes.
- Streaming quality depends on Hermes API SSE events.
- The bundled preview runtime makes the frontend bundle large; future production work should code-split the preview runtime.
- macOS screen capture requires the app to have Screen Recording permission. In this environment the bridge surfaced `could not create image from display` and logged the denial instead of crashing.

## Still To Do

### Phase 2: Real Hermes Runtime Integration

- [x] Support local and remote Hermes Agent instances.
- [x] Add streaming responses from the Hermes API.
- [x] Add local API connection support.
- [x] Add per-profile API URL routing for Hermes profile gateways.
- [x] Add configurable management-sidecar URL for profile, memory, skill, and status reads.
- [x] Add profile create, clone, rename, switch, and delete workflows.
- [x] Remove per-message Hermes CLI spawning from send and message-detail fetch paths.
- [x] Parse Hermes responses for tool calls, artifacts, memory writes, and skill events.

### Phase 3: Full Live Preview System

- [x] Replace the static React preview with a real sandboxed React runtime.
- [x] Add a local bundled preview runtime instead of CDN loading.
- [x] Add full Mermaid rendering without network dependency.
- [x] Add artifact file management.
- [x] Add preview save/export.
- [x] Add "Save as skill" implementation.
- [x] Add preview error overlays.
- [x] Add isolated preview permissions.
- [x] Add support for multiple artifacts per chat.

### Phase 4: Skill Browser And Editor

- [x] Build full skill detail pages.
- [x] Add create/edit skill flow.
- [x] Add syntax-aware `SKILL.md` editing.
- [x] Add skill metadata extraction.
- [x] Add skill search and filtering.
- [x] Add skill categories.
- [x] Add installed/bundled/community distinction.
- [x] Add optional Skills Hub/store integration.
- [x] Add versioning and change history.

### Phase 5: Memory Management

- [x] Add editable memory views with safe save/undo.
- [x] Add memory growth dashboard.
- [x] Add memory timeline.
- [x] Add memory diffing.
- [x] Add memory search.
- [x] Add memory provider status.
- [x] Add controls for profile memory versus external providers.
- [x] Add warnings for destructive memory reset flows.

### Phase 7: Product Polish

- [x] Add onboarding flow.
- [x] Add keyboard shortcuts.
- [x] Add command menu.
- [x] Add system tray/menu bar integration.
- [x] Add model routing settings.
- [x] Add usage and cost dashboard.
- [x] Add notification system.
- [x] Add app icon and custom visual identity.
- [x] Add empty states for first-run Hermes setup.
- [x] Add loading, error, and retry states throughout.

### Phase 8: Production Readiness

- [x] Add automated tests for the bridge and UI behavior.
- [x] Add Tauri permissions review.
- [x] Add secure storage for remote credentials and tokens.
- [x] Add signed and notarized macOS build configuration and release checks.
- [x] Add Windows and Linux packaging checks.
- [x] Fix or bypass the DMG bundling hang.
- [x] Add CI build workflow.
- [x] Add crash/error logging.
- [ ] Add update mechanism.

## Key Files

- `src/App.tsx`: main desktop UI and preview rendering
- `src/App.css`: app styling and desktop visual system
- `src/lib/hermes.ts`: frontend bridge client
- `src/types/hermes.ts`: Hermes integration types
- `src-tauri/src/lib.rs`: Rust Tauri command bridge
- `src-tauri/python/hermes_bridge.py`: Python Hermes inspection and command bridge
- `src-tauri/tauri.conf.json`: Tauri app/window configuration
- `README.md`: development instructions
