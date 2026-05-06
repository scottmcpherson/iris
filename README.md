# Iris

Iris is a monorepo for local-first agent control surfaces, including Iris Desktop and Iris Core. Hermes remains the first runtime backend through the Iris Hermes Adapter, but Iris owns the user-facing app, conversations, automations, devices, and routing model.

## Workspace Layout

- `desktop/`: Iris Desktop, a Tauri 2, React 18, TypeScript, and Tailwind desktop app.
- `sidecar/`: Iris Core, a FastAPI control plane used by Iris clients for agents, conversations, automations, devices, runtime routing, and Hermes compatibility metadata.
- `scripts/`: root developer helpers for setup and coordinated startup.

## First-Time Setup

```bash
npm run bootstrap
```

This installs the desktop Node dependencies, creates `sidecar/.venv`, and installs the sidecar in editable development mode.

If Node dependencies are already installed and you only need the Python sidecar environment:

```bash
npm run sidecar:setup
```

## Daily Development

Start the sidecar and the Tauri desktop app together:

```bash
npm run dev
```

`npm run dev` defaults `HERMES_HOME` to `~/.hermes`, starts Iris Core on `127.0.0.1:8765`, and auto-loads `API_SERVER_KEY` from `$HERMES_HOME/.env` as `HERMES_API_TOKEN` for the desktop app. That lets the Automations view call Hermes' local Jobs API without exporting the token by hand.

Start the sidecar and the Vite web surface only:

```bash
npm run dev:web
```

Start only the sidecar:

```bash
npm run sidecar:dev
```

The desktop Vite server runs on `http://127.0.0.1:1420/`. Iris Core defaults to `http://127.0.0.1:8765/v1`.

## Iris Core API

Iris Core is the local-first control plane for Iris at `http://127.0.0.1:8765/v1`. It owns Iris conversations, messages, automations, devices, auth, and runtime routing, and connects to Hermes through the Iris Hermes Adapter.

Core keeps the existing SQLite storage at `~/.agent-ui/core.sqlite3` by default for compatibility, seeds a local Hermes runtime, maps Hermes profiles into Iris agents, and keeps existing Hermes management routes available. Iris Desktop chat creates Core conversations and sends messages through Core, while Hermes platform deliveries land in `/v1/runtime-deliveries/hermes` and replay through `/v1/events`.

## Iris Hermes Adapter

Install or update the bidirectional Iris platform plugin into the local Hermes home:

```bash
npm run iris:hermes:install
```

The legacy `npm run hermes:agentui:install` script remains available. Configure Hermes to receive Iris chat messages and deliver responses into Iris Core. Add these to the environment used by the Hermes gateway, commonly `$HERMES_HOME/.env`:

```bash
IRIS_BASE_URL=http://127.0.0.1:8765
IRIS_TOKEN=replace-with-a-local-token
IRIS_DEFAULT_CHAT_ID=desktop
IRIS_INBOUND_HOST=127.0.0.1
IRIS_INBOUND_PORT=8766
IRIS_ALLOWED_USERS=agentui-user
```

Existing `AGENTUI_*` environment variables and `agentui:` delivery targets are still accepted for compatibility.

Enable Hermes gateway streaming in the selected Hermes profile config. This is a top-level setting, separate from `display.streaming`:

```yaml
streaming:
  enabled: true
```

Protect the Iris Core inbox with the same shared platform token:

```bash
IRIS_INBOX_TOKEN=replace-with-a-local-token
```

Restart the Hermes gateway after changing plugin config, then run Iris with:

```bash
npm run dev
```

Smoke test delivery:

```bash
hermes cron create "1m" "Reply exactly: Iris cron smoke test" --deliver "agentui:desktop" --name "Iris local smoke test"
```

The job should appear under Automations, then move to Recent deliveries after it runs.

Smoke test inbound chat:

```bash
curl -X POST http://127.0.0.1:8766/agentui/messages \
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

`npm run check` runs the desktop TypeScript/Vitest/build checks, the desktop Python bridge tests, and the sidecar pytest suite. `npm run build:mac:app` delegates to the desktop Tauri app build.

## More Detail

- Desktop app docs: [`desktop/README.md`](desktop/README.md)
- Sidecar docs: [`sidecar/README.md`](sidecar/README.md)
- Production packaging notes: [`desktop/docs/production-readiness.md`](desktop/docs/production-readiness.md)
