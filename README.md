# Iris

Iris is a monorepo for local-first agent control surfaces, including Iris Desktop and Iris Core. Hermes remains the first runtime backend through the Iris Hermes Adapter; Iris owns the user-facing app model, local/SSH connection boundary, and routing surface while runtime-owned records stay in their runtime source of truth.

## Workspace Layout

- `apps/desktop/`: Iris Desktop, a Tauri 2, React 18, TypeScript, and Tailwind desktop app.
- `apps/mobile/`: Iris Mobile, an Expo development-build app that pairs to a desktop host and talks to Iris Core through SSH.
- `packages/`: shared TypeScript packages for Iris Core API calls, query keys, chat reconciliation helpers, and theme tokens.
- `iris-core/`: Iris Core, a FastAPI control plane used by Iris clients for agents, sessions, automations, runtime routing, and Hermes compatibility metadata.
- `scripts/`: root developer helpers for setup and coordinated startup.

## First-Time Setup

For a normal install, build or install `Iris.app` and open it. The packaged app includes a version-matched Iris Core sidecar and starts it on `127.0.0.1:8765` automatically; users do not need to run `npm run core:setup`, a Python virtualenv, or a separate Core process.

On first launch, Iris shows a setup assistant with two paths:

- `Local Hermes`: Iris Core and Hermes run on the same machine. Iris can start managed Core, install or update the Hermes adapter, and then asks you to restart the Hermes gateway.
- `Hermes via SSH`: Iris opens a local SSH tunnel to `127.0.0.1:8765` on a remote host where Iris Core and Hermes are already running. Core remains private on that host and no Core bearer token is required for the default loopback tunnel path.

Developer setup still uses the monorepo tools:

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

Start a desktop dev session with Core reachable from Iris Mobile:

```bash
npm run dev:mobile-pairing
```

Start only Iris Core:

```bash
npm run core:dev
```

The desktop Vite server runs on `http://localhost:1420/`. Iris Core defaults to `http://127.0.0.1:8765/v1`.

Start the mobile Expo development server:

```bash
npm run mobile:dev
```

Create native development builds when testing device behavior:

```bash
npm run mobile:ios
npm run mobile:android
```

## Runtime Connections

Iris Desktop always talks to Iris Core, and Core must run on the machine that owns Hermes. Use first-run setup or Settings to choose the current connection paths:

- `Local`: the packaged app manages the bundled local Core sidecar and local Hermes configuration.
- `SSH`: Iris opens a local tunnel to `127.0.0.1:<core-port>` on a remote host. Core stays private on that host and no Core bearer token is required for the default loopback tunnel path.

For Hermes via SSH, start Iris Core on the remote host first, install or update the Hermes adapter there, restart the Hermes gateway, then add the SSH endpoint from Iris setup or Settings. Iris uses system OpenSSH with `BatchMode=yes`, so host keys, SSH config, and ssh-agent should be prepared outside the app.

SSH is the supported remote path. Iris Desktop does not expose direct private-network Core URLs, Tailscale-specific Core mode, or manual URL mode.

## Iris Mobile Pairing

Iris Mobile pairs from Settings -> Pair mobile device in Iris Desktop. The desktop QR code contains a short-lived pairing code and a Tailscale-reachable Iris Core URL. It does not contain a password, private key, reusable Core token, or SSH credential.

Mobile V1 connects directly to Iris Core over Tailscale. When generating a local pairing QR, Iris Desktop prepares its managed Core sidecar for mobile access on the selected Core port. During pairing, the phone creates its own device credential, sends only the credential hash to Core, and stores the raw credential in iOS secure storage. After pairing, Core accepts that device credential as app-level authorization for mobile requests. Core can stay unauthenticated for local loopback and SSH-tunnel callers, while non-loopback Tailscale callers must present a valid management token or paired mobile device token.

## Iris Core API

Iris Core is the local-first control plane for Iris at `http://127.0.0.1:8765/v1`. It owns agents, sessions, automations, runtime routing, and Core-only coordination, and connects to Hermes through the Iris Hermes Adapter.

Core stores Core-owned state at `~/.iris/core.sqlite3` by default. Hermes remains the source of truth for Hermes profiles, sessions, messages, models, commands, and jobs; Core normalizes those records through runtime adapters instead of copying them into SQLite. Existing default installs are migrated from `~/.agent-ui/core.sqlite3` with backups before duplicate runtime-owned tables are dropped. Iris Desktop sessions create short-lived Core draft targets and send messages through Core, while Hermes platform deliveries land in `/v1/runtime-deliveries/hermes` and replay through the in-memory `/v1/events` live buffer.

Product terminology uses "sessions" for user-facing work threads. Core API routes, payload fields, and SQLite overlay tables use session naming; runtime adapter metadata may still carry lower-level `chat` identifiers when Hermes requires them.

## Iris Hermes Adapter

The easiest path is inside Iris Desktop: use first-run setup or Settings -> Local -> Service management -> Install Iris adapter. The packaged app runs the version-matched Core installer, copies the bundled `iris-platform` plugin, writes Hermes `.env` hints, removes stale Iris-managed `IRIS_TOKEN` entries, enables the plugin when the Hermes CLI is available, and then requires a Hermes gateway restart.

The same installer is available from the Core binary:

```bash
npm run core:build:binary
iris-core/dist/iris-core install-hermes-plugin --hermes-home ~/.hermes
```

For monorepo development, the source-tree Node installer is still available. It copies the working-tree plugin into Hermes plugin directories and enables it, but the Core binary installer above is preferred for packaged/version-matched installs:

```bash
npm run iris:hermes:install
```

`npm run iris:platform:install` is the same installer under a platform-focused name.

For manual configuration, set these values where the Hermes gateway process can read them, commonly `$HERMES_HOME/.env`:

```bash
IRIS_BASE_URL=http://127.0.0.1:8765
IRIS_INBOUND_HOST=127.0.0.1
IRIS_INBOUND_PORT=8766
# Optional routing/user defaults.
IRIS_DEFAULT_CHAT_ID=desktop
IRIS_ALLOWED_USERS=iris-user
```

For both local Iris and SSH remote hosts, the adapter should use loopback from the Hermes host's point of view. Iris Desktop reaches remote Core through an SSH tunnel, so auth headers are normally omitted on the adapter/Core path. Core uses `HERMES_API_TOKEN` when set, otherwise it discovers Hermes' `API_SERVER_KEY` from `$HERMES_HOME/.env` for Jobs API calls.

Enable Hermes gateway streaming in the selected Hermes profile config. This is a top-level setting, separate from `display.streaming`:

```yaml
streaming:
  enabled: true
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
  -H "Content-Type: application/json" \
  -d '{"chatId":"desktop","messageId":"manual-test","userId":"iris-user","userName":"Iris User","text":"Say hello from Iris."}'
```

The old `/v1/inbox/*` Core routes are gone; Hermes deliveries use `POST /v1/runtime-deliveries/hermes`.

## Verification

```bash
npm run check
npm run package:check
npm run build:mac:app
```

`npm run check` runs the desktop TypeScript/Vitest/build checks, the desktop Python bridge tests, and the Iris Core pytest suite. `npm run build:mac:app` builds the standalone Iris Core binary for the current Mac, stages it as the Tauri sidecar, and creates the macOS app bundle. Release CI builds a universal macOS bundle by combining native `arm64` and `x86_64` Iris Core sidecars into one Tauri app.

## More Detail

- Desktop app docs: [`apps/desktop/README.md`](apps/desktop/README.md)
- Iris Core docs: [`iris-core/README.md`](iris-core/README.md)
- Production packaging notes: [`apps/desktop/docs/production-readiness.md`](apps/desktop/docs/production-readiness.md)
