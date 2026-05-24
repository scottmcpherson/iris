# Production Readiness Notes

## Tauri Permissions Review

- `src-tauri/capabilities/default.json` grants only `core:default` and `opener:default` to the main window.
- File-system, shell, HTTP, and dialog plugins are not exposed to the webview.
- Hermes chat, Iris Core profile reads, skill reads, and memory reads stay behind explicit Tauri commands.
- The app CSP is enabled in `src-tauri/tauri.conf.json` without live-preview script exceptions.

## Credentials

- Iris Desktop does not expose manual remote Core bearer-token entry or paired device credentials.
- Packaged desktop Core traffic uses the native bridge explicitly; browser/Vite development uses browser fetch explicitly.
- The native bridge no longer reads `IRIS_TOKEN` or macOS Keychain credentials for generic Core request retries.
- Supported Local and SSH paths keep Core on loopback and do not require Core bearer auth, even if a stale `IRIS_TOKEN` remains in the environment. Hermes Jobs API calls use `HERMES_API_TOKEN`, or the Hermes `API_SERVER_KEY` discovered by Core from `$HERMES_HOME/.env`.

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
