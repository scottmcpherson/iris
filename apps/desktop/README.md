# Iris Desktop

Iris Desktop is the native Tauri 2, React 18, TypeScript, and Tailwind client for Iris.

This app lives in the `apps/desktop/` workspace of the Iris monorepo. For normal setup and startup, run commands from the repository root.

## Current Capabilities

- macOS-style app layout with sidebar navigation and session workspace.
- Rust Tauri command bridge used for explicit packaged-app Core requests, Core attachment uploads from local paths, and native attachment media conversion.
- Iris Core discovery for agents, memory files, skills, sessions, model catalogs, slash commands, automations, and runtime health.
- Sessions, profile actions, memory writes, skill writes, model catalog, slash commands, and automations all route through Iris Core. Hermes remains a runtime adapter behind Core.
- First-run setup for Local Hermes and Hermes via SSH.
- Mobile pairing QR generation for SSH-only Iris Mobile development builds.

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

From this `apps/desktop/` directory:

```bash
npm install
npm run dev
npm run tauri dev
```

The web dev surface runs on `http://localhost:1420/`. The full desktop shell is launched with root `npm run dev` or local `npm run tauri dev`.

## Iris Core Integration

The packaged desktop app includes a version-matched Iris Core sidecar. On startup, the Tauri shell probes `127.0.0.1:8765/v1/health`; if a matching Core is already running it is reused, otherwise Iris starts the bundled sidecar and writes logs to `~/Library/Logs/Iris/core.log`.

The desktop app expects one HTTP route:

- Iris Core API: agents, sessions, automations, runtime routing, memory, skills, status, runtime health, model catalogs, slash commands, and session reads come from the monorepo service in `../../iris-core`, defaulting to `http://127.0.0.1:8765/v1`.

First-run setup and Settings use connection profiles instead of a single URL/token form:

- `Local`: managed local sidecar, local Core port, Hermes home, Hermes adapter install, Core service install, and logs.
- `SSH`: saved remote-host profiles, local tunnel connect/disconnect, and clear host-key/auth/Core-offline errors.

Runtime-specific routes, including Hermes gateway and adapter URLs, belong to Iris Core runtime configuration. The desktop app does not read local runtime files or SQLite history directly and does not keep a browser-side session cache. Iris Desktop supports Local and SSH Core connections; it does not store Core bearer tokens or paired device credentials.

Useful environment variables:

- `IRIS_DESKTOP_PYTHON`: override the Python interpreter used by the Tauri bridge.
- `IRIS_CORE_BINARY`: override the sidecar binary used by the Tauri process manager during development.

## Remote Connection Notes

SSH mode uses system OpenSSH with `BatchMode=yes`; Iris does not store SSH passwords or private keys. Configure `~/.ssh/config`, `known_hosts`, and ssh-agent outside the app. If remote Core is not running, start Iris Core on the remote host and keep it bound to `127.0.0.1:8765`, then retry the tunnel.

SSH is the supported remote path. The desktop setup UI does not expose manual Core URLs, direct Tailscale/private-network Core mode, or paired device tokens.

## Mobile Pairing

Open Settings -> Pair mobile device to generate a QR code for Iris Mobile. The QR code expires after about five minutes and contains only SSH connection coordinates, the remote Core loopback port, a nonce, and display labels. It intentionally excludes private keys, passwords, bearer tokens, and direct Core URLs.

The mobile app still performs SSH host-key verification and stores the accepted connection profile, host-key fingerprint, and entered SSH password in secure mobile storage. If the advertised host is not reachable from the phone, edit the SSH host in the mobile pairing confirmation screen before saving.

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
