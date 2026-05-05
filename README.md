# AgentUI

AgentUI is a monorepo that provides UI apps for Hermes Agent, including the native desktop client and its local management sidecar.

## Workspace Layout

- `desktop/`: Tauri 2, React 18, TypeScript, and Tailwind desktop app.
- `sidecar/`: FastAPI management sidecar used by the desktop app for profile, memory, skill, status, and conversation metadata.
- `scripts/`: root developer helpers for setup and coordinated startup.

## First-Time Setup

```bash
npm run bootstrap
```

This installs the desktop Node dependencies, creates `sidecar/.venv`, and installs the sidecar in editable development mode.

If Node dependencies are already installed and you only need the Python sidecar environment:

```bash
npm run sidecar:setup
```

## Daily Development

Start the sidecar and the Tauri desktop app together:

```bash
npm run dev
```

Start the sidecar and the Vite web surface only:

```bash
npm run dev:web
```

Start only the sidecar:

```bash
npm run sidecar:dev
```

The desktop Vite server runs on `http://127.0.0.1:1420/`. The sidecar defaults to `http://127.0.0.1:8765/v1`.

## Verification

```bash
npm run check
npm run package:check
npm run build:mac:app
```

`npm run check` runs the desktop TypeScript/Vitest/build checks, the desktop Python bridge tests, and the sidecar pytest suite. `npm run build:mac:app` delegates to the desktop Tauri app build.

## More Detail

- Desktop app docs: [`desktop/README.md`](desktop/README.md)
- Sidecar docs: [`sidecar/README.md`](sidecar/README.md)
- Production packaging notes: [`desktop/docs/production-readiness.md`](desktop/docs/production-readiness.md)
