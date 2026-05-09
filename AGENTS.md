# AgentUI Agent Instructions

- For every new feature or visible UI change, use browser/Vite checks and targeted tests for normal iteration. Prefer these lightweight checks while developing so the packaged desktop app does not steal focus unnecessarily.
- For built-in browser smoke tests, open the Vite dev surface at `http://localhost:1420/`. The in-app browser may block `http://127.0.0.1:1420/` even when the same server is healthy.
- Assume the user normally has `npm run dev` running in the background. When finishing work, say whether the existing dev session should pick up the change automatically or whether the user needs to restart the dev runner, restart Iris Core, reinstall/update the Hermes adapter plugin, restart the Hermes gateway, or open a fresh chat.
- For final verification of visible UI changes or desktop behavior, create a fresh Tauri app build.
- Use `npm run build:mac:app` for the fresh macOS app bundle.
- Launch the newly built app bundle, then test the feature with the `Computer Use` plugin against `com.nousresearch.hermes-agent.desktop`.
- Do not rely on the raw `npm run tauri dev` binary for Computer Use testing. The dev binary may not expose a bundle identifier, which can cause Computer Use to attach to or launch a stale bundled app instead.
- Do not run multiple packaged desktop verification sessions in parallel against the same bundle identifier. Parallel feature work should use separate browser/Vite checks, ports, or worktrees, then serialize final packaged-app verification.
