# Iris token consolidation and legacy AgentUI purge - revised implementation plan

## Goal

End state:

1. `IRIS_TOKEN` is the only Iris-owned bearer secret exposed to users.
2. Same-machine loopback development remains zero-config: if Core, Desktop, and the Hermes `iris-platform` plugin communicate over loopback URLs, `IRIS_TOKEN` may be unset and auth headers are omitted.
3. Non-loopback Core or plugin traffic requires `IRIS_TOKEN`.
4. Core discovers the Hermes Jobs API token from `HERMES_API_TOKEN` first, then `$HERMES_HOME/.env` `API_SERVER_KEY`. Remove `HERMES_REMOTE_TOKEN`.
5. Delete `/v1/inbox/*` compatibility routes. `iris-platform` uses `POST /v1/runtime-deliveries/hermes` and probes `GET /v1/health`.
6. Remove legacy `agentui` naming from source files, symbols, metadata keys, source strings, env-var fallbacks, docs, and tests outside `.plans/`.
7. Keep architecture clean. This is pre-launch, single-user local software. No migration shims, deprecation warnings, or backwards-compatibility fallbacks unless explicitly called out below.

## Decisions From Review

- Keep the original product requirement that `IRIS_TOKEN` is optional on default loopback.
- Implement that requirement explicitly instead of relying on current behavior.
- For remote or non-loopback use, `IRIS_TOKEN` is required and is used for Desktop/Core auth, Core/plugin outbound calls, and plugin/Core runtime deliveries.
- Keep the keychain service and account names:
  - service: `Iris Desktop`
  - account: `iris-core-token`
- Keep paired device tokens with the `agui_` prefix. The prefix is user/token shape, not an AgentUI compatibility namespace.
- Remove the legacy paired-device hash format `sha256("agentui-core-device:{token}")`.
- Keep Hermes-owned `API_SERVER_KEY`. Do not rename it.
- Keep `IRIS_BASE_URL` and `IRIS_TO_HERMES_URL`; these are current Iris names and not token fallbacks.
- Remove old installed `agentui-platform` plugin manually during verification, not through a permanent source-code compatibility path.

## Current Repo Evidence

Core token and env behavior:

- `iris-core/src/hermes_management_server/main.py:328-342` reads `IRIS_CORE_TOKEN`, `HERMES_MGMT_TOKEN`, `IRIS_INBOX_TOKEN`, `AGENTUI_INBOX_TOKEN`, `IRIS_RUNTIME_DELIVERY_TOKEN`, `AGENTUI_RUNTIME_DELIVERY_TOKEN`, `IRIS_CORE_STORE`, `AGENTUI_CORE_STORE`, and `HERMES_MGMT_CORS_ORIGINS`.
- `main.py:373-383` has `agentui_platform_token()` with `IRIS_TOKEN`, `AGENTUI_TOKEN`, `IRIS_INBOX_TOKEN`, and `AGENTUI_INBOX_TOKEN` fallback chains.
- `main.py:386-392` already reads `API_SERVER_KEY` from `$HERMES_HOME/.env`; the plan should clean and log this path, not invent it.
- `main.py:772-787` wires `platform_token` into `RuntimeRegistry(agentui_token=...)` and `hermes_api_token(...)`.
- `security.py:51-61` already allows unauthenticated loopback requests only when no app token is configured and no credentials are sent.

Inbox compatibility:

- `/v1/inbox/health`, `POST /v1/inbox/messages`, `GET /v1/inbox/messages`, and `POST /v1/inbox/messages/{id}/ack` are defined in `main.py:908-950`.
- Inbox helper functions live around `main.py:2047-2160`.
- Inbox models live in `iris-core/src/hermes_management_server/models.py:77-103`.
- `require_inbox_auth` is a local closure in `main.py:830-831`; it is not exported from `security.py`.

Core/plugin auth:

- `iris-platform/adapter.py:157-164` currently refuses to connect without both `IRIS_BASE_URL` and a token, then probes `/v1/inbox/health`.
- `iris-platform/http_client.py:29-33` always sends `Authorization: Bearer {self.token}`, even when the token is empty.
- `iris-platform/adapter.py:502-504`, `624-626`, `686-688`, and `694-696` reject inbound Hermes-gateway calls if `self.token` is empty.
- `iris-core/src/hermes_management_server/runtime_adapters/hermes.py:484-485`, `552-578` refuses chat, model catalog, slash-command discovery, and slash completion without a token.
- Core's `http_json()` and `http_multipart()` already omit `Authorization` when `token` is empty.

Naming surfaces:

- Runtime adapter Python names include `DEFAULT_AGENTUI_GATEWAY_URL`, `AGENTUI_GATEWAY_PORT_OFFSET`, `agentui_multipart_attachments`, `agentui_payload_attachment`, `agentui_gateway_url`, and `derive_agentui_gateway_url` in `runtime_adapters/hermes.py`.
- `request.state.agentui_device` is written in `security.py` and read in `main.py` and `attachment_routes.py`.
- Wire metadata currently includes `agentuiSessionId`, `agentuiAdapter`, and `agentuiGatewayUrls`.
- Desktop reads `agentuiSessionId` in `apps/desktop/src/App.tsx` and `apps/desktop/src/features/automations/AutomationsView.tsx`.
- Desktop status mapping uses `agentuiAdapter` in `apps/desktop/src/lib/agentuiCore.ts`.
- Desktop helper `coreLegacyCompat.ts` is still used by `irisRuntime.ts`, `useIrisChat.ts`, and `useIrisProjects.ts`.
- `apps/desktop/src/features/chat/chatSessionState.ts` still checks `agentuiMessageId`.
- `iris-platform/adapter_config.py` contains `API_TO_AGENTUI_PORT_OFFSET`.
- `scripts/install-iris-platform.mjs` still contains a legacy installed-plugin cleanup reference for `agentui-platform`.

Settings UI:

- `apps/desktop/src/features/settings/SettingsView.tsx:172-175` labels the Core token field as `Token`; desired copy is `Iris token`.

## Implementation Plan

### Phase 1 - Token source of truth and loopback no-token behavior

1. In `iris-core/src/hermes_management_server/main.py`, update `Settings.from_env()`:
   - `host`: use only `IRIS_CORE_HOST` or default `127.0.0.1`.
   - `port`: use only `IRIS_CORE_PORT` or default `8765`.
   - `token`: use only `IRIS_TOKEN`.
   - Remove `inbox_token` from `Settings`.
   - `runtime_delivery_token`: remove as a separately configured setting unless a strong current code reason appears during implementation. Runtime deliveries should use the resolved `IRIS_TOKEN`.
   - `core_store_path`: use only `IRIS_CORE_STORE`.
   - `cors_origins`: use only `IRIS_CORE_CORS_ORIGINS`.

2. Rename `agentui_platform_token()` to `iris_token()`:
   - Return `os.environ.get("IRIS_TOKEN", "").strip()` first.
   - Then return `env_file_value("$HERMES_HOME/.env", "IRIS_TOKEN")`.
   - Do not read `AGENTUI_TOKEN`, `IRIS_INBOX_TOKEN`, or `AGENTUI_INBOX_TOKEN`.

3. In `create_app()`:
   - Compute `resolved_iris_token = app_settings.token or iris_token(hermes_root)`.
   - Set `app.state.management_token = resolved_iris_token`.
   - Set `app.state.runtime_delivery_token = resolved_iris_token`.
   - Remove `app.state.inbox_token`.
   - Remove `require_inbox_auth`.
   - Pass `iris_token=resolved_iris_token` into `RuntimeRegistry`.

4. Replace `hermes_api_token()` with clean behavior:
   - Env override: `HERMES_API_TOKEN`.
   - Fallback: `$HERMES_HOME/.env` `API_SERVER_KEY`.
   - Remove `HERMES_REMOTE_TOKEN` env and `.env` fallbacks.
   - Log exactly one warning when no Jobs API token is available. Include the path and field name, for example: `HERMES_API_TOKEN not set and {hermes_env_path} has no API_SERVER_KEY; automation routes will return 503 when Hermes requires Jobs API auth.`
   - Do not log this repeatedly per request.

5. In `iris-core/src/hermes_management_server/runtime_registry.py`:
   - Rename constructor kwarg and instance field `agentui_token` to `iris_token`.
   - Pass `iris_token=self.iris_token` to `HermesRuntimeAdapter`.

6. In `iris-core/src/hermes_management_server/runtime_adapters/hermes.py`:
   - Rename `agentui_token` parameter to `iris_token`.
   - Prefer the passed `iris_token`.
   - Remove `AGENTUI_TOKEN`, `HERMES_REMOTE_TOKEN`, and ambient env fallbacks from the adapter constructor.
   - Keep `hermes_api_token` as the passed Core-resolved value.

7. Add a helper in Core runtime adapter for no-token loopback decisions:
   - Example shape: `url_is_loopback(url: str) -> bool`.
   - Treat `localhost`, `127.0.0.1`, and `::1` as loopback.
   - For `send_message()`, `models()`, `slash_commands()`, and `slash_complete()`, allow empty `self.token` only when the target plugin URL is loopback.
   - If token is empty and target is not loopback, return a clear error: `IRIS_TOKEN is required for non-loopback Iris gateway ...`.
   - Update old error messages that mention `AGENTUI_TOKEN`.

8. In `iris-platform/http_client.py`:
   - Only add `Authorization` when `self.token` is non-empty.

9. In `iris-platform/adapter.py`, implement plugin-side loopback token policy:
   - Read `IRIS_BASE_URL` only. Drop `AGENTUI_BASE_URL`.
   - Read `IRIS_TOKEN` only. Drop `AGENTUI_TOKEN`.
   - If `IRIS_BASE_URL` is missing, fail config.
   - If `IRIS_BASE_URL` is non-loopback and `IRIS_TOKEN` is missing, fail config.
   - If `IRIS_BASE_URL` is loopback and `IRIS_TOKEN` is missing, allow connect and omit auth headers.
   - Change startup probe from `GET /v1/inbox/health` to `GET /v1/health`.
   - Update `check_requirements()` and `validate_config()` with the same loopback rule.

10. In `iris-platform/adapter.py`, update inbound route auth:
    - If `self.token` exists, require `Authorization: Bearer {token}`.
    - If `self.token` is empty, allow only loopback callers.
    - Add a small helper for request remote-host loopback detection.
    - Keep non-loopback inbound traffic token-protected.

11. Remove plugin env fallbacks beyond token/base URL:
    - `AGENTUI_INBOUND_HOST`
    - `AGENTUI_INBOUND_PORT`
    - `AGENTUI_DEFAULT_CHAT_ID`
    - `AGENTUI_ALLOWED_USERS`
    - `AGENTUI_ALLOW_ALL_USERS`
    - Remove `sync_env_alias()` if no longer used.

12. Update `scripts/dev.mjs`:
    - `coreHost = process.env.IRIS_CORE_HOST ?? "127.0.0.1"`.
    - `corePort = process.env.IRIS_CORE_PORT ?? "8765"`.
    - `irisToken = process.env.IRIS_TOKEN || ""`.
    - `hermesApiToken = process.env.HERMES_API_TOKEN || readEnvFileValue(hermesEnvPath, "API_SERVER_KEY")`.
    - Export only current names:
      - `IRIS_CORE_HOST`
      - `IRIS_CORE_PORT`
      - `IRIS_CORE_API_URL`
      - `IRIS_CORE_STORE` when already set
      - `HERMES_HOME`
      - `IRIS_TOKEN` when present
      - `HERMES_API_TOKEN` when discovered/present
    - Remove `HERMES_MGMT_HOST`, `HERMES_MGMT_PORT`, `IRIS_INBOX_TOKEN`, `AGENTUI_*`, `IRIS_CORE_TOKEN`, `HERMES_MGMT_TOKEN`, and `HERMES_REMOTE_TOKEN` cascades.

13. Update CLI help in `main.py`:
    - Host help should mention `IRIS_CORE_HOST`.
    - Port help should mention `IRIS_CORE_PORT`.
    - Remove `HERMES_MGMT_*` wording.

### Phase 2 - Delete `/v1/inbox/*` routes and inbox compatibility helpers

1. Delete these route handlers from `main.py`:
   - `GET /v1/inbox/health`
   - `POST /v1/inbox/messages`
   - `GET /v1/inbox/messages`
   - `POST /v1/inbox/messages/{message_id}/ack`

2. Delete inbox-only app state:
   - `app.state.inbox_acknowledged_at`
   - `app.state.inbox_token`

3. Delete inbox-only helpers from `main.py` unless an implementation pass finds a non-inbox caller:
   - `inbox_message_from_payload`
   - `mirror_inbox_message_to_core`
   - `inbox_message_from_event`
   - `inbox_message_for_id`

4. Delete inbox-only models from `models.py`:
   - `InboxHealthResponse`
   - `InboxMessageCreateRequest`
   - `InboxMessage`
   - `InboxMessageResponse`
   - `InboxMessagesResponse`

5. Remove imports of deleted models/functions.

6. Add or update a Core test asserting deleted inbox routes return 404:
   - `GET /v1/inbox/health`
   - `POST /v1/inbox/messages`

7. Delete old tests whose only purpose was validating `/v1/inbox/*` behavior:
   - `test_inbox_accepts_lists_and_acknowledges_messages_without_sqlite`
   - `test_inbox_auth_accepts_configured_hermes_env_agentui_token`
   - `test_inbox_preserves_stream_update_events_append_only`
   - `test_legacy_inbox_delivery_publishes_live_event_without_core_transcript`
   - `test_legacy_inbox_stream_and_completed_replays_remain_live_only`

### Phase 3 - Device auth and keychain cleanup

1. In `security.py`:
   - Delete `legacy_device_token_hash()`.
   - Delete the fallback lookup using the legacy hash.
   - Rename `request.state.agentui_device` to `request.state.iris_device`.

2. Update all state readers:
   - `main.py` device endpoints currently use `request.state.agentui_device`.
   - `attachment_routes.py` uses it for `owner_device_id`.
   - Any new `rg "agentui_device"` hits must be renamed.

3. In `apps/desktop/src-tauri/python/core_bridge.py`:
   - `read_env_token()` should read only `IRIS_TOKEN`.
   - Remove `IRIS_CORE_TOKEN` and `AGENTUI_TOKEN` env fallbacks.
   - Remove fallback keychain read from `LEGACY_CORE_TOKEN_ACCOUNT`.
   - Remove the old `sidecar` credential kind path.
   - Keep `IRIS_CORE_TOKEN_ACCOUNT = "iris-core-token"` and the `Iris Desktop` service.
   - Simplify `credential_kind()` or remove it if all callers pass `"core"`.

4. Update `apps/desktop/src-tauri/python/tests/test_core_bridge.py`:
   - Remove the sidecar-kind compatibility assertion.
   - Add an env-token test proving `IRIS_TOKEN` is read.
   - Add a negative test proving `IRIS_CORE_TOKEN`/`AGENTUI_TOKEN` are ignored, if practical without making tests brittle.

5. In `apps/desktop/src/features/settings/SettingsView.tsx`:
   - Change token field label from `Token` to `Iris token`.
   - Preserve the current keychain read/write behavior and account.

### Phase 4 - Wire protocol and runtime metadata rename

1. In Core event/send metadata:
   - `agentuiSessionId` -> `irisSessionId`
   - `agentui-core-send` -> `iris-core-send`
   - `agentui-core-events` -> `iris-core-events`
   - `platform: "agentui"` -> `platform: "iris"` for any surviving non-inbox data shape.

2. Update desktop consumers in lock-step:
   - `apps/desktop/src/App.tsx` should read `irisSessionId`.
   - `apps/desktop/src/features/automations/AutomationsView.tsx` should match `irisSessionId`.
   - `apps/desktop/src/features/chat/chatSessionState.ts` should replace or remove `agentuiMessageId`. Preferred key is `irisMessageId` only if Core still emits such a field; otherwise remove the legacy fallback.
   - Desktop test fixtures should use `iris-core`, `iris-core-send`, `iris-core-events`, and `irisSessionId`.

3. Runtime probe shape:
   - In `hermes.py`, `agentuiAdapter` -> `irisAdapter`.
   - In `apps/desktop/src/lib/agentuiCore.ts` or the renamed file, `CoreRuntimeProbe` should use `irisAdapter`.
   - Update `activeApiStatus` mapping and fallback probe object.

4. Runtime connection config:
   - `agentuiGatewayUrls` -> `irisGatewayUrls`.
   - `agentui_gateway_url()` -> `iris_gateway_url()`.
   - `derive_agentui_gateway_url()` -> `derive_iris_gateway_url()`.
   - `DEFAULT_AGENTUI_GATEWAY_URL` -> `DEFAULT_IRIS_GATEWAY_URL`.
   - `AGENTUI_GATEWAY_PORT_OFFSET` -> `IRIS_GATEWAY_PORT_OFFSET`.
   - `agentui_multipart_attachments()` -> `iris_multipart_attachments()`.
   - `agentui_payload_attachment()` -> `iris_payload_attachment()`.

5. Default user/platform naming:
   - `user_id: "agentui-user"` -> `"iris-user"` in Core runtime adapter and plugin default handling.
   - Update docs/tests that mention `agentui-user`.
   - Verify `iris-platform/adapter.py` does not compare against the old value before changing.

6. Automations delivery target:
   - Remove `agentui:` normalization in `apps/desktop/src/features/automations/useIrisAutomations.ts`.
   - Keep `iris:` as the only delivery prefix.
   - Update tests that expected `agentui:` to normalize.

### Phase 5 - TypeScript module and symbol rename

1. Rename:
   - `apps/desktop/src/lib/agentuiCore.ts` -> `apps/desktop/src/lib/irisCore.ts`
   - `apps/desktop/src/lib/__tests__/agentuiCore.test.ts` -> `apps/desktop/src/lib/__tests__/irisCore.test.ts`

2. Rename exported TS types/functions:
   - `AgentUICore*` -> `IrisCore*`
   - `getAgentUICore*` -> `getIrisCore*`
   - `createAgentUICore*` -> `createIrisCore*`
   - `sendAgentUICoreMessage` -> `sendIrisCoreMessage`
   - `cancelAgentUICoreMessage` -> `cancelIrisCoreMessage`
   - `uploadAgentUICoreAttachment` -> `uploadIrisCoreAttachment`
   - `agentUICoreAttachmentUrl` -> `irisCoreAttachmentUrl`
   - `agentUICoreEventStreamUrl` -> `irisCoreEventStreamUrl`

3. Update all desktop imports with `rg "agentuiCore|AgentUICore|agentUICore"`:
   - `apps/desktop/src/lib/irisRuntime.ts`
   - `apps/desktop/src/features/chat/*`
   - `apps/desktop/src/features/automations/*`
   - `apps/desktop/src/features/projects/useIrisProjects.ts`
   - `apps/desktop/src/layout/*`
   - `apps/desktop/src/app/__tests__/projectSessions.test.ts`
   - `apps/desktop/src/lib/__tests__/*`
   - Any new hits.

4. Delete `apps/desktop/src/lib/coreLegacyCompat.ts`.

5. Replace `coreLegacyCompat.ts` exports:
   - `coreSessionToLegacy`
   - `coreMessageToLegacy`
   - `coreEventToInboxMessage`
   - Preferred destination: a non-legacy module such as `apps/desktop/src/lib/irisCoreMappings.ts` if more than one consumer remains.
   - If a helper has only one consumer after cleanup, inline it.
   - Use current Iris source/platform strings in returned objects.

6. Update `apps/desktop/src/lib/irisRuntime.ts` export that currently re-exports `coreEventToInboxMessage`.

### Phase 6 - Plugin install cleanup and source grep gate

1. Remove permanent legacy cleanup from `scripts/install-iris-platform.mjs`:
   - Delete `legacyPluginName`.
   - Delete removal of `agentui-platform`.
   - Keep install/enable of `iris-platform`.

2. Add the old plugin removal as a manual verification step instead:
   - Confirm with user before running:
     - `rm -rf ~/.hermes/plugins/agentui-platform`
     - `find ~/.hermes/profiles -path '*/plugins/agentui-platform' -type d -prune -print`
   - If old profile plugin directories exist, remove them after confirmation.

3. Rename `iris-platform/adapter_config.py`:
   - `API_TO_AGENTUI_PORT_OFFSET` -> `API_TO_IRIS_PORT_OFFSET`.

4. Run a case-insensitive source grep gate before finishing implementation:

```bash
rg -n -i "agentui" \
  --glob '*.py' \
  --glob '*.ts' \
  --glob '*.tsx' \
  --glob '*.rs' \
  --glob '*.mjs' \
  --glob '*.json' \
  --glob '*.md' \
  --glob '*.yaml' \
  --glob '!node_modules/**' \
  --glob '!.venv/**' \
  --glob '!package-lock.json' \
  --glob '!.plans/**'
```

Expected result: no hits. If a hit appears in generated or historical material that must remain, document it explicitly before accepting.

### Phase 7 - Tests and docs

1. Core tests in `iris-core/tests/test_api.py`:
   - Replace `.env` fixtures that set `AGENTUI_TOKEN` with `IRIS_TOKEN`.
   - Replace expected metadata `agentuiSessionId` with `irisSessionId`.
   - Replace source strings with `iris-core-send` / `iris-core-events`.
   - Delete inbox-route tests listed in Phase 2.
   - Add 404 tests for deleted inbox routes.
   - Add a Jobs API token test for current behavior:
     - With only `$HERMES_HOME/.env` `API_SERVER_KEY`, automation/jobs requests use that token.
   - Add no-token loopback tests:
     - Core accepts loopback unauthenticated requests when `IRIS_TOKEN` is empty and no auth header is sent.
     - Runtime adapter allows loopback plugin calls with empty token.
   - Add non-loopback token-required tests where feasible without network flakiness by testing helper/config behavior.

2. Plugin tests in `iris-platform/tests/test_adapter.py`:
   - Update env names.
   - Add loopback/no-token validation behavior.
   - Add non-loopback/missing-token validation failure.
   - Add `/v1/health` startup probe expectation.

3. Desktop tests:
   - Update renamed imports and types.
   - Update source strings and metadata keys.
   - Update automation delivery prefix tests to reject/remove `agentui:` normalization.
   - Update settings/token label snapshots or DOM assertions if present.

4. Docs:
   - `README.md`
   - `iris-core/README.md`
   - `iris-platform/README.md`
   - `apps/desktop/README.md`
   - `apps/desktop/docs/production-readiness.md`
   - `CLAUDE.md`
   - `docs/communication-map.html`

5. Documentation content should state:
   - Local loopback can run with no `IRIS_TOKEN`.
   - Remote/non-loopback requires `IRIS_TOKEN`.
   - `HERMES_API_TOKEN` is optional override; Core normally discovers `API_SERVER_KEY` from `$HERMES_HOME/.env`.
   - `/v1/inbox/*` is gone.
   - Hermes gateway restart is required after plugin reinstall.
   - Fresh chat/session is required to validate new metadata/source strings.

## Verification Plan

During implementation:

```bash
iris-core/.venv/bin/python -m pytest iris-core/tests/test_api.py -k "not inbox" -x
npm --workspace apps/desktop run test -- src/lib/__tests__/irisCore.test.ts
npm --workspace apps/desktop run test:bridge
```

After major renames:

```bash
npm run check
```

Visible UI check:

1. Use the existing `npm run dev` session if it is already running.
2. Open the Vite surface in the Browser plugin at `http://localhost:1420/`.
3. Verify Settings shows `Iris token`.
4. Verify normal chat UI still loads without obvious console/runtime errors.

Runtime integration:

1. Reinstall plugin:

```bash
npm run iris:hermes:install
```

2. Restart Hermes gateway so it loads the renamed plugin.
3. Restart Iris Core or `npm run dev` so Core loads the new token/env behavior.
4. If user confirms scorched-earth cleanup:

```bash
rm ~/.iris/core.sqlite3
rm -rf ~/.hermes/plugins/agentui-platform
find ~/.hermes/profiles -path '*/plugins/agentui-platform' -type d -prune -print
```

Remove any printed profile plugin directories only after confirmation.

5. Fresh chat smoke:
   - Start a fresh chat.
   - Send a message.
   - Confirm SSE events arrive through `/v1/events/stream`.
   - Confirm event metadata uses `irisSessionId` and `iris-core-*` source strings.

6. Automation smoke:
   - Create an automation that runs now.
   - Confirm runtime delivery reaches `POST /v1/runtime-deliveries/hermes`.
   - Confirm the delivery appears in the Sessions/sidebar path.

7. Final packaged desktop verification because this touches Tauri bridge/keychain and Settings UI:

```bash
npm run build:mac:app
```

Then launch the fresh bundle and test against `com.nousresearch.hermes-agent.desktop` with Computer Use.

Final grep gate:

```bash
rg -n -i "agentui" \
  --glob '*.py' \
  --glob '*.ts' \
  --glob '*.tsx' \
  --glob '*.rs' \
  --glob '*.mjs' \
  --glob '*.json' \
  --glob '*.md' \
  --glob '*.yaml' \
  --glob '!node_modules/**' \
  --glob '!.venv/**' \
  --glob '!package-lock.json' \
  --glob '!.plans/**'
```

Expected result: no hits.

## Acceptance Criteria

- Fresh local setup can run Core/Desktop/plugin over loopback with no token.
- Remote or non-loopback setup requires only `IRIS_TOKEN` for Iris-owned auth.
- No code path reads or exports `AGENTUI_*`.
- No code path reads `IRIS_INBOX_TOKEN`, `IRIS_CORE_TOKEN`, `HERMES_MGMT_TOKEN`, or `HERMES_REMOTE_TOKEN`.
- No startup path reads `HERMES_MGMT_HOST`, `HERMES_MGMT_PORT`, or `HERMES_MGMT_CORS_ORIGINS`.
- `/v1/inbox/*` routes return 404.
- Settings UI shows `Iris token`.
- Chat, attachment, model catalog, slash command, project, automation, and runtime delivery flows pass tests and smoke checks.
- Case-insensitive `agentui` grep returns no hits outside `.plans/` and ignored generated/dependency files.

## Restart Requirements To Communicate After Implementation

- Existing `npm run dev` must be restarted for Core/env changes.
- Hermes gateway must be restarted after `npm run iris:hermes:install`.
- Existing chats/sessions can contain old persisted metadata; validate with a fresh chat.
- If the local Core SQLite file is not removed, old rows may still contain legacy source strings even though new writes are clean.
