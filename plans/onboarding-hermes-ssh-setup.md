# Onboarding: Local Hermes and Hermes via SSH

## Goal

Improve first-run setup so users can connect Iris to Hermes with less manual configuration. The onboarding experience should support two clear paths:

- Local Hermes: Iris Core runs on the same machine as Hermes.
- Hermes via SSH: Iris connects over SSH to a remote host running Iris Core and Hermes.

The SSH path must not assume the remote host is macOS. Product copy should say "remote host" or "remote machine", not "another Mac", "Mac mini", or similar OS-specific language.

## Current State

Relevant existing code:

- `desktop/src/features/polish/OnboardingOverlay.tsx`
  - Current first-run overlay is generic and sends users to Settings.
- `desktop/src/features/settings/SettingsView.tsx`
  - Owns Local and SSH setup UI.
  - Contains `SshConnectionDialog`, `connectSsh`, `disconnectSsh`, and local Hermes plugin install actions.
- `desktop/src/features/iris/sshRuntime.ts`
  - Contains reconnect/runtime refresh logic through `ensureActiveSshTunnel`.
- `desktop/src-tauri/src/ssh_tunnel.rs`
  - Owns SSH probe/tunnel commands.
  - Currently has macOS-specific remote-start behavior through `open_remote_iris`.
- `desktop/src-tauri/src/connection_profiles.rs`
  - Wraps Iris Core CLI commands such as `core_install_hermes_plugin`.
- `iris-core/src/hermes_management_server/main.py`
  - Implements `install-hermes-plugin`, writes env hints, enables the plugin, and marks Hermes gateway restart as required.
- `desktop/src/lib/irisCore.ts`
  - Builds status from Core health, runtime probes, and agent/runtime rows.

## Product Shape

On first run, show a setup assistant with two choices:

1. **Local Hermes**
   - Starts or verifies managed Iris Core.
   - Detects or asks for Hermes home.
   - Installs/updates the Hermes `iris-platform` adapter.
   - Writes Hermes env hints.
   - Explains that Hermes gateway must be restarted.
   - Rechecks Core, Hermes gateway, and Iris adapter readiness.

2. **Hermes via SSH**
   - User enters an SSH endpoint such as `user@host`.
   - Iris starts an SSH tunnel to remote Iris Core.
   - Iris verifies version compatibility and Hermes readiness through the tunneled Core.
   - If Core is not reachable, show OS-neutral remediation copy.

Do not duplicate SSH setup behavior between onboarding and Settings. Onboarding should reuse the same components and logic that Settings uses.

## Implementation Plan

### 1. Extract Shared SSH UI and Logic

Create shared SSH setup primitives, likely under `desktop/src/features/iris/` or `desktop/src/features/settings/connection/`.

Suggested files:

- `desktop/src/features/iris/useSshConnectionManager.ts`
- `desktop/src/features/iris/SshConnectionDialog.tsx`
- Optional: `desktop/src/features/iris/sshConnectionDraft.ts`

Move or share the following from `SettingsView.tsx`:

- `SshConnectionDialog`
- `SshDraft`
- `SshAuthMode`
- `parseSshHostname`
- `sshDraftFromConfig`
- `connectSsh`
- `disconnectSsh`

The hook should expose structured actions rather than forcing Settings-specific UI behavior:

```ts
type SshConnectionResult = {
  ok: boolean;
  profile?: IrisCoreConnectionProfile;
  status?: SshTunnelStatus;
  error?: string;
};
```

Settings can keep toast behavior if desired, but the shared hook should make it possible for onboarding to render inline errors and next actions.

### 2. Update Settings to Consume Shared SSH Primitives

Refactor `SettingsView.tsx` so it imports the shared dialog and hook instead of owning the SSH implementation.

Behavior should remain the same after extraction:

- Existing saved SSH profiles still render.
- Toggle-on starts/connects through the same Tauri `ssh_tunnel_start` command.
- Toggle-off disconnects through `ssh_tunnel_stop`.
- Runtime config is updated through `upsertCoreConnection` / `activateCoreConnection`.

This step prevents onboarding and Settings from drifting.

### 3. Make SSH Product Language OS-Neutral

Replace SSH copy such as:

- "Remote Mac"
- "another Mac"
- "Mac mini"
- "open Iris on the Mac"

with:

- "Remote host"
- "Remote machine"
- "SSH host"
- "machine running Iris Core and Hermes"

README can still include Mac-specific examples where the context is explicitly macOS packaging, but first-run UX and generic Settings SSH copy should stay OS-neutral.

### 4. Revisit Remote Core Auto-Start

`desktop/src-tauri/src/ssh_tunnel.rs` currently calls:

```sh
open -gj -a Iris >/dev/null 2>&1 || true
```

That assumes macOS on the remote host. For generic SSH onboarding:

- Prefer trying the tunnel to an already-running remote Core first.
- If Core is offline, return a clear `core-offline` style status.
- Show OS-neutral instructions in onboarding.
- Make remote auto-start optional or hidden behind a host-type-aware path.

Potential follow-up:

- Add an explicit remote start command field for advanced users.
- Detect macOS only when safe, then offer "Try opening Iris remotely" as an optional action.

### 5. Build First-Run Setup Assistant

Replace or evolve `OnboardingOverlay.tsx` into a guided setup assistant.

Suggested states:

- Choose path: Local Hermes / Hermes via SSH
- Local checklist
- SSH form/checklist
- Success

Use concise status rows:

- Iris Core
- Hermes home
- Hermes gateway
- Iris Hermes adapter
- Adapter env
- Streaming/model readiness, if available

Each failed row should have one primary next action:

- Start Core
- Choose Hermes home
- Install adapter
- I restarted Hermes
- Retry
- Open Settings

### 6. Local Hermes Actions

Reuse existing commands instead of inventing new setup paths:

- `core_sidecar_start`
- `core_sidecar_restart`
- `core_install_hermes_plugin`
- `core_service_install` only if the user explicitly opts into login startup

After plugin install succeeds, onboarding should clearly say Hermes gateway restart is required, then provide a retry button that refreshes runtime status.

### 7. Verification

Lightweight iteration:

- Use the Vite dev surface at `http://localhost:1420/`.
- Test normal UI behavior with Browser.
- Add targeted React/unit tests for extracted SSH draft parsing and connection-manager behavior where practical.

Final visible UI verification:

- Run `npm run build:mac:app`.
- Launch the fresh app bundle.
- Verify with Computer Use against `com.nousresearch.hermes-agent.desktop`.

Because this touches onboarding, Settings, Tauri SSH behavior, and runtime config, packaged desktop verification is required before considering the feature complete.

## Acceptance Criteria

- First-run onboarding offers **Local Hermes** and **Hermes via SSH**.
- The SSH onboarding path reuses the same dialog/hook/logic as Settings.
- No duplicated SSH parsing, profile creation, tunnel start, or disconnect logic remains in onboarding.
- Settings SSH behavior remains intact.
- SSH UX copy is OS-neutral.
- The app no longer presents macOS-specific remote-start assumptions in the generic SSH path.
- Local Hermes onboarding can install/update the Hermes adapter and explain the required Hermes gateway restart.
- Status/probe feedback tells the user which setup step is failing and what to do next.

## Open Questions

- Should onboarding be mandatory until at least one runtime is healthy, or dismissible with a persistent "Finish setup" banner?
- Should remote Core setup support a user-provided start command, or only document that Core must already be running?
- Should streaming-enabled profile checks be part of the first implementation, or a later diagnostic enhancement?
