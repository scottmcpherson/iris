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

The packaged desktop app includes a version-matched Iris Core sidecar. On startup, the Tauri shell probes `127.0.0.1:8765/v1/health`; if a matching Core is already running it is reused, otherwise Iris starts the bundled sidecar and writes logs to `~/Library/Logs/Iris/core.log`.

The desktop app expects one HTTP route:

- Iris Core API: agents, sessions, automations, device auth, runtime routing, memory, skills, status, runtime health, model catalogs, slash commands, and session reads come from the monorepo service in `../iris-core`, defaulting to `http://127.0.0.1:8765/v1`.

Settings uses connection profiles instead of a single URL/token form:

- `This Mac`: managed local sidecar, local Core port, Hermes home, plugin install, Core service install, logs, and Tailscale pairing-token creation.
- `SSH`: saved remote Mac profiles, non-interactive SSH probe, remote Core probe, local tunnel connect/disconnect, and clear host-key/auth/Core-offline errors.
- `Tailscale`: saved private-network profiles, paired device token storage in Keychain, test, and connect.
- `Manual URL`: advanced/development mode for custom private Core URLs and optional tokens.

Runtime-specific routes, including Hermes gateway and adapter URLs, belong to Iris Core runtime configuration. The desktop app does not read local runtime files or SQLite history directly and does not keep a browser-side session cache. Core bearer/device tokens are stored through the OS credential store under profile-specific accounts, not in browser local storage.

Useful environment variables:

- `IRIS_DESKTOP_PYTHON`: override the Python interpreter used by the Tauri bridge.
- `IRIS_TOKEN`: provide the Iris bearer token for non-loopback Core traffic.
- `IRIS_CORE_BINARY`: override the sidecar binary used by the Tauri process manager during development.

## Remote Connection Notes

SSH mode uses system OpenSSH with `BatchMode=yes`; Iris does not store SSH passwords or private keys. Configure `~/.ssh/config`, `known_hosts`, and ssh-agent outside the app. If the remote Core is not running, start Iris or install the Core login service on the remote Mac.

Tailscale mode does not require the Tailscale CLI. Enter a MagicDNS name or `100.x.y.z` address in Settings and paste a paired device token generated on the Mac that owns Hermes.

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

From the repository root, `npm run build:mac:app` also builds the standalone Iris Core binary before staging it into the app bundle. See `docs/production-readiness.md` for the permissions review, packaging notes, and release environment requirements.
