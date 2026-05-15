# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo layout

- `desktop/` — Iris Desktop: Tauri 2 + React 18 + TypeScript + Tailwind. The npm workspace `iris-desktop`.
- `iris-core/` — Iris Core: Python 3.11+/FastAPI control plane (`hermes_management_server` package, `iris-core` CLI). Not an npm workspace; managed via `iris-core/.venv` created by `scripts/setup-iris-core.mjs`.
- `iris-platform/` — Hermes-side plugin (`iris-platform`) that bridges Hermes ↔ Iris Core. Installed into `~/.hermes/plugins/iris-platform`, not into a venv.
- `scripts/` — Root dev orchestration (`dev.mjs`, `setup-iris-core.mjs`, `install-iris-platform.mjs`).

## Common commands

Run from the repo root unless noted.

- `npm run bootstrap` — first-time setup; installs Node deps and creates `iris-core/.venv` with editable Core install.
- `npm run dev` — start Core on `127.0.0.1:8765` and launch the Tauri desktop shell.
- `npm run dev:web` — start Core and the Vite web surface only (`http://127.0.0.1:1420/`). Prefer for UI iteration; the in-app browser sometimes blocks `127.0.0.1`, in which case use `http://localhost:1420/`.
- `npm run dev:no-core` — skip starting Core (e.g. when Core is already running elsewhere).
- `npm run core:dev` — Core alone.
- `npm run core:test` — Core pytest suite (`iris-core/.venv/bin/python -m pytest iris-core`).
- `npm run check` — full pre-commit gate: desktop vitest, desktop Python bridge unittests, desktop `tsc && vite build`, then Core pytest.
- `npm run package:check` — packaging-time validation (`desktop/scripts/package-checks.mjs`).
- `npm run build:mac:app` — fresh macOS `.app` bundle. Use this (not `tauri dev`) when verifying packaged desktop behavior with Computer Use against `com.nousresearch.hermes-agent.desktop`.
- `npm run iris:hermes:install` (alias `iris:platform:install`) — install/update the `iris-platform` Hermes plugin into `~/.hermes/plugins/`.

### Running a single test

- Vitest (desktop): `npm --workspace desktop run test -- path/to/file.test.ts -t "name"` or `npm --workspace desktop run test:watch -- path/to/file.test.ts`.
- Python bridge unittest (desktop): `cd desktop && python3 -m unittest src-tauri.python.tests.test_core_bridge.ClassName.test_method`.
- Core pytest: `iris-core/.venv/bin/python -m pytest iris-core/tests/test_api.py::test_name`.

## Architecture

Iris Desktop is a thin client. It talks to **one** backend HTTP service: Iris Core at `http://127.0.0.1:8765/v1`. Settings expose only the Core URL and bearer token; the desktop never reads `~/.hermes`, Hermes SQLite, or runtime files directly.

```
Iris Desktop (Tauri/React)
    │  HTTP /v1/*
    ▼
Iris Core (FastAPI)  ── core-owned state: ~/.iris/core.sqlite3
    │
    ├── Runtime adapter (Hermes)  ─ read-only access to ~/.hermes
    │
    └── /v1/runtime-deliveries/hermes ◀─── Hermes gateway + iris-platform plugin
        + /v1/events live buffer            (delivers responses & cron output)
```

Key invariants:

- **Hermes is the source of truth** for profiles, sessions, messages, models, slash commands, memory, skills, and jobs. Core normalizes those via `runtime_adapters/hermes*.py` rather than copying into its SQLite. Don't add code that duplicates Hermes-owned records into Core storage.
- **Core owns**: devices/auth, runtime routing, automations, and short-lived session drafts. Lives in `~/.iris/core.sqlite3` (migrated from the legacy `~/.agent-ui/core.sqlite3` on startup).
- **Tauri Python bridge** (`desktop/src-tauri/python/core_bridge.py`) is Core-only: HTTP request fallback, attachment upload-by-path, and OS credential storage. It must not inspect or mutate runtime-owned files.
- **Terminology**: product UI says "sessions"; HTTP routes and SQLite overlay tables use `session`; Hermes-level adapter metadata may still carry `chat` identifiers — both are expected.
- **Live deliveries**: Hermes posts to `/v1/runtime-deliveries/hermes`; clients subscribe via the in-memory `/v1/events` buffer. The old `/v1/inbox/*` compatibility routes are removed.
- **Auth**: `IRIS_TOKEN` is the only Iris-owned bearer secret. It is optional for same-machine loopback Core/Desktop/plugin traffic and required for non-loopback traffic. Core uses `HERMES_API_TOKEN` for Hermes Jobs API calls when present, otherwise it discovers `API_SERVER_KEY` from `$HERMES_HOME/.env`.

### Desktop code layout

- `src/lib/` — Core transport (`coreTransport.ts`), the main Core client (`irisCore.ts`), Core-to-Hermes view mappings (`irisCoreMappings.ts`), runtime helpers (`irisRuntime.ts`).
- `src/app/` — app-level state (sessions, navigation, runtime config, offline profile, storage).
- `src/features/` — feature modules: `agents`, `chat`, `iris`, `jobs`, `memory`, `polish`, `preview`, `projects`, `settings`, `skills`. Tests sit in `__tests__/` next to the code they cover.
- `src/layout/`, `src/shared/`, `src/types/` — chrome, shared utilities, and shared TS types (notably `types/hermes.ts`).

### Core code layout

- `iris-core/src/hermes_management_server/`:
  - `main.py` — FastAPI app + `iris-core` CLI entrypoint.
  - `core_store.py` — SQLite-backed Core-owned state (devices, automations, draft sessions, attachments).
  - `runtime_adapters/` — adapter interface (`base.py`) and the Hermes implementation (`hermes.py`, `hermes_store.py`, `hermes_sessions.py`).
  - `runtime_registry.py`, `security.py`, `message_coalescer.py`, `models.py`, `attachment_*.py`.
- `iris-core/tests/` — pytest suite; `test_api.py` covers HTTP behavior, `test_core_store.py` the storage layer.

## Working-style notes (from `AGENTS.md`)

- Assume the user has `npm run dev` running. After finishing a change, state whether their existing session will pick it up or whether they must restart the dev runner / restart Core / reinstall the Hermes plugin / restart the Hermes gateway / open a fresh chat.
- For routine iteration, prefer Vite browser checks + targeted unit tests over rebuilding the desktop app.
- For final verification of visible UI or desktop-shell behavior, build a fresh app bundle with `npm run build:mac:app`, launch it, and drive it with the Computer Use plugin against `com.nousresearch.hermes-agent.desktop`. Do **not** use the raw `npm run tauri dev` binary for Computer Use — it may lack a bundle identifier and end up attaching to a stale bundled app.
- Never run multiple packaged-app verification sessions in parallel against the same bundle identifier. Parallel feature work belongs in separate browser/Vite checks, ports, or worktrees; serialize the packaged-app step.
