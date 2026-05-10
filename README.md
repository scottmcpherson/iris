# Iris

Iris is a monorepo for local-first agent control surfaces, including Iris Desktop and Iris Core. Hermes remains the first runtime backend through the Iris Hermes Adapter; Iris owns the user-facing app model, device/auth layer, and routing surface while runtime-owned records stay in their runtime source of truth.

## Workspace Layout

- `desktop/`: Iris Desktop, a Tauri 2, React 18, TypeScript, and Tailwind desktop app.
- `iris-core/`: Iris Core, a FastAPI control plane used by Iris clients for agents, sessions, automations, devices, runtime routing, and Hermes compatibility metadata.
- `scripts/`: root developer helpers for setup and coordinated startup.

## First-Time Setup

```bash
npm run bootstrap
```

This installs the desktop Node dependencies, creates `iris-core/.venv`, and installs Iris Core in editable development mode.

If Node dependencies are already installed and you only need the Python Iris Core environment:

```bash
npm run core:setup
```

## Daily Development

Start the Iris Core and the Tauri desktop app together:

```bash
npm run dev
```

`npm run dev` starts Iris Core on `127.0.0.1:8765`, then launches Iris Desktop. `HERMES_HOME` is still accepted as an Iris Core runtime default for the local Hermes adapter, and `API_SERVER_KEY` from `$HERMES_HOME/.env` is passed to Core as the Hermes Jobs API token when present.

Start the Iris Core and the Vite web surface only:

```bash
npm run dev:web
```

Start only Iris Core:

```bash
npm run core:dev
```

The desktop Vite server runs on `http://127.0.0.1:1420/`. Iris Core defaults to `http://127.0.0.1:8765/v1`.

## Iris Core API

Iris Core is the local-first control plane for Iris at `http://127.0.0.1:8765/v1`. It owns devices, auth, runtime routing, and Core-only coordination, and connects to Hermes through the Iris Hermes Adapter.

Core stores Core-owned state at `~/.iris/core.sqlite3` by default. Hermes remains the source of truth for Hermes profiles, sessions, messages, models, commands, and jobs; Core normalizes those records through runtime adapters instead of copying them into SQLite. Existing default installs are migrated from `~/.agent-ui/core.sqlite3` with backups before duplicate runtime-owned tables are dropped. Iris Desktop sessions create short-lived Core draft targets and send messages through Core, while Hermes platform deliveries land in `/v1/runtime-deliveries/hermes` and replay through the in-memory `/v1/events` live buffer.

Product terminology uses "sessions" for user-facing work threads. Some compatibility APIs, schemas, and legacy adapter fields still use `conversation` or `chat` names.

## Iris Hermes Adapter

Install or update the bidirectional Iris platform plugin into the local Hermes home:

```bash
npm run iris:hermes:install
```

`npm run iris:platform:install` is the same installer under a platform-focused name. Configure Hermes to receive Iris session messages and deliver responses into Iris Core. Add these to the environment used by the Hermes gateway, commonly `$HERMES_HOME/.env`:

```bash
IRIS_BASE_URL=http://127.0.0.1:8765
IRIS_TOKEN=replace-with-a-local-token
IRIS_DEFAULT_CHAT_ID=desktop
IRIS_INBOUND_HOST=127.0.0.1
IRIS_INBOUND_PORT=8766
IRIS_ALLOWED_USERS=agentui-user
```

Existing `AGENTUI_*` environment variables are accepted for compatibility. New Hermes delivery targets should use the `iris:` platform prefix.

Enable Hermes gateway streaming in the selected Hermes profile config. This is a top-level setting, separate from `display.streaming`:

```yaml
streaming:
  enabled: true
```

Protect the legacy Iris Core inbox compatibility routes with the same shared platform token. These routes are in-memory compatibility endpoints; they do not create a separate inbox database.

```bash
IRIS_INBOX_TOKEN=replace-with-a-local-token
```

Restart the Hermes gateway after changing plugin config, then run Iris with:

```bash
npm run dev
```

Smoke test delivery:

```bash
hermes cron create "1m" "Reply exactly: Iris cron smoke test" --deliver "iris:desktop" --name "Iris local smoke test"
```

The job should appear under Automations, then move to Recent deliveries after it runs.

Smoke test inbound session delivery:

```bash
curl -X POST http://127.0.0.1:8766/iris/messages \
  -H "Authorization: Bearer $IRIS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chatId":"desktop","messageId":"manual-test","userId":"agentui-user","userName":"Iris User","text":"Say hello from Iris."}'
```

## Verification

```bash
npm run check
npm run package:check
npm run build:mac:app
```

`npm run check` runs the desktop TypeScript/Vitest/build checks, the desktop Python bridge tests, and the Iris Core pytest suite. `npm run build:mac:app` delegates to the desktop Tauri app build.

## More Detail

- Desktop app docs: [`desktop/README.md`](desktop/README.md)
- Iris Core docs: [`iris-core/README.md`](iris-core/README.md)
- Production packaging notes: [`desktop/docs/production-readiness.md`](desktop/docs/production-readiness.md)
