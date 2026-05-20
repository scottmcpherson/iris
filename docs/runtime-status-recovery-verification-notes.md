# Runtime Status Recovery Verification Notes

Date: 2026-05-20

## Scope

Local verification covered the `default` and `health` Hermes profiles. SSH verification covered the Mac mini `default` profile at `agent@agents-mac-mini`.

## Local Evidence

- `npm run check` passed after the final per-profile adapter-port fix.
- `npm run build:mac:app` passed after the final local packaged-app verification fix.
- Focused desktop tests passed after the final local packaged-app verification fix: `npm --workspace desktop run test -- runtimeReadiness AgentList AgentDetailView AppShell irisCore`.
- Iris Core gateway-control tests passed after the final fix: `iris-core/.venv/bin/python -m pytest iris-core/tests/test_gateway_control.py`.
- `npm run iris:platform:install` writes per-profile adapter ports:
  - root/default: `IRIS_INBOUND_PORT=8766`
  - `health`: `IRIS_INBOUND_PORT=8767`
- After restarting both local gateways:
  - `http://127.0.0.1:8766/health` returned `profile: default`
  - `http://127.0.0.1:8767/health` returned `profile: health`

## Bad States Exercised

- `health` gateway stopped:
  - Stopped with Core/Hermes command path.
  - Core eventually reported `gatewayRunning: false`.
  - Starting the gateway restored `gatewayRunning: true`.
  - A delayed launchd state was observed, so the runtime refresh path now polls briefly after gateway actions.
  - Packaged app Computer Use verification passed after adding foreground status polling:
    - The Agent Profiles view updated from `Running` to `Gateway stopped` after the external stop.
    - Clicking the stopped gateway pill showed `Starting gateway...`.
    - The UI returned to `Running`, Core reported `gatewayRunning: true`, and `127.0.0.1:8767/health` returned `profile: health`.

- `health` adapter unavailable:
  - Removed `iris-platform` from `~/.hermes/profiles/health`.
  - Restarted the `health` gateway.
  - Fresh source Core reported the profile-specific adapter as unavailable on `http://127.0.0.1:8767/health`.
  - Reinstalled the adapter across profile homes.
  - Restarted `health`; source Core then reported `profile: health` healthy on `8767`.

- First-install/reset support:
  - `npm run iris:reset -- --dry-run` confirmed reset removes root and profile adapter installs plus Iris env keys.
  - The install path now restores root and profile adapter files/env values.

## SSH / Mac Mini Evidence

- Mac mini repository path: `/Users/agent/Developer/iris`.
- Mac mini commit: `79af2b2`.
- Mac mini checks passed:
  - `npm run check`
  - `npm run build:mac:app`
- Remote packaged Iris was launched from `/Users/agent/Developer/iris/desktop/src-tauri/target/release/bundle/macos/Iris.app`.
- Remote Core health passed on the Mac mini at `127.0.0.1:8765`.
- Local packaged Iris connected to the saved SSH profile `Iris Mac mini` / `agent@agents-mac-mini`.
- The local app-created SSH tunnel exposed remote Core at `127.0.0.1:52199`.
- Remote adapter health passed on the Mac mini at `127.0.0.1:8766/health` with `profile: default`.

## SSH Bad States Exercised

- Remote `default` gateway stopped:
  - Stopped through the tunneled Core endpoint.
  - The local packaged app updated the SSH Agent Profiles row from `Running` to `Gateway stopped`.
  - Clicking the row pill showed `Starting gateway...`.
  - The UI returned to `Running`, tunneled Core reported `gatewayRunning: true`, and remote `8766/health` returned `profile: default`.

- Remote Core offline:
  - Quit the remote packaged Iris app on the Mac mini.
  - Local packaged Iris showed `Core offline` in the sidebar and top error banner.
  - Runtime diagnostics showed `Reconnect to agent@agents-mac-mini` and the remote Core start hint.
  - A stale row-level `Gateway stopped` label was found and fixed so the Agent row now shows `Core offline` with no gateway action while Core is unreachable.
  - Relaunching the remote packaged Iris app restored diagnostics to `Ready`, and the Agent row returned to `Running`.

## Deferred / Blocked

- Earlier Computer Use attempts timed out before the tool was enabled. After it was enabled, Computer Use attached to `com.nousresearch.hermes-agent.desktop` and local packaged click-through passed.

## Current Local State After Verification

- `default` gateway: running.
- `health` gateway: running.
- `default` adapter: healthy on `127.0.0.1:8766`.
- `health` adapter: healthy on `127.0.0.1:8767`.
- The existing dev Core on `127.0.0.1:8765` should be restarted to pick up source changes.
- Mac mini `default` gateway: running.
- Mac mini `default` adapter: healthy on remote `127.0.0.1:8766`.
