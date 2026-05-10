# Iris Desktop

Iris Desktop is the native Tauri 2, React 18, TypeScript, and Tailwind client for Iris.

This app lives in the `desktop/` workspace of the Iris monorepo. For normal setup and startup, run commands from the repository root.

## Phase 1 Foundation

- macOS-style app layout with sidebar navigation and session workspace.
- Rust Tauri command bridge used only for Iris Core request fallback, Core attachment uploads from local paths, and Core credential storage.
- Iris Core discovery for agents, memory files, skills, sessions, model catalogs, slash commands, automations, and runtime health.
- Sessions, profile actions, memory writes, skill writes, model catalog, slash commands, and automations all route through Iris Core. Hermes remains a runtime adapter behind Core.

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

## Iris Core Integration

The desktop app expects one HTTP route:

- Iris Core API: agents, sessions, automations, device auth, runtime routing, memory, skills, status, runtime health, model catalogs, slash commands, and session reads come from the monorepo service in `../iris-core`, defaulting to `http://127.0.0.1:8765/v1`.

Settings edits only the Iris Core URL and Core bearer token. Runtime-specific routes, including Hermes gateway and adapter URLs, belong to Iris Core runtime configuration. The desktop app does not read local runtime files or SQLite history directly and does not keep a browser-side session cache.

Useful environment variables:

- `HERMES_DESKTOP_PYTHON`: override the Python interpreter used by the Tauri bridge.
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
