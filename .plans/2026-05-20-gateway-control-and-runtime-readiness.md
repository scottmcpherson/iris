# Gateway Control and Runtime Readiness

## Goal

Make Iris Desktop accurately represent the difference between "Iris Core is reachable" and "the selected Hermes gateway can accept new work", then add first-class controls to start, stop, and restart the selected gateway from Desktop for both local and SSH-connected setups.

End state:

1. The sidebar no longer shows a fully green "Local connected" state when Core is reachable but the selected Hermes gateway is stopped.
2. Historical sessions can still load when only Core is available, but chat input, slash commands, model discovery, and automations clearly show a degraded/read-only runtime state.
3. Users can start, stop, and restart the selected Hermes gateway from Iris Desktop.
4. The same gateway-control path works for local Core and SSH-connected remote Core.
5. Gateway actions refresh runtime probes immediately so the UI updates without requiring an app restart.

## Product Model

Use two separate concepts throughout the app:

- Core connectivity: Iris Desktop can reach Iris Core and read normalized state such as agents, sessions, settings, projects, memory, and skills.
- Runtime readiness: the selected runtime profile has a running Hermes gateway and reachable Iris adapter, so new messages, slash commands, model switching, and streaming can work.

This means Iris can be connected but degraded:

```text
Core connected
Selected gateway stopped
```

That state should be treated as read-only for new runtime work, not as fully online.

## Current Repo State

Relevant Desktop files:

- `desktop/src/layout/AppShell.tsx`
  - `sidebarConnectionStatusLabel()` currently uses only `connected`.
  - This produces labels such as "Local connected" even when the selected gateway is stopped.
- `desktop/src/features/iris/useIrisRuntime.ts`
  - Owns status refresh and selected profile state.
  - Calls `getIrisStatus()` and stores `HermesStatus`.
- `desktop/src/lib/irisCore.ts`
  - `getIrisCoreStatus()` already maps Core runtime probe data into `gatewayStatus`, `activeApiStatus`, and `runtimeStatus`.
  - `coreAgentToHermesProfile()` already maps `metadata.gatewayRunning`.
- `desktop/src/features/chat/ChatView.tsx`
  - Composer behavior currently keys mostly off `connected`.
  - Slash command menu receives `slashCommandsError`, but the error row is generic.
- `desktop/src/features/chat/useIrisSlashCommands.ts`
  - Loads slash commands only when Core is connected.
  - Does not distinguish gateway stopped from generic load failure.
- `desktop/src/features/settings/SettingsView.tsx`
  - Existing service management controls operate on Iris Core and plugin install.
  - This is a natural place to add Hermes gateway start/stop/restart actions.
- `desktop/src-tauri/src/ssh_tunnel.rs`
  - Owns SSH transport to remote Core.
  - Should not become the gateway-control protocol.

Relevant Core files:

- `iris-core/src/hermes_management_server/main.py`
  - Exposes `/v1/runtimes/{runtime_id}/probe`.
  - Exposes `/v1/agents/{agent_id}/models`, `/slash-commands`, and send-message routes.
- `iris-core/src/hermes_management_server/runtime_registry.py`
  - Resolves runtimes and adapters.
  - `probe()` stores the latest runtime probe.
- `iris-core/src/hermes_management_server/runtime_adapters/base.py`
  - Runtime adapter protocol should gain gateway control methods.
- `iris-core/src/hermes_management_server/runtime_adapters/hermes.py`
  - Already knows `runtimeProfile`, `gatewayUrl`, and `irisGatewayUrls`.
  - Should wrap `hermes --profile <profile> gateway <action>`.
- `iris-core/src/hermes_management_server/runtime_adapters/hermes_store.py`
  - Contains `validate_profile_name()`.
  - Contains gateway-running detection from Hermes profile state.

Hermes CLI supports:

```bash
hermes --profile default gateway status
hermes --profile default gateway start
hermes --profile default gateway stop
hermes --profile default gateway restart
```

## Architecture Decision

Gateway control should be owned by Iris Core, not by Desktop shelling directly into Hermes.

Desktop already talks to local and SSH-connected remote Core through the same HTTP/Core transport. If Core owns gateway control, then:

- Local Desktop -> local Core -> local Hermes CLI.
- SSH Desktop -> SSH tunnel -> remote Core -> remote Hermes CLI.
- Tailscale/manual Desktop -> remote Core -> remote Hermes CLI, subject to auth.

Desktop should not run remote SSH commands for gateway control. That would duplicate credentials, host assumptions, error mapping, and command construction outside Core.

The unavoidable limitation: if remote Iris Core itself is offline, Desktop cannot use Core to start the remote gateway. In that state, the UI should say that remote Core must be started first.

## Core API Additions

Add agent-scoped gateway routes:

```text
GET  /v1/agents/{agent_id}/gateway/status
POST /v1/agents/{agent_id}/gateway/start
POST /v1/agents/{agent_id}/gateway/stop
POST /v1/agents/{agent_id}/gateway/restart
```

Agent-scoped routes are preferable to runtime-scoped routes because users operate on agents/profiles in Desktop, and Core already resolves:

```text
agent_id -> runtimeId -> runtimeProfile -> adapter
```

Response shape:

```json
{
  "ok": true,
  "agentId": "agent_...",
  "runtimeId": "runtime_local_hermes",
  "profile": "default",
  "action": "start",
  "command": {
    "ok": true,
    "stdout": "...",
    "stderr": "",
    "status": 0
  },
  "probe": {
    "gateway": { "ok": true, "url": "http://127.0.0.1:8642" },
    "irisAdapter": { "ok": true, "url": "http://127.0.0.1:8766/health", "profile": "default" },
    "management": { "ok": true, "url": "http://127.0.0.1:8765/health" }
  }
}
```

For failures, return `ok: false` with `error`, `command`, and best-effort `probe` when possible.

## Core Implementation Steps

1. Extend the runtime adapter protocol.

   File: `iris-core/src/hermes_management_server/runtime_adapters/base.py`

   Add:

   ```python
   def gateway_status(self, profile: str) -> dict[str, Any]: ...
   def gateway_control(self, profile: str, action: str) -> dict[str, Any]: ...
   ```

2. Implement Hermes gateway command execution.

   File: `iris-core/src/hermes_management_server/runtime_adapters/hermes.py`

   Behavior:

   - Validate `profile` with existing `validate_profile_name()`.
   - Allowlist actions: `status`, `start`, `stop`, `restart`.
   - Resolve the Hermes executable.
     - Prefer `shutil.which("hermes")`.
     - Consider fallback to `<hermes_home>/hermes-agent/venv/bin/hermes` or Python module invocation if PATH is missing in a launchd/service environment.
   - Run with `subprocess.run([...], shell=False, capture_output=True, text=True, timeout=...)`.
   - Set `HERMES_HOME` in `env` when Core has `hermes_home`.
   - Use `--profile <profile>` for all non-default profiles. Using it for default is also acceptable and simpler.
   - Return `stdout`, `stderr`, `status`, `ok`, and concise `error`.

   Example command construction:

   ```python
   [hermes, "--profile", profile, "gateway", action]
   ```

   Do not pass user-provided flags such as `--system` or `--all` in the first implementation.

3. Add registry methods.

   File: `iris-core/src/hermes_management_server/runtime_registry.py`

   Add small pass-throughs:

   ```python
   def gateway_status(self, runtime_id: str, profile: str) -> dict[str, Any]
   def gateway_control(self, runtime_id: str, profile: str, action: str) -> dict[str, Any]
   ```

   After control actions, run `probe(runtime_id, profile=profile)` and include the result.

4. Add Core routes.

   File: `iris-core/src/hermes_management_server/main.py`

   Add routes near the existing agent model/slash routes:

   - Resolve agent.
   - Resolve adapter through runtime registry.
   - Call status/control with `agent["runtimeProfile"]`.
   - Use `run_runtime_call()` with a slightly longer timeout for start/restart, for example 20-30 seconds.

5. Add Core tests.

   Suggested tests:

   - Gateway control rejects unknown action.
   - Command construction uses an argv list and includes `--profile`.
   - Profile validation rejects unsafe names.
   - Route resolves agent profile and returns fresh probe.
   - CLI missing returns actionable error.
   - Timeout returns clear failure.

## Desktop API Additions

File: `desktop/src/lib/irisCore.ts`

Add types:

```ts
export type IrisCoreGatewayAction = "start" | "stop" | "restart";

export type IrisCoreGatewayCommandResult = {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  status?: number | null;
  error?: string;
};

export type IrisCoreGatewayControlResult = {
  ok: boolean;
  agentId: string;
  runtimeId: string;
  profile: string;
  action: IrisCoreGatewayAction | "status";
  command?: IrisCoreGatewayCommandResult;
  probe?: CoreRuntimeProbe;
  error?: string;
};
```

Add functions:

```ts
export function getIrisCoreGatewayStatus(agentId: string, runtime?: HermesRuntimeConfig)
export function controlIrisCoreGateway(agentId: string, action: IrisCoreGatewayAction, runtime?: HermesRuntimeConfig)
```

These should call the new Core routes through `coreRequest()`, so the existing browser fetch/bridge fallback and SSH tunnel URL behavior remain intact.

## Runtime Readiness Helpers

Add a small helper near status mapping, or in a new app/runtime helper:

```ts
type RuntimeReadiness = "offline" | "core-only" | "gateway-stopped" | "adapter-unavailable" | "ready";
```

Derive it from:

- `status.connected`
- selected `HermesProfile.gatewayRunning`
- `status.gatewayStatus?.ok`
- `status.activeApiStatus?.ok`

Recommended first-pass rules:

```text
!status.connected -> offline
!selectedProfile.gatewayRunning && !status.gatewayStatus?.ok -> gateway-stopped
selectedProfile.gatewayRunning && !status.activeApiStatus?.ok -> adapter-unavailable
status.activeApiStatus?.ok -> ready
otherwise -> core-only
```

Use the selected profile, not only `status.activeProfile`, because the user can choose a non-default profile.

## Desktop UI Changes

1. Sidebar connection label.

   File: `desktop/src/layout/AppShell.tsx`

   Replace the single green "connected" idea with a status that can show:

   - `Core offline`
   - `Core connected`
   - `default gateway stopped`
   - `default adapter unavailable`
   - `default ready`

   Use amber/degraded styling when Core is connected but runtime readiness is not `ready`.

2. Profile menu rows.

   File: `desktop/src/features/chat/components/ProfileMenu.tsx`

   Add per-profile runtime hints:

   - `default · gateway stopped`
   - `health · running`

   Since `HermesProfile.gatewayRunning` already exists, this can be shown without new backend data.

3. Chat composer degraded state.

   File: `desktop/src/features/chat/ChatView.tsx`

   When runtime readiness is not `ready`, preserve history loading but make sending explicit:

   - Disable send, or allow click to open the gateway action.
   - Show concise text inside/above composer:
     - `default gateway is stopped. Start it to send messages.`
     - `Iris adapter is unreachable. Restart the gateway.`
   - Primary action: `Start gateway` or `Restart gateway`.

4. Slash command unavailable row.

   File: `desktop/src/features/chat/components/SlashCommandMenu.tsx`

   Replace generic copy when the runtime state is known:

   - `Commands unavailable`
   - `default gateway is stopped`
   - Action should trigger gateway start or restart, not only retry command loading.

5. Settings service management.

   File: `desktop/src/features/settings/SettingsView.tsx`

   Add menu items:

   - `Start Hermes gateway`
   - `Stop Hermes gateway`
   - `Restart Hermes gateway`

   These should operate on the selected agent/profile or the active profile shown in settings.

6. Refresh behavior.

   After gateway action success or failure:

   - Refresh Core status.
   - Refresh slash commands.
   - Refresh model catalog.
   - Show toast with command result.

## UX Copy

Suggested labels:

- Sidebar ready: `default ready`
- Sidebar degraded: `default gateway stopped`
- Tooltip/detail: `Core is connected, but this agent cannot accept new messages until its Hermes gateway is running.`
- Composer banner: `default gateway is stopped. Start it to send messages.`
- Adapter problem: `Gateway is running, but the Iris adapter is unreachable. Restart the gateway.`
- Remote Core offline: `Remote Core is offline. Start Iris Core on that host, then retry.`

Avoid saying "disconnected" when Core is reachable. Use "read-only" or "gateway stopped" instead.

## SSH Behavior

For SSH connections, Desktop should:

1. Ensure the SSH tunnel to remote Core is active using existing `ensureActiveSshTunnel()`.
2. Call the same Core gateway route through `coreRequest()`.
3. Let remote Core run the Hermes CLI on the remote host.

Do not add a Desktop-side SSH command runner for gateway control.

Failure modes:

- SSH tunnel unavailable: show existing SSH tunnel error.
- Remote Core offline: ask the user to start remote Iris Core first.
- Remote Core reachable but Hermes CLI missing: Core returns a gateway-control error.
- Gateway starts but adapter stays unreachable: show restart/plugin-install guidance.

## Security and Safety

- Never construct gateway commands through shell strings.
- Allowlist gateway actions.
- Validate profile names using the existing Core profile validator.
- Do not expose arbitrary command arguments in the API.
- Do not run `--all` by default because it can affect other profiles.
- Do not run Linux `--system` by default because it can require sudo and is outside normal user-service control.
- Preserve Core auth requirements for remote/manual/Tailscale control.

## Test Plan

Core tests:

```bash
pytest iris-core/tests
```

Targeted Desktop tests:

```bash
npm test -- --run desktop/src/layout/__tests__/AppShell.test.ts
npm test -- --run desktop/src/features/chat/__tests__/ChatView.test.ts
npm test -- --run desktop/src/lib/__tests__/irisCore.test.ts
```

Manual local checks:

1. Stop the default gateway:
   ```bash
   hermes --profile default gateway stop
   ```
2. Open Iris Desktop on `default`.
3. Confirm sidebar shows degraded gateway state, not fully connected.
4. Confirm historical sessions still load.
5. Confirm composer shows gateway stopped and offers start.
6. Start gateway from Iris Desktop.
7. Confirm slash commands and send become available after refresh.

Manual SSH checks:

1. Connect to a remote Core through Settings SSH mode.
2. Stop the remote selected profile gateway on the remote host.
3. Confirm Desktop shows Core connected but runtime degraded.
4. Start/restart the gateway from Desktop.
5. Confirm the remote gateway and adapter probe become healthy.

Visible UI verification:

- Use Vite/browser checks for normal iteration at `http://localhost:1420/`.
- For final visible behavior verification, build with `npm run build:mac:app`, launch the new app bundle, and test with Computer Use against `com.nousresearch.hermes-agent.desktop`.

## Implementation Order

1. Add Core adapter methods and command wrapper.
2. Add Core routes and tests.
3. Add Desktop API wrappers.
4. Add runtime readiness helper and tests.
5. Update sidebar/profile/composer/slash/settings UI.
6. Wire gateway actions to status/model/slash refresh.
7. Run targeted tests and browser verification.
8. Run packaged desktop verification for final UI behavior.

## Open Questions

1. Should `stop` be available directly in the main chat/profile menu, or only in Settings?
2. Should `restart` be the recommended action when adapter health fails but gateway health is true?
3. Should Core try a fallback Hermes executable path when `shutil.which("hermes")` fails under launchd?
4. Should gateway status parse structured Hermes state later, or is command output plus Core probe enough for the first release?
5. Should gateway control be shown for manual URL/Tailscale connections only when the paired device token has sufficient privileges?
