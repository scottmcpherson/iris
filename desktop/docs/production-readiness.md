# Production Readiness Notes

## Tauri Permissions Review

- `src-tauri/capabilities/default.json` grants only `core:default` and `opener:default` to the main window.
- File-system, shell, HTTP, and dialog plugins are not exposed to the webview.
- Hermes chat, Iris Core profile reads, skill reads, and memory reads stay behind explicit Tauri commands.
- The app CSP is enabled in `src-tauri/tauri.conf.json`. Inline/eval script allowances are intentionally retained for the local preview runtime and should be revisited if preview execution moves into a dedicated plugin or separate origin.

## Credentials

- Remote agent bearer tokens are not stored in `localStorage`.
- The Settings token field writes to the OS credential store through the bridge.
- On macOS, the bridge uses Keychain via the `security` command.
- CI and local automated tests use `HERMES_DESKTOP_SECRET_TEST_DIR` to exercise the credential path without touching a real keychain.
- `HERMES_REMOTE_TOKEN` remains a read-only environment override for automation.

## Builds

- `npm run build:mac:app` builds the macOS `.app` bundle only and bypasses the DMG path that previously hung.
- `npm run release:mac` verifies the Apple signing/notarization environment first, then builds the `.app` bundle.
- `npm run package:check` runs the frontend build, Rust check, and Tauri environment report on the current host.
- The GitHub Actions workflow runs tests and packaging checks on macOS, Windows, and Linux.

## Updates

- The current update mechanism is release-channel based: signed and notarized `.app` builds are produced by the release script and can be published behind a stable download endpoint.
- Add the Tauri updater plugin once the public update manifest URL and signing key are finalized.

## Crash And Error Logging

- Native panics append to the Tauri app log directory as `crash.log`.
- Bridge errors continue to flow back to the UI as structured `{ ok: false, error }` responses.
