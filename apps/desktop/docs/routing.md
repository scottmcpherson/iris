# Iris Routing and Link Contract

Iris uses the same durable route schema for web, desktop, and future mobile shells:

- `/chat/new`
- `/chat/:sessionId`
- `/projects/:projectId/chat/new`
- `/projects/:projectId/chat/:sessionId`
- `/agents`
- `/agents/:profile`
- `/agents/:profile/:section`
- `/automations`
- `/settings`

Chat routes may include `?profile=<runtimeProfile>`. Automations may include `?project=<projectId>`.

Desktop uses hash history in Tauri so packaged static assets can refresh safely without requiring a file-system fallback. External desktop links stay clean and are parsed into the same route intents, for example `iris://chat/session_abc?profile=default`.

Future mobile shells should reuse `apps/desktop/src/app/routing/routeIntent.ts` for string parsing and intent serialization. Register both a custom scheme (`iris://...`) and universal/app links under `https://iris.app/open/...`.

Production web deployments must serve static assets normally and rewrite unknown non-asset app paths to `index.html`, while keeping API paths out of the fallback. Vite dev and preview already provide the SPA fallback needed for direct route loads during development.
