# Runtime Status and Recovery Test Plan

This plan verifies the gateway, Iris adapter, Iris Core connection, and related runtime-readiness UI after the gateway/adapter/connection-management work.

## UX Contract

- Every visible runtime problem should identify the failing layer: Iris Core offline, Hermes gateway stopped, or Iris adapter unavailable.
- Recovery actions should be available where the user naturally encounters the problem: sidebar diagnostics, agent list, agent overview, chat composer, slash command menu, automations, and settings.
- Clicking a recovery action should show immediate busy feedback on that initiating control, refresh runtime status when the command completes, and update every other visible status surface without requiring navigation.
- The selected agent/profile matters. Starting `health` must refresh and update `health`, not silently switch the user to `default` or leave `health` stale.
- No send, model, slash-command, or automation creation flow should look available when the selected runtime is not ready.
- Installer actions should distinguish "adapter files installed" from "gateway restarted and adapter reachable."
- Reset/first-install flows should guide the user to install the adapter and restart/start the gateway without adding extra UI unless an existing surface is missing the needed action.

## Status Surfaces

| Surface | Location | Expected ready state | Expected gateway-stopped state | Expected adapter-unavailable state | Recovery controls |
| --- | --- | --- | --- | --- | --- |
| Sidebar brand status | Left sidebar brand block | `Local/SSH · <profile>` with connected dot | `Local/SSH · <profile> gateway stopped` with degraded dot | `Local/SSH · <profile> adapter unavailable` with degraded dot | Opens Runtime diagnostics |
| Runtime diagnostics | Sidebar brand click | Iris Core, Hermes gateway, Iris adapter rows ready | Gateway row degraded with `Start gateway` | Adapter row degraded with `Install adapter`; gateway row ready | Start Core, reconnect SSH, start gateway, install adapter, refresh |
| Agent list | Agents view | Each profile pill says `Running` | Stopped profile pill says `Gateway stopped` and is clickable | Selected profile pill says `Adapter unavailable` and is clickable restart | Pill action, row menu start/stop/restart/install |
| Agent overview | Agents > profile | No degraded banner | Banner says gateway stopped and offers `Start gateway` | Banner says adapter unavailable and offers `Restart gateway` plus `Install adapter` | Banner buttons, refresh |
| Settings | Settings view | Core status healthy; connection settings available | Connection remains visible; diagnostics reachable from sidebar | Connection remains visible; diagnostics reachable from sidebar | Core service controls, SSH connect/disconnect, logs |
| Chat composer | Chat view | Composer accepts send; model selector enabled when catalog exists | Banner above composer says gateway stopped; send/model disabled; `Start gateway` visible | Banner says adapter unreachable; send/model disabled; `Restart gateway` visible | Composer banner button |
| Slash commands | Chat composer `/` menu | Commands listed | `Commands unavailable` row says gateway stopped and starts gateway | `Commands unavailable` row says adapter unreachable and restarts gateway | Slash unavailable row |
| Automations | Automations view | Create button enabled; jobs load | Degraded alert; create disabled; `Start gateway` visible | Degraded alert; create disabled; `Restart gateway` visible | Alert button |
| Profile menu | Chat agent picker | Each profile sublabel says gateway running/stopped | Stopped profiles clearly labeled | Selected bad adapter state handled by composer banner | Profile picker only labels; recovery lives in composer/diagnostics |
| Onboarding | First run / reset | Setup can be dismissed after healthy status | Should direct user to refresh/start gateway if applicable | Should direct user to install adapter/restart gateway if applicable | Existing onboarding actions and diagnostics/settings |

## Setup

Assumptions:

- The normal Vite dev surface is `http://localhost:1420/`.
- The user may already have `npm run dev` running.
- Prefer Browser/Vite checks while iterating. Use a packaged app only for final desktop verification.
- Use `npm run build:mac:app` for a fresh packaged app before Computer Use verification.

Useful commands:

```bash
npm --workspace desktop run test -- runtimeReadiness AgentList AgentDetailView AppShell
npm run core:test
npm run check
npm run build:mac:app
```

Useful runtime commands:

```bash
hermes --profile health gateway status
hermes --profile health gateway stop
hermes --profile health gateway start
hermes --profile health gateway restart
npm run iris:platform:install
npm run iris:reset -- --dry-run
npm run iris:reset
```

If the `health` profile does not exist, create it from Iris or Hermes before running profile-specific cases. Record the profile used in the notes.

For local multi-profile adapter checks, expect the default profile Iris adapter on `127.0.0.1:8766` and sorted profile homes on subsequent ports. With only a `health` profile, `health` should use `127.0.0.1:8767`.

## Baseline Healthy Case

1. Open the Vite dev surface at `http://localhost:1420/`.
2. Refresh Iris from the app.
3. Verify the sidebar shows the active connection and selected profile without a degraded label.
4. Open Runtime diagnostics from the sidebar brand status.
5. Verify Iris Core, Hermes gateway, and Iris adapter rows are healthy.
6. Open Chat, Agents, Agent overview, Settings, and Automations.
7. Verify no degraded runtime banner appears, Chat send is enabled when text exists, and Automations create is enabled.
8. Type `/` in a new chat and verify slash commands load.

Pass criteria: all surfaces agree the runtime is ready for the same selected profile.

## Gateway Stopped: Selected Profile

Bad-state setup:

```bash
hermes --profile health gateway stop
```

Steps:

1. Select `health` in Iris.
2. Refresh Iris.
3. Verify the sidebar label changes to `health gateway stopped`.
4. Open the Agent list.
5. Verify `health` has a `Gateway stopped` pill with an obvious start affordance.
6. Click the Agent list pill.
7. While the command runs, verify the initiating control is disabled or otherwise visibly busy enough to prevent duplicate starts.
8. After completion, verify the Agent list pill changes to `Running`.
9. Without navigating away, verify the sidebar label returns to ready.
10. Open Agent overview for `health`.
11. Stop the gateway again.
12. Refresh Iris.
13. Verify the overview banner says the `health` gateway is stopped and offers `Start gateway`.
14. Click `Start gateway`; verify the banner clears after completion.
15. Stop the gateway again.
16. Open Chat with `health` selected.
17. Verify the composer banner says the gateway is stopped, send/model controls are disabled, and `Start gateway` is visible.
18. Click `Start gateway`; verify the banner clears, send/model controls update, and slash commands refresh.
19. Stop the gateway again.
20. Open Automations.
21. Verify the degraded alert appears, creation is disabled, and `Start gateway` is visible.
22. Click `Start gateway`; verify the alert clears and creation becomes enabled.
23. Stop the gateway again.
24. Open Runtime diagnostics.
25. Verify the Gateway row is degraded and `Start gateway` works.

Pass criteria: all entry points start the selected profile gateway, show in-progress feedback, refresh status, and unblock dependent UI.

## Gateway Stopped: Non-Selected Profile

Bad-state setup:

```bash
hermes --profile health gateway stop
```

Steps:

1. Select a different profile, such as `default`.
2. Open Agent list.
3. Verify `health` still shows `Gateway stopped`, while the selected healthy profile shows ready.
4. Click `health` row pill or row menu `Start gateway`.
5. Verify `health` updates to `Running`.
6. Verify the app does not unexpectedly switch selected profile unless the clicked action was explicitly "open agent."
7. Open the Chat agent picker.
8. Verify `health` sublabel updates to `Gateway running`.

Pass criteria: per-profile gateway control updates the target profile without corrupting selected-profile readiness.

## Adapter Unavailable: Gateway Running But Iris Adapter Missing or Stale

Bad-state setup options:

- Disable or remove the `iris-platform` Hermes plugin for the test profile, then restart that profile gateway.
- Run `npm run iris:reset` and restart Hermes to simulate first install.
- If plugin files are present but not loaded, use `hermes --profile health gateway restart` before refreshing Iris.

Steps:

1. Ensure `hermes --profile health gateway status` reports a running gateway.
2. Refresh Iris with `health` selected.
3. Verify the sidebar says `health adapter unavailable`.
4. Open Runtime diagnostics.
5. Verify Iris Core and Hermes gateway rows are ready, Iris adapter row is degraded, and `Install adapter` is visible.
6. Click `Install adapter`.
7. If the gateway is running, verify the UI communicates that install includes or requires a restart.
8. After the action completes, verify the gateway is restarted or the UI still clearly tells the user to restart it.
9. Verify the adapter row becomes ready after restart.
10. Repeat the same state in Agent overview.
11. Verify the overview banner offers `Restart gateway` and `Install adapter`.
12. Click `Restart gateway`; if the adapter is installed but stale, verify readiness returns to ready.
13. Open Chat.
14. Verify the composer banner says the adapter is unreachable, send/model controls are disabled, and `Restart gateway` is visible.
15. Click `Restart gateway`; verify the banner clears and controls update.
16. Type `/` while the adapter is unavailable.
17. Verify the slash menu unavailable row says the adapter is unreachable and selecting it restarts the gateway.
18. Open Automations.
19. Verify the alert says runtime is not ready and offers `Restart gateway`.

Pass criteria: adapter-unavailable is never mislabeled as gateway stopped, and install/restart paths make the next required action obvious.

Local command-level check:

1. Remove the selected profile adapter, for example `HERMES_HOME=~/.hermes/profiles/health hermes plugins remove iris-platform`.
2. Restart that profile gateway.
3. Verify Core reports the selected profile adapter as unavailable and probes the profile-specific port, for example `http://127.0.0.1:8767/health` for `health`.
4. Install the adapter through Iris or `npm run iris:platform:install`.
5. Restart the selected profile gateway.
6. Verify Core reports the adapter as ready for the requested profile, not just any running adapter.

## Iris Core Offline: Managed Local

Bad-state setup:

- Stop Iris Core sidecar or run the app with an inactive Core port in Settings.

Steps:

1. Refresh Iris.
2. Verify the sidebar says `Core offline`.
3. Open Runtime diagnostics.
4. Verify the Iris Core row is degraded and offers `Start Iris Core`.
5. Click `Start Iris Core`.
6. Verify the button shows `Starting Core...` while running.
7. Verify status refreshes to connected once Core is healthy.
8. Open Settings.
9. Verify local connection settings remain editable and Core logs are available.
10. Return to Chat and verify the composer recovers after Core and runtime readiness return.

Pass criteria: Core offline is separated from gateway/adapter failures and recovers through diagnostics/settings.

## SSH Remote Offline or Disconnected

Status: deferred until the Mac mini has an updated Iris install. Do not use this section for the current local verification pass.

Bad-state setup:

- Select an SSH connection and stop remote Iris Core, or disconnect the SSH tunnel.

Steps:

1. Refresh Iris.
2. Verify the sidebar says Core offline for the SSH connection.
3. Open Runtime diagnostics.
4. Verify the action is `Reconnect SSH` or `Reconnect to <target>`.
5. Verify the remote command hint appears if reconnect fails.
6. Reconnect.
7. Verify status refreshes and runtime-specific gateway/adapter state is checked afterward.

Pass criteria: remote transport failure is not presented as a Hermes gateway problem.

## First-Install / Full Reset Flow

Bad-state setup:

```bash
npm run iris:reset
```

Then restart Hermes/Core as instructed by the script output.

Steps:

1. Open Iris fresh.
2. Verify onboarding/settings/diagnostics make the missing adapter state understandable.
3. Use the visible install action to install the adapter.
4. Restart/start the affected gateway if not done automatically.
5. Refresh Iris.
6. Verify Chat, Agents, Agent overview, Automations, and diagnostics converge on ready.
7. Send a simple message in Chat.
8. Verify the response streams back through the adapter.

Pass criteria: a clean environment can recover without manual file editing and without hidden commands beyond the documented reset/setup commands.

## Action Feedback Checks

Run these checks for each initiating surface: Agent list pill, Agent row menu, Agent overview banner, Chat composer banner, Slash menu row, Automations alert, Runtime diagnostics.

1. Click the action once.
2. Verify duplicate clicks are prevented while the command is running.
3. Verify the visible label changes where space allows, such as `Starting gateway...`, `Restarting...`, or `Installing...`.
4. Verify a success or failure toast appears.
5. Verify the current view updates after completion.
6. Verify another already-open surface, such as the sidebar, also updates.

Pass criteria: users can tell that Iris accepted the click and can tell whether recovery worked.

## Regression Checks

- Gateway start/stop/restart should use argv arrays, never shell interpolation.
- Unsafe profile names must be rejected.
- A profile-specific adapter health probe must reject a health response for another profile.
- Version mismatch should remain a Core connection error and not become a runtime-readiness problem.
- Chat send must remain blocked while readiness is not `ready`.
- Automations create must remain blocked while readiness is not `ready`.
- Model selection must remain blocked while readiness is not `ready`.

## Final Packaged Desktop Verification

1. Run:

```bash
npm run build:mac:app
```

2. Launch the newly built app bundle.
3. Use Computer Use against `com.nousresearch.hermes-agent.desktop`.
4. Repeat the Baseline Healthy, Gateway Stopped selected profile, Adapter Unavailable, and First-Install / Full Reset flows.
5. Do not run multiple packaged desktop sessions in parallel against the same bundle identifier.

Pass criteria: packaged behavior matches Vite behavior, and the app bundle does not attach to a stale dev binary.

## Notes Template

Use this template while executing the plan:

```text
Date:
Build or dev surface:
Profiles tested:
Core connection:
Hermes version:
Iris Core version:

Case:
Setup command:
Observed surfaces:
Expected:
Actual:
Pass/fail:
Follow-up:
```
