# Iris and Hermes Apps

## Concept

Introduce an app layer in Iris and Hermes. Apps can be predefined or created from a prompt.

Example prompt:

> Create an app to integrate with Whoop so I can see my sleep and recovery every morning.

Iris would send the app-creation request to Hermes with an Iris-specific slash command or runtime instruction. Hermes would generate an app proposal that Iris can install, render, and run through automations.

## Recommended Shape

Use a constrained app manifest rather than letting Hermes generate arbitrary React components and SQL directly into the running desktop app.

Hermes can generate and operate apps, but Iris should own the install contract, rendering contract, storage boundaries, permissions, and recovery path.

## App Manifest

Each app should define:

- `appId`
- name and description
- required permissions
- required credentials or OAuth setup
- storage model
- actions
- views
- automation hooks
- version
- migration metadata

Predefined apps can ship bundled with Iris. Prompt-created apps can be installed through a review and approval flow.

## Iris Core Responsibilities

Iris Core should own:

- app registry
- app versions
- app install/update/remove lifecycle
- app storage
- migration state
- credential references
- app action execution boundaries
- app-to-session and app-to-automation links

Potential Core tables:

- `apps`
- `app_versions`
- `app_migrations`
- `app_data`
- `app_credentials`
- `app_automations`

For an MVP, app data can start as structured JSON storage before custom SQL migrations are allowed.

## Hermes Responsibilities

Hermes can own:

- interpreting prompt-created app requests
- generating app manifests
- proposing app actions and views
- calling external APIs through approved tool paths
- generating app-specific summaries
- running scheduled prompts or jobs
- sending app view payloads back to Iris

Potential slash command:

```text
/iris-app create <prompt>
```

The command should return an install proposal, not immediately mutate Iris storage or UI code.

## UI Rendering

Start with schema-driven UI blocks instead of generated TSX.

Supported view blocks could include:

- metric card
- chart
- table
- timeline
- status panel
- action button
- alert
- markdown summary

Hermes could deliver an app view payload through existing runtime delivery metadata:

```json
{
  "kind": "iris-app-view",
  "appId": "whoop",
  "view": "daily-recovery",
  "props": {
    "sleepScore": 82,
    "recovery": 67,
    "hrv": 54
  }
}
```

Iris Desktop would render this as a rich chat card or an app panel.

## Whoop Example

The Whoop app would need:

- OAuth or API credential setup
- token storage and refresh
- actions for sleep, recovery, strain, and profile data
- a morning automation
- a daily recovery view
- a chat response path for prompts like "show me my Whoop data for the day"

## MVP

1. Add an `IrisAppManifest` type.
2. Add app registry and storage endpoints in Iris Core.
3. Add an `iris-app-view` renderer in Iris Desktop chat.
4. Add one predefined app manually.
5. Add a Hermes `/iris-app create` command that generates app manifests for review.
6. Let generated apps use JSON app storage first.
7. Add approval, rollback, and disable flows before custom migrations or generated code.

## Risks

- arbitrary generated UI can break the desktop app
- arbitrary generated SQL can corrupt or lock Core storage
- external app credentials need strict isolation
- generated integrations need a recoverable install/update path
- Tauri/CSP/runtime constraints make hot-loading arbitrary UI code difficult
- app data permissions need to be visible and enforceable

## Open Questions

- Should apps be attached to agents, projects, or global Iris state?
- Should app views render only in chat, or also have dedicated app pages?
- Should predefined apps be implemented as app manifests, Hermes skills, Hermes plugins, or a combination?
- What is the right approval UX for generated apps?
- How much migration capability should generated apps get beyond JSON storage?
- Should automations be app-owned, or should apps only register suggested automation templates?
