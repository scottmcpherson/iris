# Iris Desktop Project Status

Last updated: May 7, 2026

## Current Architecture

Iris Desktop is the Tauri 2, React 18, TypeScript, and Tailwind client for Iris. The desktop-facing control plane is Iris Core at `http://127.0.0.1:8765/v1`.

The Tauri Python bridge is Core-only: it supports Core request fallback, Core upload-by-path for local attachments, and Core credential storage. It does not inspect or mutate runtime-owned files.

Hermes remains the first runtime backend through the Iris Hermes Adapter. Hermes-specific filesystem reads, conversation discovery, Jobs API calls, model and slash-command discovery, and inbound message delivery are contained in the Core Hermes runtime adapter plus the Hermes-side `agentui-platform` plugin.

## Implemented

- Desktop shell with sidebar navigation, chat workspace, settings/profile views, memory view, skills view, automations view, agents view, and live preview pane.
- Core-backed chat creation, message send, event streaming, cancellation, conversation list, and conversation detail.
- Core-backed agent/profile list plus create, clone, rename, activate, and delete workflows.
- Core-backed memory load, save, and reset for `MEMORY.md` and `USER.md`.
- Core-backed skills list/detail plus create and save workflows.
- Core-backed model catalog and slash-command discovery.
- Core-backed automations list, create, pause, resume, run, delete, and delivery rendering.
- Settings edits only the Iris Core URL and Core bearer token. Runtime route details belong to Core runtime configuration.
- Preview workspace with HTML, React, Markdown, Mermaid, artifact management, export, and save-as-skill draft support.

## Verification

- `npm --workspace desktop run check`
- `npm run sidecar:test`
- Fresh app-bundle verification should use root `npm run build:mac:app`, then launch the built bundle and test with Computer Use against `com.nousresearch.hermes-agent.desktop`.

## Known Constraints

- Hermes runtime availability still depends on the local Hermes gateway and Iris Hermes Adapter being installed and configured.
- The app bundle build path is the reliable packaging check; full installer bundle work is separate.
- The preview runtime keeps the frontend bundle large and should be code-split later.
