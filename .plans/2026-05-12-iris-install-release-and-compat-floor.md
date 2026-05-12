# Iris install, release, and compatibility floor

## Goal

End state, macOS-only:

1. Iris Desktop ships as a signed/notarized `.app` that bundles Iris Core as a Tauri sidecar. Same-machine users get zero-step install: open the app, Core auto-starts on `127.0.0.1:8765`, Desktop connects.
2. Iris Core also ships as a signed/notarized standalone `.pkg` (and a Homebrew tap formula points at it) for users running Core on a different machine from Desktop. Same binary as the bundled sidecar.
3. `iris-core install-hermes-plugin` CLI subcommand installs and enables the `iris-platform` Hermes plugin from inside the Core install, replacing `scripts/install-iris-platform.mjs` for end users.
4. `/v1/health` returns Core version + `minClientVersion`; Desktop refuses (with a clear banner) to operate against a Core that requires a newer Desktop.
5. A new GitHub Actions release workflow, triggered on `release-*` tags, produces both signed artifacts (Desktop `.app`, Core `.pkg`) on `macos-latest` and attaches them to a GitHub release.
6. `tauri-plugin-updater` is wired into Desktop and reads an update manifest produced by the release workflow.

## Current Behavior

- `npm run bootstrap` (`package.json:10`) is the only Core install path. It runs `scripts/setup-iris-core.mjs`, which creates `iris-core/.venv` and `pip install -e ".[dev]"`. Requires the monorepo to be checked out.
- The packaged `.app` does **not** include Core. `desktop/src-tauri/src/lib.rs` only spawns `core_bridge.py` for Tauri commands; it does not spawn `iris-core`. `tauri.conf.json` has no `externalBin`.
- Core is launched in dev by `scripts/dev.mjs`, which runs `iris-core/.venv/bin/iris-core`. Outside dev, the user must start Core themselves.
- iris-platform is installed by `scripts/install-iris-platform.mjs`: copies `iris-platform/` to `$HERMES_HOME/plugins/iris-platform/` and runs `hermes plugins enable iris-platform`. Monorepo-only.
- `/health` (`HealthResponse` in `iris-core/src/hermes_management_server/models.py:15-19`) returns `{ ok, checkedAt, hermesHome, profilesRootExists }`. `/v1/health` (`main.py:819-828`) returns the same plus `core` storage health. Neither includes a version field.
- Desktop's status handler explicitly hardcodes `version: null` (`desktop/src/lib/agentuiCore.ts:226`). `HermesStatus.version` exists in the type (`desktop/src/types/hermes.ts:112`) but is never populated.
- Both packages are pinned at `0.1.0`: `iris-core/pyproject.toml:7`, `iris-core/src/hermes_management_server/__init__.py:7`, `desktop/package.json:4`, `desktop/src-tauri/Cargo.toml:4`, `desktop/src-tauri/tauri.conf.json:4`. No shared/derived version source.
- `.github/workflows/ci.yml` is the only workflow. It runs `npm run check`, `cargo check`, `tauri info` on macOS/Linux/Windows for PRs and main pushes. It does **not** build packaged artifacts, run on tags, or produce releases.
- `desktop/scripts/check-release-env.mjs` requires `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_SIGNING_IDENTITY` (for the `.app`). No equivalent for the `.pkg` installer cert.
- `desktop/docs/production-readiness.md` documents the Tauri updater plugin as a future addition ("Add the Tauri updater plugin once the public update manifest URL and signing key are finalized"). Not present in `desktop/src-tauri/Cargo.toml`.

## Desired Behavior

- Fresh macOS user double-clicks `Iris.app` → Desktop launches → Tauri spawns the bundled Core sidecar on `127.0.0.1:8765` → Desktop's status flips to "connected" within a couple seconds without any user action. If `~/.hermes` is missing, Desktop surfaces a "Hermes not installed" notice but does not crash.
- A remote-Core user installs Core on Box B via the `.pkg` (or `brew install iris-core` + `brew services start iris-core`), runs `iris-core install-hermes-plugin` once on Box B, restarts the Hermes gateway, then in Desktop on Box A sets `connectionMode: "remote"` + `coreApiUrl: "http://boxB:8765"` and pairs.
- If bundled Core is running on `127.0.0.1:8765` and the user also has a separately-installed Core listening on the same port, Desktop's startup probe detects the existing healthy Core and skips spawning, so there's no port conflict.
- If Desktop talks to a Core whose `minClientVersion` is newer than Desktop's own version, a non-dismissible banner appears: "This version of Iris (X.Y.Z) is too old for the Core at `<host>` which requires ≥ A.B.C. Update Iris Desktop." For local Core, the banner has an "Update now" button wired to the Tauri updater; for remote Core, it's an informational message only.
- Pushing a git tag `release-X.Y.Z` to `main` triggers the release workflow, which builds and signs both artifacts and attaches them to a GitHub release named `Iris X.Y.Z`. The same workflow uploads an `update.json` manifest used by `tauri-plugin-updater`.

## Findings

- **Tauri sidecar is the natural lifecycle owner for bundled Core.**
  - **Evidence**: `desktop/src-tauri/Cargo.toml` and `desktop/src-tauri/tauri.conf.json` already support adding `externalBin`; `desktop/src-tauri/src/lib.rs:77-129` is where `tauri::Builder::default()` is configured and is the right place to wire `Command::new_sidecar` on setup + child cleanup on `RunEvent::Exit`.
  - **Why it matters**: Eliminates the "user has to install Core separately" friction for the most common (same-machine) case without changing the network shape of the system.
  - **Confidence**: high.

- **Core must remain installable standalone — bundling does not replace standalone.**
  - **Evidence**: `iris-core/src/hermes_management_server/main.py:306` reads `HERMES_HOME` from env; the runtime adapter (`runtime_adapters/hermes_store.py`) reads `~/.hermes` from local disk. Core can only run on the same box as Hermes.
  - **Why it matters**: When Desktop is on Box A and Hermes is on Box B, Core must be on Box B and Desktop's bundled Core is unused. The `.pkg` and brew tap exist for Box B.
  - **Confidence**: high.

- **iris-platform install path can move out of the monorepo.**
  - **Evidence**: `scripts/install-iris-platform.mjs` does (a) discover Hermes homes from `$HERMES_HOME/profiles/*`, (b) copy `iris-platform/` to `$HERMES_HOME/plugins/iris-platform/`, (c) run `hermes plugins enable iris-platform` for each. All three steps are reproducible from inside a Core install if Core ships an iris-platform payload.
  - **Why it matters**: Lets the `.pkg`/brew user install the adapter without cloning the repo. Keeps Core and iris-platform versions locked.
  - **Confidence**: high.

- **Compatibility floor needs three small additions.**
  - **Evidence**: (a) `iris-core/src/hermes_management_server/__init__.py:7` is where `__version__` lives; a sibling `MIN_CLIENT_VERSION` constant fits there. (b) `models.py:15-19` defines `HealthResponse`; `/v1/health` (`main.py:819-828`) returns a dict and is the route Desktop actually calls (Desktop's `coreBaseUrl` in `coreTransport.ts:11-14` always appends `/v1`). (c) Desktop's `getAgentUICoreStatus` (`agentuiCore.ts:201-241`) already collects `/health` but discards the body's version (`agentuiCore.ts:226` hardcodes `null`).
  - **Why it matters**: Smallest unblocker for the rest of the work. Forces both sides to declare compatibility before anyone tries to ship a Desktop release.
  - **Confidence**: high.

- **AppShell already has a banner area; reuse it.**
  - **Evidence**: `desktop/src/layout/AppShell.tsx:834-842` renders `<div className="connection-banner">` when `error` is set. A compatibility banner is a sibling — not a hard error, but a blocking warning.
  - **Why it matters**: One integration point, no new layout primitive.
  - **Confidence**: medium (Codex should verify this is the best place vs. injecting nearer the top-level `<App>`).

- **Existing CI workflow should not be touched.**
  - **Evidence**: `.github/workflows/ci.yml:3-7` runs on PRs and `main` pushes; the release workflow needs a different trigger (`push: tags: ['release-*']`) and only needs `macos-latest`.
  - **Why it matters**: Keeps the PR signal unchanged and avoids accidentally running a signing-required job on every PR.
  - **Confidence**: high.

- **Existing release script does most of the Desktop signing already.**
  - **Evidence**: `desktop/package.json:13` (`release:mac` → `check-release-env.mjs` + `tauri build --bundles app`). `check-release-env.mjs` validates `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_SIGNING_IDENTITY`. Tauri's `tauri build` reads those for signing + notarization.
  - **Why it matters**: CI can call `release:mac` directly; doesn't need a separate Desktop signing pipeline. The new piece is the `.pkg` (Developer ID Installer cert, `pkgbuild`+`productbuild`+`notarytool`).
  - **Confidence**: high.

- **Tauri updater plugin requires a public-key/private-key pair and a manifest URL, neither of which exists yet.**
  - **Evidence**: `desktop/docs/production-readiness.md` calls this out as deferred. No `pubkey` in `tauri.conf.json`. No `update.json` produced anywhere.
  - **Why it matters**: Wiring the plugin is small, but provisioning the signing key + choosing a manifest host are decisions the user needs to make. Both can be staged: ship the plugin with a TBD manifest URL, populate after the first release lands.
  - **Confidence**: high.

## Claims To Verify

- [ ] `iris-core/src/hermes_management_server/__init__.py:7` sets `__version__ = "0.1.0"` and is the canonical version constant. No other file in `iris-core/` defines a separate `__version__`.
- [ ] `iris-core/src/hermes_management_server/main.py:819-828` defines `core_health` returning a plain `dict`, not a `HealthResponse` model. Desktop calls `/v1/health` (not `/health`) because `coreBaseUrl` (`desktop/src/lib/coreTransport.ts:11-14`) always appends `/v1`.
- [ ] `desktop/src/lib/agentuiCore.ts:226` hardcodes `version: null` and is the only place `version` is set on the returned `HermesStatus`.
- [ ] `desktop/src/types/hermes.ts:105-125` is the canonical `HermesStatus` type. There are no overlapping/duplicate declarations to keep in sync.
- [ ] `desktop/src-tauri/src/lib.rs:77-129` is the Tauri `Builder::default()` setup, and the `setup()` closure is the right place to spawn a sidecar. There is no existing sidecar/child process being spawned that this would conflict with.
- [ ] `desktop/src-tauri/Cargo.toml:21-25` already pulls in `tauri = "2"` and `tauri-plugin-opener = "2"`. Adding `tauri-plugin-updater = "2"` and `tauri-plugin-shell = "2"` is the standard Tauri v2 pattern.
- [ ] `desktop/src-tauri/tauri.conf.json` has no `externalBin` declared today.
- [ ] `scripts/install-iris-platform.mjs:47-58` (file copy logic) and `:21-44` (plugin enable logic) are the entire install path for iris-platform; there is no other place that wires the plugin.
- [ ] `iris-platform/plugin.yaml` declares `name: iris-platform`, `version: 0.1.0`, and `requires_env: [IRIS_BASE_URL, IRIS_TOKEN]`. There are no other build steps before copying.
- [ ] `iris-core/pyproject.toml` has `[project.scripts] iris-core = "hermes_management_server.main:cli"` and `[tool.setuptools.packages.find] where = ["src"]`. No existing `package_data` or `MANIFEST.in` ships non-Python files.
- [ ] `iris-core/src/hermes_management_server/main.py:3064-3077` (`build_parser`) defines `command` as a positional with `choices=("serve", "migrate-source-of-truth")`. Adding a new choice requires extending both `choices` and the `if args.command == ...` branch at `:3103-3107`.
- [ ] `.github/workflows/ci.yml:3-7` is the only workflow file, and triggers on `pull_request` + `push.branches: [main]`. No tag-triggered workflow exists.
- [ ] `desktop/scripts/check-release-env.mjs` validates four Apple env vars and does not validate `APPLE_INSTALLER_SIGNING_IDENTITY` (the cert needed for `.pkg`).
- [ ] No file in `desktop/src-tauri/` declares an `updater` plugin or a public key. `desktop/docs/production-readiness.md` "Updates" section is still accurate.

## Implementation Plan

Steps are ordered for incremental landing. Each phase can ship independently.

### Phase 1 — Compatibility floor

1. **`iris-core/src/hermes_management_server/__init__.py`** — Add `MIN_CLIENT_VERSION = "0.1.0"` next to `__version__`. Export via `__all__`.
2. **`iris-core/src/hermes_management_server/models.py`** — Add fields to `HealthResponse`: `version: str`, `minClientVersion: str`, `service: str = "iris-core"`. Keep existing fields for backward compatibility.
3. **`iris-core/src/hermes_management_server/main.py`** — Update `/health` and `/v1/health` to include `version=__version__, minClientVersion=MIN_CLIENT_VERSION, service="iris-core"`. Use the existing `HealthResponse` model for `/health`; extend the `/v1/health` dict at `:820-828`.
4. **`iris-core/tests/test_api.py`** — Add test `test_health_includes_version_and_min_client` asserting both fields present and equal to the package constants.
5. **`desktop/src/lib/compat.ts`** (new) — Tiny semver-compare utility: `compareVersions(a: string, b: string): -1 | 0 | 1` handling `X.Y.Z` plus optional `-pre.N` suffix. No external dep.
6. **`desktop/src/lib/__tests__/compat.test.ts`** (new) — Vitest covering equal, less, greater, pre-release ordering.
7. **`desktop/src/types/hermes.ts`** — Extend `HermesStatus` with `coreCompatibility?: { coreVersion: string; minClientVersion: string; clientVersion: string; ok: boolean }`. Keep `version: string | null` for backward compat (now actually populated).
8. **`desktop/src/lib/agentuiCore.ts`** — In `getAgentUICoreStatus` (`:205-240`), read `health.version` / `health.minClientVersion`. Compute compatibility against the Desktop's own version (import from `package.json` via Vite's `import.meta.env` or a constants file — Codex picks the cleanest source). Populate `version` and `coreCompatibility`.
9. **`desktop/src/layout/AppShell.tsx`** — Add a sibling banner next to the existing `connection-banner` at `:834-842`. New className `compat-banner`. Renders when `status?.coreCompatibility && !status.coreCompatibility.ok`. Copy: `"This Iris ({client}) is too old for Core at {host} (requires ≥ {min}). Update Iris Desktop."` Button "Update now" appears only when `runtimeConfig.connectionMode === "local"` (wired to Tauri updater in Phase 6; placeholder no-op until then).
10. **`desktop/src/App.css`** — Add styles for `.compat-banner` mirroring `.connection-banner`'s visual structure but with a warning tone (yellow/amber accent rather than red).

### Phase 2 — `install-hermes-plugin` CLI subcommand

11. **`iris-core/payload/iris-platform/`** (new directory) — Copy of `iris-platform/` source. Wire as package data so it ships inside the wheel and the standalone binary.
12. **`iris-core/pyproject.toml`** — Add `[tool.setuptools.package-data] hermes_management_server = ["payload/iris-platform/**"]` and ensure `MANIFEST.in` (create if absent) includes the payload tree. Add `pyinstaller>=6` to `[project.optional-dependencies] dev`.
13. **`iris-core/src/hermes_management_server/main.py`** — In `build_parser` (`:3064-3077`), add `"install-hermes-plugin"` to `choices`. Add CLI args: `--hermes-home` (already present), `--dry-run`. In `cli()` (`:3099-3108`), add a branch that:
    - Discovers Hermes homes (re-implement `discoverHermesHomes` from `scripts/install-iris-platform.mjs:61-74` in Python).
    - For each home: `mkdir -p plugins/iris-platform`, copy the payload from `importlib.resources.files("hermes_management_server").joinpath("payload/iris-platform")` to `plugins/iris-platform/`, run `hermes plugins enable iris-platform` with `HERMES_HOME=<home>`.
    - Prints "Restart the Hermes gateway before testing fresh chats." on success.
14. **`iris-core/tests/test_install_hermes_plugin.py`** (new) — Pytest using `tmp_path` as a fake `HERMES_HOME`, exercising the copy step. Mock the `hermes plugins enable` subprocess; verify it would be called with the correct env.
15. **Update root `scripts/install-iris-platform.mjs`** — Keep working for devs in the monorepo (no changes required), but add a one-line comment at the top noting end users should prefer `iris-core install-hermes-plugin`.

### Phase 3 — PyInstaller-based Core binary

16. **`iris-core/scripts/build-binary.mjs`** (new) — Node script invoking PyInstaller with a spec file. Steps: ensure `.venv` exists, `pip install pyinstaller`, run `pyinstaller iris-core.spec --distpath dist --workpath build`, verify resulting binary at `iris-core/dist/iris-core`.
17. **`iris-core/iris-core.spec`** (new) — PyInstaller one-file spec. Entry point: `src/hermes_management_server/main.py`'s `cli`. Include `payload/iris-platform/**` as `datas`. Hidden imports: any uvicorn workers / httpx fallbacks that PyInstaller misses (Codex tries `--collect-all uvicorn` first).
18. **`iris-core/README.md`** — Add a "Build standalone binary" section pointing at `npm run core:build:binary` (added next).
19. **`package.json`** — Add `"core:build:binary": "node iris-core/scripts/build-binary.mjs"` to root scripts.

### Phase 4 — Tauri sidecar wiring

20. **`desktop/src-tauri/Cargo.toml`** — Add `tauri-plugin-shell = "2"` to dependencies.
21. **`desktop/src-tauri/binaries/.gitkeep`** (new) — placeholder so the directory exists; binaries themselves are not checked in.
22. **`desktop/scripts/stage-core-sidecar.mjs`** (new) — Pre-build script: copies `iris-core/dist/iris-core` to `desktop/src-tauri/binaries/iris-core-aarch64-apple-darwin` (Tauri requires the target triple suffix). Fails clearly if the source binary doesn't exist.
23. **`desktop/package.json`** — Update `build:mac:app` and `release:mac` to run `stage-core-sidecar.mjs` first. Add `"build:sidecar": "node scripts/stage-core-sidecar.mjs"`.
24. **`desktop/src-tauri/tauri.conf.json`** — Add `bundle.externalBin: ["binaries/iris-core"]`. Add permission entries for `shell:allow-execute` scoped to the bundled sidecar in `desktop/src-tauri/capabilities/default.json` (Codex consults Tauri v2 sidecar docs; pattern is well-established).
25. **`desktop/src-tauri/src/lib.rs`** — In the `setup` closure (around `:80`):
    - Define an async helper `ensure_core_running(app: AppHandle) -> Result<()>`:
      - HTTP GET `http://127.0.0.1:8765/v1/health` with 500ms timeout. If response is JSON with `service == "iris-core"` and `ok == true`, return early (existing healthy Core, e.g. user's standalone install or remote dev).
      - Otherwise: spawn the sidecar via `tauri_plugin_shell::ShellExt::shell().sidecar("iris-core")`, env vars from existing dev defaults (`HERMES_HOME` from `~/.hermes`), poll `/v1/health` until ready (max 10s).
    - Store the `CommandChild` handle in app state so it can be killed on exit.
    - Register a `RunEvent::Exit` handler (after `.run(...)` is replaced with `.build(...).run(|app, event| { ... })`) that kills the child.
26. **`desktop/src/layout/AppShell.tsx`** — During the initial connection retry loop, show a "Starting Iris Core…" placeholder instead of the existing "Core unreachable" error for the first few seconds after launch (Codex picks the threshold; 3-5s feels right).

### Phase 5 — Standalone `.pkg` installer

27. **`iris-core/scripts/build-pkg.mjs`** (new) — Builds a flat `.pkg`:
    - Stages `dist/iris-core` → `pkg-root/usr/local/bin/iris-core`.
    - Stages `iris-core/launchd/com.nousresearch.iris-core.plist` → `pkg-root/Library/LaunchAgents/com.nousresearch.iris-core.plist`.
    - Runs `pkgbuild --root pkg-root --identifier com.nousresearch.iris-core --version <X.Y.Z> --sign "$APPLE_INSTALLER_SIGNING_IDENTITY" iris-core.pkg`.
    - Runs `productbuild --package iris-core.pkg --sign "$APPLE_INSTALLER_SIGNING_IDENTITY" iris-core-signed.pkg`.
    - Runs `xcrun notarytool submit iris-core-signed.pkg --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait`.
    - Runs `xcrun stapler staple iris-core-signed.pkg`.
    - Output: `iris-core/dist/Iris-Core-<X.Y.Z>.pkg`.
28. **`iris-core/launchd/com.nousresearch.iris-core.plist`** (new) — LaunchAgent that runs `/usr/local/bin/iris-core serve --host 127.0.0.1 --port 8765`. `KeepAlive: true`, `RunAtLoad: false` (user opts in via `launchctl load`).
29. **`iris-core/scripts/check-release-env.mjs`** (new) — Validates `APPLE_INSTALLER_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`. Modeled after `desktop/scripts/check-release-env.mjs`.
30. **`package.json`** — Add `"core:build:pkg": "node iris-core/scripts/build-pkg.mjs"` and `"core:release:mac": "node iris-core/scripts/check-release-env.mjs && npm run core:build:binary && npm run core:build:pkg"`.

### Phase 6 — GitHub Actions release workflow + Tauri updater

31. **`.github/workflows/release.yml`** (new) — Trigger: `push: tags: ['release-*']`. Single job, `runs-on: macos-latest`. Steps:
    - Checkout.
    - Setup Node 22, Python 3.11, Rust stable.
    - Import signing certificates from secrets (`APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_INSTALLER_CERT_P12_BASE64`, `APPLE_INSTALLER_CERT_PASSWORD`) into a temporary keychain.
    - `npm ci` + `npm run core:setup`.
    - `npm run core:build:binary` (PyInstaller).
    - `npm run core:build:pkg` (signed `.pkg`).
    - `npm run build:sidecar` (stage binary into Desktop).
    - `npm --workspace desktop run release:mac` (signed `.app`).
    - Generate `update.json` (see step 36) and sign with `tauri signer sign` using `TAURI_SIGNING_PRIVATE_KEY`.
    - Use `softprops/action-gh-release` to create a release tagged `release-X.Y.Z`, attaching `Iris-<X.Y.Z>.app.tar.gz`, `Iris-Core-<X.Y.Z>.pkg`, and `update.json`.
    - Required secrets (document in `desktop/docs/production-readiness.md`): `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_SIGNING_IDENTITY`, `APPLE_INSTALLER_SIGNING_IDENTITY`, `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_INSTALLER_CERT_P12_BASE64`, `APPLE_INSTALLER_CERT_PASSWORD`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
32. **`desktop/src-tauri/Cargo.toml`** — Add `tauri-plugin-updater = "2"`.
33. **`desktop/src-tauri/src/lib.rs`** — Register `tauri-plugin-updater` plugin (`.plugin(tauri_plugin_updater::Builder::new().build())`).
34. **`desktop/src-tauri/tauri.conf.json`** — Add `plugins.updater`:
    ```json
    "updater": {
      "active": true,
      "endpoints": ["https://github.com/<org>/<repo>/releases/latest/download/update.json"],
      "pubkey": "<inserted by ops after key generation>"
    }
    ```
    Exact endpoint URL is an open question (see below).
35. **`desktop/src/lib/updater.ts`** (new) — Thin wrapper around `@tauri-apps/plugin-updater`. Exposes `checkForUpdates()` returning `{ available: boolean; version?: string; install: () => Promise<void> }`. Called from `AppShell` on mount and from the compat banner's "Update now" button.
36. **`desktop/scripts/generate-update-manifest.mjs`** (new) — Reads the just-built `.app.tar.gz`, computes the signature with the Tauri signing key, emits `update.json` matching Tauri v2's expected schema (`version`, `notes`, `pub_date`, `platforms.darwin-aarch64.url`, `signature`).

## Non-Goals / Must Not Change

- **Windows and Linux builds.** Existing `ci.yml` keeps testing all three OSes, but the release workflow is macOS-only. Do not add Windows code signing, MSI, or `.deb`/`.AppImage` packaging.
- **Auto-updating remote Core.** The Tauri updater only updates Desktop. Core update is brew or `.pkg` re-install, user-driven. Do not add Desktop-initiated Core upgrades.
- **Bundling Hermes.** Hermes remains a user-installed prerequisite. Desktop / Core do not try to install or update Hermes.
- **Refactoring `desktop/src-tauri/python/core_bridge.py` or `desktop/src/lib/coreLegacyCompat.ts`.** Leave them as-is.
- **Changing the SQLite schema, storage paths (`~/.iris/core.sqlite3`), or the runtime adapter contract.**
- **Changing the `iris-platform/` plugin source itself.** It is copied verbatim into the Core payload.
- **Touching `.github/workflows/ci.yml`.** New workflow only.
- **API contract changes beyond the additive `version` / `minClientVersion` / `service` fields on `/health` and `/v1/health`.** Do not rename fields, do not change other endpoints.
- **Bumping the Core or Desktop version away from `0.1.0`** as part of this work. Version bumps are a release-time action, not part of this implementation.

## Tests

Add or update:

- `iris-core/tests/test_api.py` — `test_health_includes_version_and_min_client` covers `/health` and `/v1/health`.
- `iris-core/tests/test_install_hermes_plugin.py` (new) — `tmp_path`-based test of the copy + enable flow with mocked subprocess.
- `desktop/src/lib/__tests__/compat.test.ts` (new) — semver compare cases.
- `desktop/src/lib/__tests__/agentuiCore.test.ts` — extend with a case where `/health` returns `{version, minClientVersion}` and Desktop populates `coreCompatibility`.

Commands to run from repo root:

- `npm --workspace desktop run test -- compat`
- `npm --workspace desktop run test -- agentuiCore`
- `iris-core/.venv/bin/python -m pytest iris-core/tests/test_api.py -k health`
- `iris-core/.venv/bin/python -m pytest iris-core/tests/test_install_hermes_plugin.py`
- Full gate: `npm run check`

## Verification

Manual checks (each phase has its own; do them in order):

**Phase 1 (compat floor):**

- [ ] `iris-core/.venv/bin/iris-core --host 127.0.0.1 --port 8765` then `curl http://127.0.0.1:8765/v1/health | jq` shows `version` and `minClientVersion`.
- [ ] `npm run dev:web`, open `http://localhost:1420/`, status bar shows connected. Edit `MIN_CLIENT_VERSION` in `__init__.py` to `99.0.0`, restart Core (Vite HMR will not pick up Core changes — Core must be restarted), refresh Desktop. Confirm yellow compat banner appears with the expected copy.

**Phase 2 (install-hermes-plugin):**

- [ ] Fresh `HERMES_HOME=/tmp/fake-hermes`, run `iris-core/.venv/bin/iris-core install-hermes-plugin --hermes-home /tmp/fake-hermes`. Confirm `/tmp/fake-hermes/plugins/iris-platform/plugin.yaml` exists and matches the payload.
- [ ] Against a real `~/.hermes`, run the subcommand and confirm it matches what `scripts/install-iris-platform.mjs` would have done (`hermes plugins list` shows iris-platform enabled).

**Phase 3 (Core binary):**

- [ ] `npm run core:build:binary` produces `iris-core/dist/iris-core`. Running it (`./iris-core/dist/iris-core --host 127.0.0.1 --port 8765`) starts a working Core (test with `curl /v1/health`).

**Phase 4 (Tauri sidecar):**

- [ ] `npm run build:mac:app` succeeds. The resulting `.app` bundle contains `Contents/Resources/_up_/binaries/iris-core` (or equivalent path; Tauri places the sidecar inside Resources).
- [ ] Quit any local Core, then double-click the `.app`. Within a few seconds Desktop is connected — no manual `iris-core serve` needed.
- [ ] Start a separate `iris-core` on `127.0.0.1:8765` first, then launch the `.app`. Confirm the bundled sidecar is **not** spawned (check Activity Monitor for only one `iris-core` process).
- [ ] Note for the user: **the packaged `.app` must be rebuilt** after every change to the Core binary or the Rust spawn logic. `npm run dev` does **not** exercise the bundled sidecar — the dev runner spawns Core from `.venv` instead.

**Phase 5 (`.pkg`):**

- [ ] On a clean macOS user account, install `Iris-Core-X.Y.Z.pkg`. Confirm `/usr/local/bin/iris-core --version` prints the right version.
- [ ] `launchctl load -w ~/Library/LaunchAgents/com.nousresearch.iris-core.plist` then `curl http://127.0.0.1:8765/v1/health` returns ok.
- [ ] `iris-core install-hermes-plugin` works from the installed binary.

**Phase 6 (release workflow + updater):**

- [ ] Push a `release-0.1.1` tag on a fork (after bumping version constants in `__init__.py`, `pyproject.toml`, `package.json`, `Cargo.toml`, `tauri.conf.json`). Confirm the workflow runs to completion on `macos-latest` and a GitHub release is created with both artifacts + `update.json`.
- [ ] On a Desktop instance pinned to `0.1.0`, with `endpoints` pointing at the test fork's release manifest, confirm a "Update available" notice surfaces and "Update now" downloads + relaunches at `0.1.1`.

## Open Questions

- **Update manifest hosting URL.** GitHub release URL (`https://github.com/<org>/<repo>/releases/latest/download/update.json`) is the simplest default but bakes the org/repo into the binary. A separate static host (`updates.iris.<domain>`) decouples but adds infra. Default to GitHub for the first release; revisit when the public domain is ready.
- **Tauri updater key pair.** Needs to be generated once with `npm --workspace desktop run tauri signer generate`. The private key goes into `TAURI_SIGNING_PRIVATE_KEY` secret; the public key goes into `tauri.conf.json`. Who generates and where it's escrowed is a user/ops decision, not a code one.
- **macOS arch coverage.** Apple Silicon only, or universal `.app` + universal Core binary? PyInstaller can build a universal binary on a `macos-latest` runner but it's slower and bigger. Assume arm64-only for the first release unless user says otherwise.
- **Port collision policy beyond probe-and-skip.** If `127.0.0.1:8765` is bound by something that isn't Core (e.g. another service), the bundled sidecar can't bind. Current plan: log + surface a clear error. Alternative: fall back to `127.0.0.1:8766` and inject the chosen URL into runtime config. Defaulting to "error clearly" is safer; revisit if it bites.
- **Homebrew tap.** Out of scope for this monorepo (tap lives in a separate repo). The release workflow can be extended later to bump the formula via `brew bump-formula-pr`; not part of this plan.
- **`hermes` CLI discovery in the `.pkg`.** `iris-core install-hermes-plugin` shells out to `hermes plugins enable`. If `hermes` isn't on `$PATH` for the user running the subcommand from the `.pkg`-installed binary, the enable step fails. Print a clear message and continue (the file copy succeeded), or fail hard? Recommend: copy succeeds, enable step warns + prints the manual command, exit 0.
- **`HERMES_HOME` discovery from a launchd-spawned Core.** LaunchAgents start with a minimal environment; `$HOME` is set but `HERMES_HOME` is not. The launchd plist should set `EnvironmentVariables.HERMES_HOME` to the installing user's `~/.hermes`. This means the postinstall script (or the user) must know the right `HOME` — flag this for ops decision before shipping the `.pkg`.
