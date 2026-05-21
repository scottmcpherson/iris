# Local/SSH Core Transport and Auth Cleanup

## Goal

Simplify Iris around the product-supported connection model:

- Local: Iris Desktop, Iris Core, and Hermes run on the same machine.
- SSH: Iris Desktop opens an SSH tunnel to a remote host where Iris Core and Hermes run on that host's loopback interface.

Remove the leftover direct-remote HTTP architecture: device pairing, paired device tokens, remote bearer credential storage, Tailscale/manual-url runtime modes, and the hidden browser-fetch-to-native-bridge fallback. SSH should be the remote access and auth boundary.

## Current State

The code still supports a broader architecture than the product now wants.

### Core Auth

Relevant files:

- `iris-core/src/hermes_management_server/security.py`
- `iris-core/src/hermes_management_server/main.py`
- `iris-core/src/hermes_management_server/core_store.py`
- `iris-core/tests/test_security.py`
- `iris-core/tests/test_api.py`

Current behavior:

- Core allows unauthenticated requests when bound to loopback and no `IRIS_TOKEN` is configured.
- Core requires bearer auth when `IRIS_TOKEN` exists or when the bind host is non-loopback.
- Bearer auth accepts either the management token or a paired device token.
- `/v1/devices/pair` creates an `agui_...` device token, but the endpoint itself requires existing auth.
- Device rows and device cursors are persisted in Core SQLite.

This is not a complete user auth flow. It is a token gate plus a device-token subsystem aimed at direct remote Core access.

### Desktop Transport

Relevant files:

- `desktop/src/lib/coreTransport.ts`
- `desktop/src/lib/irisCore.ts`
- `desktop/src/lib/irisRuntime.ts`
- `desktop/src-tauri/python/core_bridge.py`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src/lib/__tests__/irisCore.test.ts`
- `desktop/src-tauri/python/tests/test_core_bridge.py`

Current behavior:

- `coreRequest()` first tries browser `fetch()`.
- On `401`/`403`, failed GETs, or some network errors, it falls back to `invoke("core_bridge")`.
- The Python bridge can read `IRIS_TOKEN` or a macOS Keychain token and retry the same Core HTTP request.
- The same bridge also handles local-path attachment uploads and attachment data conversion.

This fallback hides transport differences and makes auth behavior implicit.

### Runtime Config

Relevant files:

- `desktop/src/app/runtimeConfig.ts`
- `desktop/src/types/hermes.ts`
- `desktop/src/app/__tests__/runtimeConfig.test.ts`
- `desktop/src/features/settings/SettingsView.tsx`
- `desktop/src/layout/AppShell.tsx`
- `desktop/src/lib/irisCore.ts`

Current behavior:

- Runtime modes include `managed-local`, `ssh`, `tailscale`, and `manual-url`.
- Tailscale and manual-url are direct HTTP modes.
- Some copy and status labels still treat non-SSH remote Core URLs as supported.

The target product shape only needs `managed-local` and `ssh`.

### Hermes Adapter / Runtime Delivery

Relevant files:

- `iris-platform/adapter.py`
- `iris-platform/README.md`
- `iris-platform/tests/test_adapter.py`
- `iris-core/src/hermes_management_server/payload/iris-platform/*`
- `iris-core/src/hermes_management_server/runtime_adapters/hermes.py`

Current behavior:

- The adapter accepts unauthenticated loopback delivery when no `IRIS_TOKEN` is configured.
- It requires `IRIS_TOKEN` for non-loopback `IRIS_BASE_URL`.
- Core writes `IRIS_TOKEN` hints into Hermes `.env` when a token exists.

For local and SSH, the adapter should be configured against loopback from the Hermes host's point of view. Direct non-loopback adapter delivery should no longer be presented as the normal path.

### Documentation

Relevant files:

- `README.md`
- `desktop/README.md`
- `iris-core/README.md`
- `iris-platform/README.md`
- `docs/communication-map.html`
- `desktop/docs/production-readiness.md`

Current docs still describe direct private-network Core URLs, paired device tokens, and token-bearing non-loopback Core traffic.

## Target Architecture

### Supported Connection Modes

Use only:

```ts
type IrisCoreConnectionMode = "managed-local" | "ssh";
```

Local mode:

```text
Iris Desktop -> Iris Core on 127.0.0.1 -> local Hermes
```

SSH mode:

```text
Iris Desktop -> local SSH forwarded port -> remote 127.0.0.1:8765 -> remote Hermes
```

Remote Core should normally bind to `127.0.0.1`. SSH is the mechanism that makes it reachable.

### Auth Model

Remove user-facing remote pairing and direct remote bearer-token setup.

Keep the loopback allowance for now unless a later hardening pass introduces an internal owner secret for managed local Core. If we add that later, it should be an implementation detail between Desktop and the Core process it launches, not a user-visible remote pairing flow.

### Transport Model

Use a single explicit Core transport per runtime environment:

- Packaged Tauri: native transport through Tauri IPC.
- Browser/Vite development: browser transport against the Vite/dev Core surface.

Do not retry a failed browser HTTP request through native IPC as a fallback.

The native path can still call Core over HTTP internally, but the boundary should be explicit:

```ts
const transport = isTauriRuntime() ? tauriCoreTransport : browserCoreTransport;
```

Local-path attachment upload and native-only attachment conversion should remain native-only capabilities, but they should not be mixed with generic JSON request fallback behavior.

## Implementation Plan

### 1. Freeze the Product Contract in Types

Update the desktop runtime types first:

- Remove `"tailscale"` and `"manual-url"` from `IrisCoreConnectionMode`.
- Remove `tailscale` and `manual` connection profile fields unless a migration shim still needs to read them.
- Remove `tailscale` and `manual-url` from `HermesStatus.transport`.
- Update `connectionTransport()`, `hermesOwner()`, `runtimeDataRouteKey()`, `normalizeProfile()`, and default-name helpers.

Migration behavior:

- Existing saved `manual-url` or `tailscale` configs should not crash the app.
- Convert unsupported saved configs back to the managed local profile, or ignore them while keeping managed local available.
- Prefer a visible "unsupported legacy connection was reset" status only if the app already has a suitable place for it; otherwise keep the migration quiet and safe.

Tests:

- Update `desktop/src/app/__tests__/runtimeConfig.test.ts`.
- Remove tests that assert `manual-url` or `tailscale` persistence.
- Add tests that legacy unsupported modes are sanitized to a valid local/SSH config.

### 2. Remove Device Pairing From the Public Core API

Remove or deprecate:

- `IrisCoreDevice` client type.
- `pairIrisCoreDevice()`.
- `revokeIrisCoreDevice()`.
- `/v1/devices`.
- `/v1/devices/me`.
- `/v1/devices/pair`.
- `/v1/devices/{device_id}`.
- `/v1/devices/me/cursors`.
- `device_token_hash()`.
- `active_device_for_credentials()`.
- device-token acceptance in `make_auth_dependency()`.

Database cleanup:

- Do not immediately drop existing `devices` and `device_cursors` tables unless the migration story is already established.
- It is acceptable to leave inert tables in SQLite for one release while removing active code paths.
- Remove device metadata sanitization helpers only if no remaining code uses them.

Auth dependency target:

- `require_auth` should only handle:
  - Loopback with no configured token: allow.
  - Configured `IRIS_TOKEN` or non-loopback bind: require the management token.

Tests:

- Remove or rewrite `iris-core/tests/test_security.py` device-token cases.
- Remove device API assertions from `iris-core/tests/test_api.py`.
- Keep tests for loopback/no-token and non-loopback/requires-token while Core still supports non-loopback binding at the server level.

### 3. Remove Remote Credential Storage From the Bridge

Remove from `desktop/src-tauri/python/core_bridge.py`:

- `remote_credential_status`.
- `remote_credential_save`.
- `remote_credential_delete`.
- Keychain account helpers used only for Core bearer tokens.
- `read_remote_token()` and token injection for generic Core JSON requests, unless still needed for a transitional management-token path.

Remove from `desktop/src/lib/irisRuntime.ts`:

- `getRemoteCredentialStatus()`.
- `saveRemoteCredential()`.
- `deleteRemoteCredential()`.
- `RemoteCredentialKind` / `RemoteCredentialStatus` types if unused.

Tests:

- Remove Python bridge tests for remote credentials and manual-url token retry.
- Keep tests for local-path upload and attachment data conversion.

### 4. Split Core Transport Instead of Falling Back

Refactor `desktop/src/lib/coreTransport.ts` into explicit transports.

Suggested shape:

```ts
type CoreTransport = {
  request<T>(
    runtime: HermesRuntimeConfig | undefined,
    method: CoreMethod,
    path: string,
    body?: unknown,
    options?: CoreRequestOptions,
  ): Promise<CoreResponse<T>>;
};
```

Implementation options:

- `browserCoreTransport`: direct `fetch()`, for Vite/browser.
- `tauriCoreTransport`: `invoke("core_bridge", { action: "core_request", ... })`, for packaged Tauri.
- `coreRequest()`: dispatches to the correct transport based on Tauri runtime detection.

Important behavior changes:

- A `401`/`403` from one transport should be returned as an auth error, not retried through another transport.
- Non-idempotent POST/PATCH/DELETE calls should never be replayed through a second transport.
- Timeouts should be transport-owned and deterministic.

Tests:

- Replace `falls back through the native bridge when Core requires bearer auth` with tests that:
  - Tauri runtime uses native transport immediately.
  - Browser runtime uses fetch only.
  - `401` is returned without fallback.
  - POST timeout is not replayed.

### 5. Keep Native Attachment Capabilities, But Make Them Explicit

Keep bridge/native behavior for:

- Uploading a local filesystem path.
- Reading attachment data when WebView playback needs conversion.
- Transcoding `.webm` / `.ogg` audio when needed.

Clean up naming so it is clear these are native attachment operations, not generic auth fallbacks.

Potential bridge actions after cleanup:

- `core_request`
- `core_upload_path`
- `core_attachment_data`

If `core_request` remains in Python, ensure it no longer reads Keychain credentials. It should just call the currently selected loopback Core URL.

### 6. Remove Direct Remote Runtime UI and Copy

Update desktop UI:

- Settings should show only Local and SSH tabs.
- Remove unreachable labels for Tailscale/manual remote.
- Remove `remote-mac`, `custom`, and direct remote copy from status helpers.
- Keep SSH copy OS-neutral: "remote host" or "remote machine."

Files to check:

- `desktop/src/features/settings/SettingsView.tsx`
- `desktop/src/layout/AppShell.tsx`
- `desktop/src/features/chat/ChatView.tsx`
- `desktop/src/features/runtime/RuntimeDiagnosticsDialog.tsx`
- `desktop/src/features/polish/OnboardingOverlay.tsx`
- `desktop/src/lib/irisCore.ts`

Tests:

- Update shell/status label tests under `desktop/src/layout/__tests__`.
- Update onboarding/settings tests if present.

### 7. Update Hermes Adapter Assumptions

For the supported paths, `IRIS_BASE_URL` should be loopback from the Hermes host:

- Local: `http://127.0.0.1:8765`.
- SSH remote host: remote Hermes adapter still talks to remote Core at `http://127.0.0.1:8765`.

Update adapter docs and install hints:

- Stop presenting non-loopback `IRIS_BASE_URL` plus `IRIS_TOKEN` as the normal remote setup.
- Keep defensive validation for non-loopback only if we still want low-level support for manual operators, but make it explicitly unsupported by Iris Desktop.

Potential code simplification:

- `iris_config_error()` can continue rejecting non-loopback without token, but the user-facing hint should say to use SSH instead of setting `IRIS_TOKEN`.
- Runtime adapter errors that currently say `IRIS_TOKEN is required for non-loopback Iris gateway...` should be replaced with SSH/loopback guidance where they can surface in the app.

Tests:

- Update `iris-platform/tests/test_adapter.py` expectations around install hints and README guidance.
- Mirror changes into `iris-core/src/hermes_management_server/payload/iris-platform`.

### 8. Documentation Cleanup

Update docs to match the product model:

- `README.md`
- `desktop/README.md`
- `iris-core/README.md`
- `iris-platform/README.md`
- `iris-core/src/hermes_management_server/payload/iris-platform/README.md`
- `desktop/docs/production-readiness.md`

Remove or rewrite:

- Direct private-network Core setup.
- Paired device token setup.
- Remote credential/keychain setup.
- Manual-url/Tailscale connection modes.
- "Remote or other non-loopback Core/plugin traffic requires `IRIS_TOKEN`" as a normal user path.

`docs/communication-map.html` appears generated/static. Either regenerate it from the new source of truth if a generator exists, or update it manually in the same PR so it does not describe removed behavior.

### 9. Verification

Lightweight checks while implementing:

- `npm test --workspace desktop -- runtimeConfig`
- `npm test --workspace desktop -- irisCore`
- `npm test --workspace desktop -- ssh`
- `cd iris-core && uv run pytest tests/test_security.py tests/test_api.py`
- `pytest iris-platform/tests/test_adapter.py`, or the repo's equivalent Python command if adapter tests run through Core's environment.

Browser/Vite checks:

- Use the Vite surface at `http://localhost:1420/`.
- Verify Settings shows only Local and SSH.
- Verify local chat/session loading still works.
- Verify SSH profile creation still opens a tunnel and uses the forwarded loopback URL.

Final desktop verification because this touches transport and runtime behavior:

- Run `npm run build:mac:app`.
- Launch the fresh app bundle.
- Use Computer Use against `com.nousresearch.hermes-agent.desktop`.
- Verify:
  - Managed local starts or connects to Core.
  - Core data loads with no hidden fallback path.
  - Chat send and SSE/polling updates still work.
  - Local-path attachment upload still works.
  - SSH connection still works against a remote host with Core bound to remote loopback.

## Suggested PR Breakdown

### PR 1: Runtime Mode Cleanup

- Remove `manual-url` and `tailscale` from desktop runtime config.
- Sanitize legacy saved configs.
- Update Settings/AppShell labels and tests.

### PR 2: Transport Split

- Replace fallback transport with explicit browser/native transports.
- Keep attachment bridge operations.
- Update desktop tests.

### PR 3: Remove Device Pairing and Remote Credentials

- Remove Core device pairing APIs and device-token auth.
- Remove desktop remote credential bridge actions and client wrappers.
- Update Core and bridge tests.

### PR 4: Adapter and Docs Cleanup

- Update adapter hints and docs to local/SSH only.
- Remove paired-token and direct-private-network docs.
- Update `communication-map.html`.

## Acceptance Criteria

- Desktop runtime config supports only `managed-local` and `ssh`.
- The app has no UI path for manual remote URL, Tailscale direct Core, remote bearer token entry, or device pairing.
- `coreRequest()` never tries browser fetch and then native IPC as a hidden fallback.
- Packaged Tauri chooses its Core transport explicitly.
- Browser/Vite development chooses browser fetch explicitly.
- Local-path attachment and native attachment conversion still work.
- Core no longer accepts paired device tokens.
- Core no longer exposes pairing/device management endpoints, or those endpoints are explicitly removed from the client and docs if left temporarily behind a deprecation window.
- Docs describe only local and SSH connection models.
- SSH remains the only supported remote access path.

## Open Questions

- Should Core still support `IRIS_TOKEN` for low-level operator use when explicitly bound to non-loopback, or should non-loopback binding fail fast?
- Do we want an internal owner secret for packaged managed-local Core to protect against other local processes, or is loopback-only enough for now?
- Should `core_bridge.py` remain Python, or should generic native Core requests move into Rust while Python keeps only attachment/media helpers?
- Is `docs/communication-map.html` generated from a source file, or should it be edited manually during this cleanup?
