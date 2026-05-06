# Iris Brand Rename Plan

## Goal

Rename the product from AgentUI / Hermes Agent UI language to Iris while keeping
the architecture clear.

Iris should read as the product name. Hermes should read as one runtime adapter
under Iris, not the product center of gravity.

## Clean Naming Stack

- **Iris**: the product and user-facing app family.
- **Iris Desktop**: the native Tauri/macOS desktop client.
- **Iris Core**: the local-first control plane service.
- **Iris Hermes Adapter**: the Hermes-specific runtime integration.
- **Iris Runtime Adapter**: the generic adapter interface for Hermes and future
  runtimes.
- **Iris Device Token**: a per-client token used to authenticate desktop,
  mobile, CLI, or web clients to Iris Core.
- **Iris Host**: the machine running Iris Core plus local runtime backends such
  as Hermes.
- **Iris Client**: any UI or programmatic client that talks to Iris Core.

## Service Naming

The service currently called AgentUI Core should become **Iris Core**.

Use Iris Core for the stable service/API identity because it owns product state
and behavior:

- Conversations.
- Messages.
- Live events and replay cursors.
- Automations.
- Devices and device auth.
- Runtime routing.
- Adapter boundaries.
- Future memory, artifacts, permissions, and audit surfaces.

Avoid calling this service **Iris Proxy**, **Iris Sidecar**, or **Iris Gateway**.
Those names are too narrow or conflict with Hermes gateway terminology.

Suggested description:

```text
Iris Core is the local-first control plane for Iris. It owns Iris
conversations, messages, automations, devices, auth, and runtime routing, and
connects to Hermes through the Iris Hermes Adapter.
```

## Product Relationship To Hermes

Hermes remains a runtime backend and capability provider.

Iris should not expose Hermes as the top-level product model. The UI and API
should prefer Iris-owned terms:

- Iris agents, not Hermes profiles, where possible in user-facing UI.
- Iris conversations, not Hermes sessions.
- Iris automations, not Hermes jobs.
- Iris devices, not generic API tokens.
- Iris Core, not Hermes management sidecar.

Hermes-specific terms can remain in adapter internals, migration code, and
debugging surfaces where they are technically accurate.

## Likely Rename Surfaces

When implementation begins, audit and update these areas:

- Root docs: `README.md`, `features/*.md`, and architecture notes.
- Sidecar docs: `sidecar/README.md`.
- Desktop docs: `desktop/README.md` if present.
- App metadata: Tauri product name, window title, bundle display name, and app
  identifiers if we choose to change them.
- UI copy: sidebar title, settings headings, connection labels, empty states,
  onboarding copy, and route names.
- API docs and generated OpenAPI title/version text.
- TypeScript client names that expose product concepts.
- Python/FastAPI package naming, CLI entrypoint naming, and service logs.
- SQLite paths and environment variables, if we choose to migrate storage names.
- Token terminology in settings and docs.

## Compatibility Guidance

Do not break existing users or local state during the rename.

Prefer additive compatibility first:

- Keep existing environment variables working initially.
- Keep existing SQLite paths readable.
- Keep existing command names or add aliases while introducing Iris names.
- Keep legacy API route behavior unless there is a planned migration.
- Make docs clear when an old AgentUI name is still accepted for compatibility.

Potential future migration examples:

- `AGENTUI_TOKEN` can remain accepted while introducing an Iris-named alias.
- `~/.agent-ui/core.sqlite3` can remain readable while a future Iris path is
  added deliberately.
- `hermes-sidecar` can remain a compatibility command while a future
  `iris-core` command is introduced.

## Open Decisions

- Whether to rename the repository folder/package now or only product-facing
  copy first.
- Whether to change the macOS bundle identifier or preserve it for continuity.
- Whether the service CLI should become `iris-core`, `iris`, or stay aliased to
  the existing sidecar command.
- Whether Core storage should move from `~/.agent-ui` to an Iris path.
- Whether environment variables should be renamed now or introduced as aliases.

## Suggested First Implementation Pass

1. [x] Rename user-facing docs and UI copy to Iris.
2. [x] Rename AgentUI Core references in docs to Iris Core.
3. [x] Keep code-level identifiers stable unless they directly surface in UI or API
   docs.
4. [x] Add compatibility language for old AgentUI names.
5. [x] Run the normal desktop and sidecar checks.
6. [x] For visible UI changes, build the fresh macOS bundle and verify with
   Computer Use against the packaged app.

## Implementation Notes

- Iris is now the app/product name in the primary docs, desktop UI, Tauri
  product metadata, FastAPI title, service defaults, and adapter-facing copy.
- `iris-core` and `npm run iris:hermes:install` were added while preserving
  `hermes-sidecar`, `hermes-management-server`, and
  `npm run hermes:agentui:install` as compatibility entrypoints.
- `IRIS_*` environment aliases were introduced for Core, inbox, and adapter
  configuration. Existing `AGENTUI_*` and `HERMES_MGMT_*` names remain accepted
  for local state and plugin compatibility.
- The macOS bundle identifier remains `com.nousresearch.hermes-agent.desktop`
  for continuity and to keep Computer Use verification attached to the expected
  packaged app.
