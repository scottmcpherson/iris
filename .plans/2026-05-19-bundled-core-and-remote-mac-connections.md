# Bundled Iris Core and Remote Mac Connections

## Goal

Ship Iris Desktop with Iris Core bundled into the macOS app, and support connecting Iris on one Mac to Iris/Core/Hermes on another Mac through either SSH or Tailscale.

The end state:

1. A normal same-machine user installs `Iris.app`, opens it, and gets a managed Iris Core automatically. No separate `npm run core:setup`, Python virtualenv, or manual Core process is required.
2. Iris Desktop and bundled Iris Core are version-matched. If Desktop connects to a different Core build, the app fails loudly with a clear "update the other Mac" message instead of trying to support mixed versions.
3. A MacBook can connect to a Mac mini that has Iris/Hermes installed.
4. SSH mode keeps Core private on the Mac mini by using a local SSH tunnel into `127.0.0.1:<core-port>` on the Mac mini.
5. Tailscale mode lets Core bind to a private tailnet address and use Iris device tokens for auth.
6. The Settings page replaces the raw "Core URL + token" workflow with connection modes:
   - This Mac
   - SSH to another Mac
   - Tailscale
   - Manual URL
7. Manual URL remains only as an advanced/development mode.

## Product Decision

Keep Iris Core as the product/runtime API boundary. Add SSH and Tailscale as ways to reach Core.

Do not replace Core with Desktop shelling directly into Hermes. Core already owns device auth, runtime routing, attachments, event streams, automations, and normalized Hermes records. SSH should solve transport and remote-machine ownership, not become the application protocol.

Recommended topology:

```text
Same Mac:

Iris Desktop
  -> managed bundled Core on 127.0.0.1:8765
  -> local Hermes adapter/plugin
  -> local ~/.hermes
```

```text
MacBook to Mac mini over SSH:

MacBook Iris Desktop
  -> local ssh tunnel 127.0.0.1:<ephemeral-port>
  -> Mac mini 127.0.0.1:8765 Iris Core
  -> Mac mini Hermes adapter/plugin
  -> Mac mini ~/.hermes and filesystem
```

```text
MacBook to Mac mini over Tailscale:

MacBook Iris Desktop
  -> http://mac-mini.tailnet.ts.net:8765 or http://100.x.y.z:8765
  -> Mac mini Iris Core bound to Tailscale IP
  -> Mac mini Hermes adapter/plugin
  -> Mac mini ~/.hermes and filesystem
```

## Current Repo State

Relevant files:

- `apps/desktop/src/lib/coreTransport.ts`
  - Desktop talks to Core over HTTP.
  - `coreBaseUrl()` normalizes to `/v1`.
  - `coreRequest()` uses browser `fetch()` first and falls back to the Tauri Python bridge for auth errors/timeouts.
- `apps/desktop/src/lib/irisCore.ts`
  - `getIrisCoreStatus()` calls `/health`, `/status`, `/agents`, and `/runtimes`.
  - `version` is currently returned as `null`.
  - `connectionMode` is currently only `"local" | "remote"`.
- `apps/desktop/src/app/runtimeConfig.ts`
  - Persists `connectionMode`, `remoteUrl`, and `coreApiUrl` in localStorage.
  - This will be replaced by a clean connection-profile config.
- `apps/desktop/src/features/settings/SettingsView.tsx`
  - Current Settings UI is a single "Iris Core connection" card with a URL field and a token field.
- `apps/desktop/src-tauri/src/lib.rs`
  - Current Tauri app starts menus/tray and exposes the `core_bridge` command.
  - It does not spawn or supervise Iris Core.
- `apps/desktop/src-tauri/python/core_bridge.py`
  - Provides HTTP fallback, attachment upload/download, and Core token storage via macOS Keychain.
- `apps/desktop/src-tauri/tauri.conf.json`
  - No `bundle.externalBin` sidecar is configured.
- `iris-core/README.md`
  - Documents manual Core install/run and remote Tailscale setup.
- `iris-core/src/hermes_management_server/main.py`
  - Core owns `/v1/health`, `/v1/devices/pair`, `/v1/devices/me`, `/v1/runtimes`, and the Hermes adapter-backed API.
- `iris-platform/README.md`
  - Documents the Hermes plugin and recommends Tailscale/private networking for remote delivery.

There is already a broader release plan in `.plans/2026-05-12-iris-install-release-and-compat-floor.md`. This plan supersedes the sidecar/remote-connection portions of that document and adds the Settings and SSH/Tailscale product flow.

## Clean Break Assumption

This app does not need backwards-compatibility scaffolding right now. Prefer a clean model over migration code:

- No legacy `connectionMode: "local" | "remote"` support after this work lands.
- No fallback reads from old localStorage keys.
- No fallback reads from the old single Keychain account once profile-specific accounts exist.
- No preserving the old Settings form as a hidden compatibility path.
- If local development state breaks, manually clear localStorage/Keychain entries during the transition.

Version checks still matter, but only as install-integrity checks. They should catch "MacBook Iris is newer than Mac mini Iris" or "the sidecar binary is stale," not enable old/new mixed-client support.

## Non-Goals

- Do not make Desktop talk directly to Hermes internals over SSH.
- Do not expose Core on a public interface by default.
- Do not require Tailscale for SSH mode.
- Do not require SSH for Tailscale mode.
- Do not store SSH private keys or SSH account passwords in Iris.
- Do not make the MacBook's bundled local Core manage the Mac mini's Hermes files. Core must run on the machine that owns Hermes.

## Core Concepts

### Managed Local Core

"Managed local Core" means Iris Desktop launches the bundled Core sidecar on the same Mac as the app.

Default effective URL:

```text
http://127.0.0.1:8765/v1
```

Rules:

- On app startup, Tauri probes `http://127.0.0.1:8765/v1/health`.
- If a healthy version-matched Iris Core is already running there, Desktop uses it and does not spawn another process.
- If nothing is running, Tauri starts the bundled sidecar.
- If a non-Iris service is on `8765`, Desktop surfaces a port conflict and offers an advanced port override. Do not silently switch ports for the default path, because `iris-platform` delivery config usually points at `8765`.
- On app quit, Desktop stops only the sidecar process it started. It must not kill a user-managed standalone Core.

### Remote Core Host

"Remote Core host" means the Mac that owns Hermes. In the user's example, this is the Mac mini.

The remote host can run Core in one of two ways:

- User opens Iris Desktop on the Mac mini, and Iris starts its bundled Core.
- User enables a Core LaunchAgent from Iris Settings on the Mac mini, so Core stays available after app quit/login.

The second option is important for a reliable MacBook -> Mac mini workflow. Users should not need to keep a full Iris UI open on the Mac mini forever just to use it remotely.

### SSH Mode

SSH mode creates a tunnel from MacBook to Mac mini:

```text
127.0.0.1:<local-forward-port> -> ssh -> 127.0.0.1:<remote-core-port>
```

Core remains bound to loopback on the Mac mini. From Core's perspective the request is loopback traffic, and SSH is the access boundary. No Core bearer token is required for the default SSH tunnel path.

Security constraints:

- Use system OpenSSH and the user's existing `~/.ssh/config`, `known_hosts`, and ssh-agent.
- Use `BatchMode=yes` for background probes so Iris does not hang on password/passphrase prompts.
- Do not use `StrictHostKeyChecking=no`.
- If the host key is unknown or auth fails, show an actionable Settings message telling the user to connect once in Terminal or configure SSH keys.

### Tailscale Mode

Tailscale mode connects directly to Core over the tailnet:

```text
http://mac-mini.tailnet.ts.net:8765/v1
```

or:

```text
http://100.x.y.z:8765/v1
```

Core must bind to the Mac mini's Tailscale IP or another private interface. Non-loopback Core traffic requires a token. The MacBook should store a paired device token in Keychain, not in localStorage.

Tailscale mode should not require the Tailscale CLI for MVP. The user can paste a MagicDNS name or `100.x.y.z` address. Later discovery can use Tailscale APIs/CLI if useful.

## Proposed Data Model

Replace the current two-mode runtime config with a connection-profile model. This is a clean break: delete the old runtime config shape instead of migrating it.

Proposed:

```ts
export type IrisCoreConnectionMode =
  | "managed-local"
  | "ssh"
  | "tailscale"
  | "manual-url";

export type IrisCoreConnectionProfile = {
  id: string;
  name: string;
  mode: IrisCoreConnectionMode;
  effectiveCoreApiUrl: string;
  local?: {
    port: number;
    hermesHome?: string;
    autoStart: boolean;
    installLaunchAgent: boolean;
  };
  ssh?: {
    user: string;
    host: string;
    port: number;
    remoteCoreHost: "127.0.0.1";
    remoteCorePort: number;
    localForwardPort: number | "auto";
    autoStartRemoteCore: boolean;
  };
  tailscale?: {
    host: string;
    port: number;
    requiresToken: true;
  };
  manual?: {
    url: string;
    requiresToken: boolean;
  };
};

export type HermesRuntimeConfig = {
  connectionMode: IrisCoreConnectionMode;
  activeConnectionId: string;
  coreConnections: IrisCoreConnectionProfile[];
  provider: string;
  model: string;
};
```

Persistence rules:

- Store connection profile metadata under a new key such as `iris.desktop.runtime.v2`.
- Stop writing the existing `hermes.desktop.runtime` shape.
- Do not store bearer tokens, SSH private key paths with passphrases, private keys, or passwords in localStorage.
- Continue storing Core bearer/device tokens in macOS Keychain through the native bridge.
- SSH mode should not require a stored token by default.
- For Tailscale/manual mode, store one Core token per profile. Keychain account naming should include the connection id, for example:

```text
service = "Iris Desktop"
account = "iris-core-token:<connection-id>"
```

During development, clear the old `hermes.desktop.runtime` localStorage value and the old `iris-core-token` Keychain item manually if they interfere with testing.

## Core Health and Version Identity

Add explicit version metadata to Core health responses. The goal is strict version identity for local bundles and obvious mismatch errors for remote Macs.

Core additions:

- `iris-core/src/hermes_management_server/__init__.py`
  - Keep `__version__` as the Core build identity.
- `iris-core/src/hermes_management_server/models.py`
  - Extend health model fields:
    - `service: "iris-core"`
    - `version`
    - `pid`
    - `managed: boolean | null`
    - `bindHost`
    - `port`
- `iris-core/src/hermes_management_server/main.py`
  - Return the fields from `/health` and `/v1/health`.

Desktop additions:

- Populate `HermesStatus.version` from Core health.
- Add:

```ts
coreVersionStatus?: {
  ok: boolean;
  coreVersion: string;
  clientVersion: string;
  reason?: "version-mismatch" | "unknown";
};
```

Behavior:

- If Desktop and Core versions differ, block chat actions and show a "Version mismatch" banner.
- In managed-local mode, treat a mismatch as a packaging/process bug.
- In SSH/Tailscale/manual mode, tell the user which Mac needs the matching Iris build.
- Do not add semver compatibility ranges or old-client support until there are real external users.

## Bundled Core Sidecar

### Build Core as a Standalone Binary

Use PyInstaller or another standalone Python packager to produce an `iris-core` binary from the Python package.

Initial recommendation: PyInstaller, because it is straightforward for a FastAPI/uvicorn CLI.

Files to add/update:

- `iris-core/scripts/build-binary.mjs`
  - Ensures the venv exists.
  - Installs the binary-builder dependency.
  - Runs PyInstaller.
  - Verifies `iris-core/dist/iris-core`.
- `iris-core/iris-core.spec`
  - Entry point is the Core CLI.
  - Includes package data and the `iris-platform` payload.
  - Includes hidden imports needed by FastAPI/uvicorn/httpx.
- `package.json`
  - Add `core:build:binary`.
- `apps/desktop/scripts/stage-core-sidecar.mjs`
  - Copies the built binary into `apps/desktop/src-tauri/binaries/iris-core-<target-triple>`.
- `apps/desktop/package.json`
  - Run sidecar staging before `build:mac:app` and `release:mac`.
- `apps/desktop/src-tauri/tauri.conf.json`
  - Add `bundle.externalBin`.

Apple Silicon MVP target:

```text
apps/desktop/src-tauri/binaries/iris-core-aarch64-apple-darwin
```

Universal or Intel support can follow with the corresponding Tauri target triples.

### Ship iris-platform with Core

Core should carry a version-matched copy of the Hermes `iris-platform` plugin.

Add:

- `iris-core/src/hermes_management_server/payload/iris-platform/...`
- package data rules in `iris-core/pyproject.toml`

Add Core CLI command:

```bash
iris-core install-hermes-plugin --hermes-home ~/.hermes
```

Responsibilities:

- Copy bundled `iris-platform` into `$HERMES_HOME/plugins/iris-platform`.
- Run `hermes plugins enable iris-platform`.
- Update or create plugin env hints for:
  - `IRIS_BASE_URL`
  - `IRIS_TOKEN` when needed
  - `IRIS_INBOUND_HOST`
  - `IRIS_INBOUND_PORT`
- Print a clear "Restart Hermes gateway" message.

The existing `scripts/install-iris-platform.mjs` can remain for monorepo development, but end-user setup should move to the Core CLI and Settings UI.

### Tauri Process Manager

Add a Rust-managed Core process layer instead of starting Core from React.

Suggested files:

- `apps/desktop/src-tauri/src/core_process.rs`
- `apps/desktop/src-tauri/src/connection_profiles.rs`
- `apps/desktop/src-tauri/src/lib.rs`

Commands/events:

```rust
#[tauri::command]
async fn core_sidecar_status() -> CoreSidecarStatus;

#[tauri::command]
async fn core_sidecar_start(config: CoreSidecarConfig) -> CoreSidecarStatus;

#[tauri::command]
async fn core_sidecar_stop() -> CoreSidecarStatus;

#[tauri::command]
async fn core_sidecar_restart(config: CoreSidecarConfig) -> CoreSidecarStatus;
```

Startup behavior:

1. Probe `http://127.0.0.1:8765/v1/health`.
2. If response has `service == "iris-core"` and its version matches Desktop, use it.
3. If no listener exists, spawn bundled sidecar:

```text
iris-core serve --host 127.0.0.1 --port 8765 --hermes-home ~/.hermes
```

4. Poll `/v1/health` for up to 10 seconds.
5. Emit a frontend event when ready:

```text
iris://core-ready
```

6. If spawn fails, keep the app open and show an actionable Settings error.

Shutdown behavior:

- Kill only the child handle spawned by this app process.
- Do not kill a Core that was already running.
- Capture logs to:

```text
~/Library/Logs/Iris/core.log
```

### Core LaunchAgent

Add an optional service mode for "allow other Macs to connect to this Mac."

This can be implemented as a Core CLI command or a Tauri command that writes a LaunchAgent plist.

Recommended Core CLI:

```bash
iris-core service install --host 127.0.0.1 --port 8765 --hermes-home ~/.hermes
iris-core service install --host <tailscale-ip> --port 8765 --hermes-home ~/.hermes
iris-core service uninstall
iris-core service status
```

LaunchAgent label:

```text
com.nousresearch.iris-core
```

Default paths:

```text
~/Library/LaunchAgents/com.nousresearch.iris-core.plist
~/Library/Logs/Iris/core-launchagent.out.log
~/Library/Logs/Iris/core-launchagent.err.log
```

Settings on the Mac mini can expose:

- "Run Core at login"
- "Allow SSH tunnel connections" - keeps Core on loopback
- "Allow Tailscale connections" - binds Core to a selected Tailscale/private IP and requires token pairing

## SSH Implementation

### UX Flow

On the MacBook:

1. Open Settings.
2. Choose "SSH to another Mac."
3. Enter:
   - Name: `Mac mini`
   - Host: `mac-mini.local` or `mac-mini`
   - User: `scott`
   - SSH port: `22`
   - Remote Core port: `8765`
4. Click "Test SSH."
5. Iris runs a non-interactive SSH probe.
6. If SSH works, click "Connect."
7. Iris opens a tunnel and sets the effective Core URL to:

```text
http://127.0.0.1:<local-forward-port>
```

8. Iris probes `/v1/health`, `/v1/status`, and `/v1/runtimes`.
9. If Core is not running on the Mac mini, Iris offers:
   - "Open Iris on the remote Mac"
   - "Install/run Core service on the remote Mac"
   - "I opened it, retry"

On the Mac mini:

- The user must have Iris installed.
- Hermes must be installed/configured there.
- For reliable always-available access, enable "Run Core at login" in Mac mini Iris Settings.

### Rust Tunnel Manager

Add:

- `apps/desktop/src-tauri/src/ssh_tunnel.rs`

Use system `ssh`:

```bash
ssh \
  -N \
  -L 127.0.0.1:<local-port>:127.0.0.1:<remote-core-port> \
  -p <ssh-port> \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o BatchMode=yes \
  <user>@<host>
```

Commands:

```rust
#[tauri::command]
async fn ssh_connection_probe(config: SshConnectionConfig) -> SshProbeResult;

#[tauri::command]
async fn ssh_tunnel_start(config: SshTunnelConfig) -> SshTunnelStatus;

#[tauri::command]
async fn ssh_tunnel_stop(connection_id: String) -> SshTunnelStatus;

#[tauri::command]
async fn ssh_tunnel_status(connection_id: String) -> SshTunnelStatus;
```

Probe command:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 -p <ssh-port> <user>@<host> true
```

Remote Core probe:

```bash
ssh -o BatchMode=yes -p <ssh-port> <user>@<host> \
  'curl -fsS http://127.0.0.1:<remote-core-port>/v1/health'
```

Local port selection:

- Prefer a stable remembered port per profile if available.
- If set to `"auto"`, bind a local TCP listener to port `0`, read the assigned port, close it, then immediately start SSH with that port.
- After the tunnel starts, verify `http://127.0.0.1:<local-port>/v1/health`.
- If the port is taken, retry up to 5 times.

Lifecycle:

- Keep one SSH child process per active SSH connection profile.
- Restart tunnel if it exits unexpectedly while the profile is active.
- Back off reconnect attempts:
  - 1 second
  - 2 seconds
  - 5 seconds
  - 15 seconds
  - 30 seconds
- Stop tunnel on app quit.

Error mapping:

- Unknown host key:
  - "macOS has not trusted this SSH host yet. Connect once in Terminal with `ssh user@host`, then retry."
- Auth failed:
  - "SSH authentication failed. Add a key to ssh-agent or update your `~/.ssh/config`."
- Core not running:
  - "SSH works, but Iris Core is not running on the remote Mac."
- Tunnel failed:
  - "Iris could not open the SSH tunnel. The local port may be in use."

### Optional Remote Bootstrap

Phase 1 SSH should work when Core is already running on the Mac mini.

Phase 2 can add remote bootstrap:

```bash
ssh <user>@<host> 'open -gj -a Iris'
```

Then poll:

```bash
ssh <user>@<host> 'curl -fsS http://127.0.0.1:8765/v1/health'
```

Phase 3 can add service install over SSH if Iris is installed at a known path:

```bash
ssh <user>@<host> \
  '/Applications/Iris.app/Contents/Resources/binaries/iris-core-aarch64-apple-darwin service install --host 127.0.0.1 --port 8765'
```

Do not make remote bootstrap mandatory for the first SSH release. It is better to ship a reliable tunnel first than a brittle remote installer.

## Tailscale Implementation

### UX Flow

On the Mac mini:

1. Open Iris Settings.
2. Choose "This Mac."
3. Enable "Allow connections from Tailscale."
4. Iris detects or asks for the Tailscale IP/MagicDNS name.
5. Iris restarts/installs Core service bound to that address.
6. Iris creates or shows a one-time pairing flow.

On the MacBook:

1. Open Iris Settings.
2. Choose "Tailscale."
3. Enter:
   - Name: `Mac mini`
   - Host: `mac-mini.tailnet.ts.net` or `100.x.y.z`
   - Port: `8765`
4. Pair device:
   - MVP: user pastes a token generated on the Mac mini.
   - Later: QR code or short pairing code.
5. Iris stores the paired device token in Keychain.
6. Iris sets effective Core URL:

```text
http://<tailscale-host>:8765
```

7. Iris probes `/v1/health`.

### Binding Rules

Core default:

```text
127.0.0.1:8765
```

Core when Tailscale sharing is enabled:

```text
<tailscale-ip>:8765
```

Avoid defaulting to `0.0.0.0`. If binding to `0.0.0.0` is later supported, it should be an explicit advanced option with strong warnings and token enforcement.

### Pairing

Use existing Core device pairing:

```http
POST /v1/devices/pair
Authorization: Bearer <management-token>
Content-Type: application/json

{
  "name": "Scott MacBook",
  "kind": "desktop",
  "metadata": {
    "network": "tailscale",
    "host": "mac-mini.tailnet.ts.net"
  }
}
```

MVP pairing options:

- Mac mini Settings creates a paired device token and shows it once.
- MacBook Settings accepts that token and stores it in Keychain for the Tailscale profile.

Later pairing options:

- Short-lived pairing code.
- QR code.
- `iris://pair?...` deep link.

### Token Handling

For Tailscale/manual URL profiles:

- Direct browser `fetch()` may return 401/403.
- `coreRequest()` already falls back to `core_bridge`, which reads Keychain and attaches the bearer token.
- Update `core_bridge.py` to read tokens by connection id.
- Pass `connectionId` through bridge payloads.

For SSH profiles:

- No Core token required by default because Core sees loopback traffic over the tunnel.
- Optionally allow a token if the remote Core is configured to require auth even for loopback, but keep that advanced.

## Settings Page Redesign

### Current UI

`apps/desktop/src/features/settings/SettingsView.tsx` currently has:

- One URL field
- One token field
- Save button
- Status badge

This is no longer enough because users need to choose a connection strategy, manage sidecar state, test SSH, pair Tailscale tokens, and understand which Mac owns Hermes.

### Proposed Layout

Use existing shadcn/ui primitives:

- `Tabs` or segmented `ToggleGroup` for connection modes.
- `Card` only for the repeated connection profile blocks or the main form.
- `Button`, `Input`, `Switch`, `Badge`, `Alert`, `Tooltip`, `Dialog`.
- Lucide icons for mode actions/status.

Top-level Settings section:

```text
Iris Core

[ This Mac ] [ SSH ] [ Tailscale ] [ Manual URL ]

Status row:
  Connected to: <label>
  Core version: <version>
  Hermes host: This Mac / Remote Mac
  Transport: Sidecar / SSH tunnel / Tailscale / HTTP
```

This Mac tab:

- Status of managed Core:
  - Running
  - Starting
  - Offline
  - Port conflict
- Buttons:
  - Restart Core
  - Install/update Hermes plugin
  - Open logs
- Options:
  - Core port
  - Hermes home
  - Run Core at login
  - Allow SSH tunnel connections
  - Allow Tailscale connections

SSH tab:

- Saved profiles list:
  - `Mac mini`
  - status badge
  - connect/disconnect button
- Form:
  - Profile name
  - SSH user
  - Host
  - SSH port
  - Remote Core port
  - Local port: auto or manual
  - Auto-start remote Core when possible
- Actions:
  - Test SSH
  - Test remote Core
  - Connect
  - Disconnect
- Help text should be concise and placed near errors, not as a long in-app tutorial.

Tailscale tab:

- Saved profiles list
- Form:
  - Profile name
  - Tailscale host/IP
  - Core port
  - Device token field
- Actions:
  - Test
  - Save token
  - Connect
  - Revoke device token (if current Core supports it and device id is known)

Manual URL tab:

- Preserve current advanced behavior:
  - URL
  - Token
  - Save
  - Test
- Copy should make clear that this is for custom private networking and development.

### Status Copy

Use exact language that distinguishes machine ownership:

- "This Mac: Iris Core is running locally and uses Hermes on this Mac."
- "SSH: Iris is connected to Core on Mac mini through a local SSH tunnel."
- "Tailscale: Iris is connected to Core on Mac mini over your tailnet."
- "Manual URL: Iris is connected to a custom Core URL."

Avoid saying "remote Hermes URL" because Desktop never talks directly to Hermes.

### Files to Update

- `apps/desktop/src/features/settings/SettingsView.tsx`
  - Split current connection card into mode-specific panels.
  - Add profile management.
  - Add actions that call new Tauri commands.
- `apps/desktop/src/app/runtimeConfig.ts`
  - Replace the old config shape with v2 connection profiles.
- `apps/desktop/src/types/hermes.ts`
  - Update runtime config and status types.
- `apps/desktop/src/lib/coreTransport.ts`
  - Resolve effective URL from active connection profile.
  - Include `connectionId` in bridge payloads.
- `apps/desktop/src/lib/irisRuntime.ts`
  - Update the Iris Core facade to use the new config shape.
- `apps/desktop/src/lib/irisCore.ts`
  - Populate Core version identity and transport status.
- `apps/desktop/src/App.css`
  - Add layout/states for new Settings panels.
  - Keep style consistent with existing dense desktop UI.

## Bridge and Credential Updates

Current bridge stores a single Core token:

```text
service = "Iris Desktop"
account = "iris-core-token"
```

Update bridge actions to accept:

```json
{
  "kind": "core",
  "connectionId": "profile_..."
}
```

New account:

```text
iris-core-token:<connection-id>
```

Clean break:

- Remove fallback reads from the old `iris-core-token` account.
- On save, write only the profile-specific account.
- Keep `remote_credential_status`, `remote_credential_save`, and `remote_credential_delete`, but require profile awareness.

SSH credentials:

- Do not store SSH passwords.
- Do not store private keys.
- Rely on:
  - `~/.ssh/config`
  - ssh-agent
  - macOS Keychain integration already used by OpenSSH

## Runtime Config Reset

Add tests in `apps/desktop/src/app/__tests__/runtimeConfig.test.ts`:

- Empty storage creates a `managed-local` profile.
- Old `hermes.desktop.runtime` values are ignored.
- Unsupported or invalid v2 modes fall back to a fresh `managed-local` profile.
- Tokens are never persisted in localStorage.
- Effective URL strips `/v1`, matching current behavior.

## Core API and Device Enhancements

MVP can use existing device APIs. Add small convenience endpoints only if they meaningfully simplify Settings.

Potential additions:

```http
GET /v1/connection-info
```

Returns:

```json
{
  "ok": true,
  "service": "iris-core",
  "version": "0.1.0",
  "bindHost": "127.0.0.1",
  "port": 8765,
  "authRequired": false,
  "network": {
    "loopback": true,
    "tailscaleCandidateIps": ["100.x.y.z"]
  }
}
```

Potential endpoint for local managed setup:

```http
POST /v1/devices/pair-local
```

Only allow from loopback and only when a management token is available locally. This is optional; the existing `/v1/devices/pair` is enough for MVP.

## Implementation Phases

### Phase 1 - Versioned Core and Clean Runtime Config

1. Add Core health version fields.
2. Add Desktop strict version-match checks.
3. Replace the current runtime config with v2 connection profile types.
4. Ignore old localStorage config instead of migrating it.
5. Update the current Settings UI enough to read/write the new model before the full redesign.

Verification:

- `npm --workspace apps/desktop run test -- runtimeConfig`
- `npm --workspace apps/desktop run test`
- `npm run core:test`

### Phase 2 - Bundle and Start Managed Local Core

1. Add Core binary build script/spec.
2. Stage Core binary as Tauri sidecar.
3. Add Tauri sidecar process manager.
4. Start Core automatically in managed-local mode.
5. Use an existing running Core only when it is version-matched.
6. Capture Core logs.
7. Add a Settings status card for managed Core.

Verification:

- `npm run core:build:binary`
- `npm run build:mac:app`
- Launch built app.
- Use Computer Use against `com.nousresearch.hermes-agent.desktop`.
- Confirm Core starts without `npm run dev`.
- Confirm Settings shows managed Core status.

### Phase 3 - Ship Version-Matched iris-platform Installer

1. Bundle `iris-platform` inside Core package data.
2. Add `iris-core install-hermes-plugin`.
3. Add Settings action "Install/update Hermes plugin."
4. Show restart-Hermes guidance after install.
5. Update README/install docs.

Verification:

- Pytest for plugin copy logic.
- Manual test against a temporary `HERMES_HOME`.
- Manual test against a real Hermes home when safe.

### Phase 4 - Settings Connection Modes

1. Redesign Settings into mode tabs.
2. Add profile list and active profile selection.
3. Add This Mac controls.
4. Add Manual URL as the current behavior.
5. Add status surface for transport, Core version, and Hermes owner machine.

Verification:

- Vite/browser check at `http://localhost:1420/`.
- Targeted Vitest for Settings/runtime config.
- Confirm no text overflow at narrow width.
- Packaged app verification because this is a visible Settings change and touches desktop behavior.

### Phase 5 - SSH Tunnel Mode

1. Add Rust SSH probe/tunnel manager.
2. Add Tauri commands for probe/start/stop/status.
3. Add Settings SSH form and status.
4. Add effective URL handoff to `coreTransport`.
5. Add reconnection/backoff.
6. Add clear error states for host key/auth/Core offline/tunnel failure.

Verification:

- Unit tests with a fake `ssh` executable in PATH.
- Manual test to localhost if SSH is enabled.
- Manual test MacBook -> Mac mini.
- Confirm remote Core remains bound to `127.0.0.1`.
- Confirm chat, event stream, attachment upload, and automations work through the tunnel.

### Phase 6 - Tailscale Mode

1. Add Tailscale profile Settings form.
2. Add profile-specific token storage.
3. Add Mac mini "Allow Tailscale connections" service option.
4. Bind Core to selected Tailscale/private IP.
5. Add pairing-token workflow.
6. Add revoke/show device status when possible.

Verification:

- Manual MacBook -> Mac mini over Tailscale.
- Confirm non-loopback requests without token are rejected.
- Confirm paired token works.
- Confirm stale/revoked token fails clearly.

### Phase 7 - Remote Core Service

1. Add Core LaunchAgent install/uninstall/status commands.
2. Expose "Run Core at login" in This Mac Settings.
3. Add SSH remote bootstrap helpers as optional quality-of-life actions.
4. Ensure app updates refresh the service path or use a stable app-bundle path.

Verification:

- Install service.
- Quit Iris.
- Confirm Core remains reachable.
- Reboot or log out/in and confirm Core starts.
- Uninstall service and confirm it stops.

## Acceptance Criteria

Same-machine install:

- Fresh `Iris.app` install starts Core automatically.
- User can chat with local Hermes without running repo scripts.
- Settings shows Core version and managed status.
- If Hermes/plugin is missing, Settings gives a direct install/update action.

SSH remote:

- Mac mini Core remains bound to loopback.
- MacBook Iris opens an SSH tunnel and connects through `127.0.0.1:<local-port>`.
- MacBook chat uses Mac mini Hermes and Mac mini filesystem context.
- No Core token is required in the default SSH path.
- Host key/auth failures are clear and recoverable.

Tailscale remote:

- Mac mini Core binds to a Tailscale/private IP only when enabled.
- MacBook Iris connects with a paired device token stored in Keychain.
- Non-token traffic from non-loopback addresses is rejected.
- Version mismatch is detected and blocks use until both Macs run the same Iris build.

Settings:

- Existing development settings may be reset; the new connection model is the source of truth.
- New users can understand which mode to choose without reading docs first.
- The page remains usable at desktop and narrow window sizes.
- No credentials are stored in localStorage.

Packaging:

- `npm run build:mac:app` includes the Core sidecar.
- The sidecar binary version matches the Desktop version for release builds.
- Packaged app works when launched outside the repo.

## Risks and Mitigations

Risk: Core port `8765` is already occupied.

Mitigation:

- If occupied by version-matched Iris Core, use it.
- If occupied by anything else, show a conflict in Settings and do not silently pick a new default port.
- Advanced users can configure a different local port and reinstall/update `iris-platform` config.

Risk: SSH host key prompt hangs the app.

Mitigation:

- Use `BatchMode=yes`.
- Never run interactive SSH as a hidden background command.
- Detect common stderr patterns and show Terminal instructions.

Risk: Tailscale binding accidentally exposes Core beyond the tailnet.

Mitigation:

- Prefer binding to a specific `100.x.y.z` address.
- Require tokens for all non-loopback traffic.
- Keep `0.0.0.0` as explicit advanced mode only.

Risk: Remote Core and Desktop versions drift.

Mitigation:

- Add health version metadata.
- Require exact version match.
- Settings should show whether the MacBook or Mac mini has the stale build.
- Do not carry compatibility ranges until distribution needs them.

Risk: LaunchAgent points to an old app bundle path after update.

Mitigation:

- Use stable `/Applications/Iris.app/...` path when possible.
- On app start, check installed LaunchAgent path and offer repair.
- Add `iris-core service install --replace`.

Risk: PyInstaller misses dynamic imports.

Mitigation:

- Add package-check script that runs the built sidecar and calls `/v1/health`.
- Keep hidden imports in the spec file.
- Run packaged-app verification on every release candidate.

## Documentation Updates

Update:

- `README.md`
  - Same-machine install: "Install Iris.app and open it."
  - Remote Mac overview: SSH vs Tailscale.
- `iris-core/README.md`
  - Core sidecar/service behavior.
  - `install-hermes-plugin`.
  - LaunchAgent service commands.
- `iris-platform/README.md`
  - Explain that Iris can configure/install the plugin.
  - Keep manual env examples.
- `apps/desktop/README.md`
  - Settings connection modes.
  - Troubleshooting SSH/Tailscale.

## Developer Verification Matrix

For UI-only Settings work:

- Use Vite browser check at `http://localhost:1420/`.
- Run targeted Vitest.

For sidecar/process work:

- Run Rust checks/tests where available.
- Run bridge tests.
- Run `npm run build:mac:app`.
- Launch fresh bundle.
- Verify with Computer Use against `com.nousresearch.hermes-agent.desktop`.

For remote transports:

- SSH:
  - fake-ssh unit tests
  - real MacBook -> Mac mini manual test
- Tailscale:
  - real tailnet manual test
  - token rejection/acceptance checks

For Core:

- `npm run core:test`
- Built sidecar smoke:

```bash
iris-core/dist/iris-core serve --host 127.0.0.1 --port 8765
curl http://127.0.0.1:8765/v1/health
```

## Suggested First PR Slice

Start with a PR that does not redesign all Settings at once:

1. Add Core health version metadata.
2. Replace runtime config with v2 connection profiles.
3. Add strict version status to `getIrisCoreStatus()`.
4. Add tests.

Then land sidecar startup as the second PR.

This keeps the hardest product-risk changes small enough to verify before SSH/Tailscale UI arrives.
