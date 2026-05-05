# AgentUI Agent Instructions

- For every new feature or visible UI change, create a fresh Tauri app build before final verification.
- Use `npm run build:mac:app` for the fresh macOS app bundle.
- Launch the newly built app bundle, then test the feature with the `Computer Use` plugin against `com.nousresearch.hermes-agent.desktop`.
- Do not rely on the raw `npm run tauri dev` binary for Computer Use testing. The dev binary may not expose a bundle identifier, which can cause Computer Use to attach to or launch a stale bundled app instead.
- For quick iteration, browser or Vite checks are fine, but final feature verification should use the fresh Tauri app build plus Computer Use.
