# Iris Desktop

Iris Desktop is the native Tauri 2, React 18, TypeScript, and Tailwind client for Iris.

This app lives in the `desktop/` workspace of the Iris monorepo. For normal setup and startup, run commands from the repository root.

## Phase 1 Foundation

- macOS-style app layout with sidebar navigation, chat workspace, and toggleable live preview pane.
- Sandboxed preview modes for HTML, React, Markdown, and Mermaid diagrams.
- Rust Tauri command bridge that calls Hermes runtime APIs and Iris Core.
- Iris Core discovery for Hermes profiles, `MEMORY.md`, `USER.md`, and skills.
- API-backed chat through Hermes endpoints: new chats use `/v1/responses`, and existing Hermes sessions continue through `/v1/chat/completions` with the Hermes session header.

## Development

From the monorepo root:

```bash
npm run bootstrap
npm run dev
```

For web-only iteration from the root:

```bash
npm run dev:web
```

From this `desktop/` directory:

```bash
npm install
npm run dev
npm run tauri dev
```

The web dev surface runs on `http://127.0.0.1:1420/`. The full desktop shell is launched with root `npm run dev` or local `npm run tauri dev`.

## Hermes Integration

The bridge expects two HTTP routes:

- Hermes chat API: live chat streams through Hermes' `/v1/responses` endpoint for new chats and `/v1/chat/completions` for existing sessions. Start Hermes with `API_SERVER_ENABLED=true` and point the app at `http://127.0.0.1:8642/v1`, or configure a remote API URL in Settings.
- Iris Core API: agents, conversations, automations, device auth, profile compatibility, memory, skill, status, and conversation reads come from the monorepo service in `../sidecar`, defaulting to `http://127.0.0.1:8765/v1`.

Settings treats the selected profile API URL as the primary chat route, then falls back to the default local or remote API URL based on the connection mode. Profiles can store their own API URLs, matching Hermes' multi-profile pattern where each profile gateway runs on its own port. Conversation listing and detail are read through Iris Core. The desktop app does not read local `state.db` history directly and does not keep a browser-side conversation cache; Iris Core and Hermes endpoints are the source of truth.

Useful environment variables:

- `HERMES_HOME`: used only by remaining local profile-management bridge actions.
- `HERMES_DESKTOP_PYTHON`: override the Python interpreter used by the Tauri bridge.
- `HERMES_REMOTE_TOKEN`: provide an API bearer token for automation.
- `IRIS_CORE_TOKEN`: provide a bearer token for Iris Core.

## Production Checks

```bash
npm run check
npm run package:check
npm run build:mac:app
```

From this directory, the equivalent app-only checks are:

```bash
npm run test
npm run test:bridge
npm run build
```

API tokens are stored through the OS credential store, not browser local storage. See `docs/production-readiness.md` for the permissions review, packaging notes, and release environment requirements.
