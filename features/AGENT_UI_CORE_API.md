# Iris Core API Implementation Plan

## Source-Of-Truth Correction

This plan is superseded where it implies that Core owns or persists Hermes
profiles, conversations, messages, transcript events, or jobs. See
`features/HERMES_SOURCE_OF_TRUTH.md` for the corrective implementation: Core is
the normalized API facade, while Hermes remains the source of truth for
Hermes-owned records. Core SQLite now keeps only Core-owned tables such as
`schema_meta`, `devices`, `runtimes`, and `device_cursors`; live delivery events
are process-local and best effort.

## Goal

Create an Iris Core API that becomes the stable control plane for Iris clients.

The desktop app should stop being the place where Hermes routing, inbox cursors,
conversation mapping, profile isolation, stream merging, job delivery, and
runtime-specific behavior all come together. Those responsibilities should move
behind a versioned HTTP API that desktop can use now and a future mobile app can
use later.

The first production version should run Iris Core on the same machine where
Hermes is installed. Treat that machine as the agent host:

```text
Agent host
  - Iris Core API
  - Hermes gateway
  - Hermes profiles, memory, skills, state, and jobs
  - Iris Hermes platform adapter

Clients
  - Iris desktop app
  - Future Iris mobile app
  - Future web or CLI clients
```

For local development, Core runs locally from this repo. For production, Core
should be installed as a durable local service beside Hermes. Remote clients
should connect over a private network such as Tailscale with bearer auth, not
through public port forwarding.

## Product Direction

Iris should own the user-facing product model:

- Agents/profiles.
- Conversations.
- Messages and live events.
- Automations.
- Devices.
- Runtime configuration.
- Memory and skill management surfaces.
- Permissions and audit history.

Hermes should be the first runtime adapter underneath that model. It is not the
long-term source of truth for the whole app. The UI should not be forced to think
in Hermes API ports, Hermes profile folders, SQLite schemas, or gateway platform
details.

## Non-Goals

- Do not build the mobile app in this phase.
- Do not expose the Core API directly to the public internet.
- Do not require a cloud backend for the first production path.
- Do not modify Hermes core for the first pass.
- Do not make every runtime abstraction perfect before moving desktop chat onto
  Core.
- Do not remove existing Hermes-specific paths until Core has replacement
  behavior and tests.

## Current Code Paths

Desktop bridge facade:

- `desktop/src/lib/hermes.ts`
  - Wraps Tauri `invoke("hermes_bridge", ...)`.
  - Exposes profile, memory, skill, conversation, model, slash command, job,
    inbox, and gateway chat helpers.

Tauri native bridge:

- `desktop/src-tauri/src/lib.rs`
  - Registers `hermes_bridge`, `hermes_stream_message`, and
    `hermes_cancel_message`.
  - Spawns `desktop/src-tauri/python/hermes_bridge.py` for almost every Hermes
    operation.

Python bridge:

- `desktop/src-tauri/python/hermes_bridge.py`
  - Resolves profile-specific API URLs.
  - Calls the management sidecar.
  - Calls Hermes gateway Jobs API.
  - Calls the Iris platform adapter inbound endpoints.
  - Still contains legacy direct `/responses` and `/chat/completions` paths.
  - Stores remote credentials through environment, keychain, or test file.

Management sidecar:

- `sidecar/src/hermes_management_server/main.py`
  - FastAPI app that exposes profile, memory, skill, status, conversation, and
    inbox endpoints.

- Legacy `/v1/inbox/*` routes
  - Now in-memory compatibility facades over live delivery events. See
    `features/REMOVE_INBOX_SQLITE.md`.

- `sidecar/src/hermes_management_server/conversations.py`
  - Schema-tolerant, read-only Hermes conversation discovery.

Hermes platform adapter:

- `agentui-platform/adapter.py`
  - Registers the `agentui` platform inside Hermes.
  - Receives Iris messages at `/agentui/messages`.
  - Delivers Hermes responses back to Iris through
    `/v1/runtime-deliveries/hermes`; `/v1/inbox/messages` remains a
    memory-only compatibility facade for older/manual delivery calls.
  - Exposes model and slash command catalog endpoints in the Hermes runtime
    process.

Desktop chat state:

- `desktop/src/features/chat/useHermesChat.ts`
  - Owns optimistic conversation IDs.
  - Owns Iris chat IDs.
  - Polls inbox messages.
  - Merges stream updates into assistant bubbles.
  - Tracks active requests.
  - Refreshes Hermes conversation history.

This hook is the main pressure point. Most of that logic belongs in Iris Core
so desktop and mobile can share behavior.

## Target Architecture

```text
Iris desktop / future mobile
  -> Iris Core client SDK
  -> Iris Core API
  -> Runtime adapters
       -> Hermes adapter
       -> future local/custom runtime adapter
       -> future cloud/provider adapters
```

Core should be a local-first service with a stable HTTP contract. It can start
as the existing `sidecar/` FastAPI app evolved in place, but its product role
should change from "Hermes management sidecar" to "Iris Core".

The desktop app can continue to launch Core during local development and
single-machine production. A headless install should be possible for an agent
host that serves desktop and mobile clients over Tailscale.

## Runtime Placement

### Local Development

Default shape:

```text
npm run dev
  -> starts Iris Core on 127.0.0.1:8765
  -> starts/uses Hermes gateway
  -> starts Tauri desktop app
```

The dev script can keep using the existing `sidecar/.venv/bin/hermes-sidecar`
binary at first. Rename only when the API and package direction are clear.

### Production V1

Core should run on the Hermes machine:

```text
Mac or server with Hermes installed
  - Iris Core: http://127.0.0.1:8765 by default
  - Hermes default gateway: usually http://127.0.0.1:8642
  - Named Hermes gateways: profile-specific ports
  - Iris adapter inbound listeners: profile-specific ports
```

Desktop on the same machine can connect to `127.0.0.1`. Mobile or another
desktop should connect to the Core service through Tailscale or a private LAN
address.

Do not make the mobile app read Hermes files, open Hermes SQLite, infer gateway
ports, or talk to `agentui-platform` directly.

### Future Remote Runtime Support

Core should not permanently require Hermes to be local. Model the Hermes machine
as one runtime host:

```json
{
  "id": "runtime_...",
  "kind": "hermes",
  "name": "Scott's Mac Studio",
  "baseUrl": "http://127.0.0.1:8642",
  "managementUrl": "http://127.0.0.1:8765",
  "network": "local"
}
```

Later, a Core instance could control a remote Hermes runtime, a custom runtime,
or a provider-hosted runtime through the same adapter interface.

## Core Responsibilities

Iris Core should own:

- Stable conversation IDs.
- Mapping from Iris conversation IDs to Hermes session IDs and Hermes
  gateway chat IDs.
- Message/event ordering.
- Stream update merging.
- Inbox/delivery idempotency.
- Device-specific cursors.
- Runtime and profile routing.
- Model and slash command catalogs.
- Job/automation records.
- Profile-scoped memory and skills API.
- Auth for desktop, mobile, and future clients.
- Service health, runtime probes, and diagnostics.

Core should not own:

- Hermes internal execution.
- Provider API keys beyond secure references/tokens needed to talk to runtimes.
- Public cloud sync in the first implementation.
- Native desktop menus, tray, or OS window behavior.

## Core Data Model

Use SQLite for the first implementation. Suggested default path:

```text
~/.agent-ui/core.sqlite3
```

Keep Hermes state separate. Core can read Hermes through adapters, but Core
should not write directly into Hermes stores except through supported Hermes
interfaces or already-approved profile file operations.

### `devices`

Tracks clients that can call Core.

```text
id text primary key
name text not null
kind text not null              -- desktop, mobile, cli, web
token_hash text not null
created_at integer not null
last_seen_at integer
revoked_at integer
metadata_json text not null
```

### `runtimes`

Tracks configured runtime hosts.

```text
id text primary key
kind text not null              -- hermes, custom, openai, anthropic, local
name text not null
connection_json text not null
enabled integer not null default 1
created_at integer not null
updated_at integer not null
last_probe_json text not null
```

For Hermes, `connection_json` should include:

```json
{
  "gatewayUrl": "http://127.0.0.1:8642",
  "managementUrl": "http://127.0.0.1:8765",
  "agentuiGatewayUrls": {
    "default": "http://127.0.0.1:8766",
    "health": "http://127.0.0.1:8767"
  }
}
```

Avoid implicit port math as the source of truth. It is fine as a migration helper
or auto-discovery fallback.

### `agents`

Iris-facing agent/profile records.

```text
id text primary key
runtime_id text not null
runtime_kind text not null
display_name text not null
runtime_profile text not null
is_default integer not null default 0
created_at integer not null
updated_at integer not null
metadata_json text not null
```

For Hermes, `runtime_profile` maps to `default`, `health`, or another Hermes
profile name.

### `conversations`

Iris-owned conversations.

```text
id text primary key
agent_id text not null
title text not null
summary text not null default ''
created_at integer not null
updated_at integer not null
archived_at integer
metadata_json text not null
```

### `conversation_runtime_links`

Maps Iris conversations to runtime-specific identifiers.

```text
conversation_id text not null
runtime_id text not null
runtime_profile text not null
external_session_id text
external_chat_id text
external_thread_id text
origin_json text not null
created_at integer not null
updated_at integer not null
primary key (conversation_id, runtime_id)
```

For Hermes gateway/platform routing, `external_chat_id` is the durable Iris
chat ID passed into the Hermes `agentui` platform adapter. `external_session_id`
is the Hermes session ID once known.

### `message_events`

Append-only event log. This is the heart of mobile readiness.

```text
cursor integer primary key autoincrement
id text unique not null
conversation_id text not null
agent_id text not null
runtime_id text
type text not null
role text
content text not null default ''
parent_event_id text
external_message_id text
idempotency_key text
created_at integer not null
metadata_json text not null
```

Important event types:

```text
conversation.created
message.user.created
message.assistant.started
message.assistant.delta
message.assistant.updated
message.assistant.completed
message.tool.started
message.tool.updated
message.tool.completed
message.attachment.created
message.error
automation.created
automation.updated
automation.delivery.created
runtime.status.changed
```

Core can materialize current messages for fast reads, but the append-only event
log should be the sync source of truth.

### `conversation_messages`

Optional materialized current message view/table for fast transcript reads.

```text
id text primary key
conversation_id text not null
role text not null
content text not null
status text not null             -- pending, streaming, completed, error
created_at integer not null
updated_at integer not null
metadata_json text not null
```

This table can be rebuilt from `message_events` if needed.

### `automations`

Iris-owned automation records.

```text
id text primary key
agent_id text not null
runtime_id text not null
external_job_id text
name text not null
schedule_text text not null
prompt text not null
deliver_to_conversation_id text
status text not null
created_at integer not null
updated_at integer not null
last_run_at integer
next_run_at integer
metadata_json text not null
```

Hermes can still execute the job in v1. Iris should own the user-facing
automation record and map it to Hermes `job_id`.

### `device_cursors`

Tracks event replay position by client.

```text
device_id text not null
stream_name text not null         -- global, conversation:<id>, agent:<id>
last_cursor integer not null
updated_at integer not null
primary key (device_id, stream_name)
```

## API Contract

Use `/v1` for the first stable contract.

All responses should be JSON. Errors should use:

```json
{ "ok": false, "error": "Human readable error." }
```

All mutating requests should accept an optional idempotency key:

```http
Idempotency-Key: <client-generated-id>
```

This matters for mobile retries.

### Health

```http
GET /v1/health
GET /v1/status
```

`/health` is a lightweight process check. `/status` includes runtime probes,
active agent, storage path, version, and auth mode.

### Devices/Auth

```http
POST /v1/devices/pair
GET /v1/devices
DELETE /v1/devices/{device_id}
```

First implementation can use a manually configured bearer token. Still design
the endpoint shapes now so mobile pairing has a place to land later.

Pairing response:

```json
{
  "ok": true,
  "device": {
    "id": "device_...",
    "name": "Scott's iPhone",
    "kind": "mobile"
  },
  "token": "plain-token-shown-once"
}
```

### Runtimes

```http
GET /v1/runtimes
POST /v1/runtimes
GET /v1/runtimes/{runtime_id}
PATCH /v1/runtimes/{runtime_id}
POST /v1/runtimes/{runtime_id}/probe
```

The Hermes runtime adapter should expose probe details without leaking tokens:

```json
{
  "ok": true,
  "runtime": {
    "id": "runtime_local_hermes",
    "kind": "hermes",
    "name": "Local Hermes",
    "enabled": true
  },
  "probe": {
    "gateway": { "ok": true, "url": "http://127.0.0.1:8642" },
    "management": { "ok": true, "url": "http://127.0.0.1:8765" },
    "agentuiAdapter": { "ok": true, "profile": "default" }
  }
}
```

### Agents

```http
GET /v1/agents
POST /v1/agents
GET /v1/agents/{agent_id}
PATCH /v1/agents/{agent_id}
DELETE /v1/agents/{agent_id}
POST /v1/agents/{agent_id}/clone
POST /v1/agents/{agent_id}/activate
```

For Hermes, these map to profile list/create/clone/rename/delete/switch. Keep
the API product language as `agents`; keep Hermes profile names in runtime
metadata.

### Conversations

```http
GET /v1/conversations?agentId=<agent_id>&limit=80&cursor=<cursor>
POST /v1/conversations
GET /v1/conversations/{conversation_id}
GET /v1/conversations/{conversation_id}/messages
POST /v1/conversations/{conversation_id}/messages
POST /v1/conversations/{conversation_id}/cancel
```

Send message request:

```json
{
  "text": "send me a message in 10 minutes",
  "attachments": [],
  "model": {
    "provider": "openai-codex",
    "model": "gpt-5.5"
  },
  "clientMessageId": "uuid-from-client"
}
```

Send response:

```json
{
  "ok": true,
  "conversationId": "conv_...",
  "messageId": "msg_...",
  "accepted": true,
  "eventCursor": 1234
}
```

Core should create the Iris conversation ID before calling Hermes. The Hermes
adapter gets a durable `external_chat_id`, and Core records the mapping when the
Hermes session ID becomes available.

### Events

```http
GET /v1/events?after=<cursor>&limit=200
GET /v1/conversations/{conversation_id}/events?after=<cursor>&limit=200
GET /v1/events/stream?after=<cursor>
POST /v1/devices/{device_id}/cursors
```

Use SSE for the first live stream:

```text
event: message.assistant.delta
id: 1235
data: {"cursor":1235,"conversationId":"conv_...","content":"hello"}
```

Polling must remain available as fallback. Mobile can reconnect with the last
seen cursor.

### Automations

```http
GET /v1/automations?agentId=<agent_id>
POST /v1/automations
PATCH /v1/automations/{automation_id}
DELETE /v1/automations/{automation_id}
POST /v1/automations/{automation_id}/pause
POST /v1/automations/{automation_id}/resume
POST /v1/automations/{automation_id}/run
```

Core should translate Iris automations to Hermes jobs for the Hermes runtime.
Do not make the desktop app call Hermes Jobs API directly long term.

Create request:

```json
{
  "agentId": "agent_...",
  "name": "Reminder",
  "schedule": "10m",
  "prompt": "Reply exactly with this message: check the oven",
  "repeat": 1,
  "deliverToConversationId": "conv_..."
}
```

Hermes adapter behavior:

- Create a Hermes job through `/api/jobs`.
- Prefer `deliver="origin"` when the job was created from an Iris-origin
  conversation and Hermes has captured origin correctly.
- Fall back to `deliver="agentui:<external_chat_id>"` when needed.
- Store the Hermes `job_id` in `automations.external_job_id`.

### Models And Slash Commands

```http
GET /v1/agents/{agent_id}/models
GET /v1/agents/{agent_id}/slash-commands
POST /v1/agents/{agent_id}/slash-complete
```

Core should call the runtime adapter. For Hermes, the adapter can continue using
the `agentui-platform` endpoints:

- `/agentui/models`
- `/agentui/slash-commands`
- `/agentui/slash-complete`

The desktop app should call Core, not those adapter endpoints directly.

### Memory And Skills

```http
GET /v1/agents/{agent_id}/memory
PUT /v1/agents/{agent_id}/memory/{file}
POST /v1/agents/{agent_id}/memory/{file}/reset
GET /v1/agents/{agent_id}/skills
GET /v1/agents/{agent_id}/skills/{skill_id}
PUT /v1/agents/{agent_id}/skills/{skill_id}
```

Maintain existing safety rules:

- No arbitrary file paths from clients.
- Profile names and skill IDs must be validated.
- Reads and writes must stay inside the selected runtime profile.
- Secrets should not be returned to clients.

## Hermes Runtime Adapter

Create an internal adapter interface inside Core. Python sketch:

```py
class RuntimeAdapter(Protocol):
    kind: str

    def probe(self) -> dict: ...
    def list_agents(self) -> list[dict]: ...
    def get_agent(self, agent_id: str) -> dict: ...
    def send_message(self, conversation: dict, message: dict) -> dict: ...
    def cancel_message(self, conversation: dict) -> dict: ...
    def list_conversations(self, agent_id: str) -> list[dict]: ...
    def get_conversation_messages(self, conversation_id: str) -> list[dict]: ...
    def list_automations(self, agent_id: str) -> list[dict]: ...
    def create_automation(self, automation: dict) -> dict: ...
    def list_models(self, agent_id: str) -> dict: ...
    def list_slash_commands(self, agent_id: str) -> dict: ...
```

Hermes adapter responsibilities:

- Resolve the Hermes profile for an Iris agent.
- Probe the Hermes management API and gateway.
- Send normal chat through the `agentui` platform path.
- Receive Hermes deliveries through Core delivery endpoints.
- Normalize Hermes jobs into Iris automations.
- Normalize Hermes sessions/messages into Iris conversations/messages during
  migration.
- Keep profile isolation strict. A `health` agent request should never render
  default profile events.

## Delivery And Streaming

Replace the current inbox as the long-term client-facing mechanism.

Current path:

```text
Hermes gateway
  -> agentui-platform adapter
  -> POST /v1/inbox/messages
  -> desktop polls inbox
  -> desktop merges streams
```

Target path:

```text
Hermes gateway
  -> agentui-platform adapter
  -> POST /v1/runtime-deliveries/hermes
  -> Core appends message_events
  -> desktop/mobile consume /v1/events or SSE
```

Delivery endpoint:

```http
POST /v1/runtime-deliveries/hermes
Authorization: Bearer <runtime-delivery-token>
Content-Type: application/json
```

Payload:

```json
{
  "runtimeId": "runtime_local_hermes",
  "profile": "health",
  "chatId": "desktop-uuid",
  "messageId": "adapter-message-id",
  "replyTo": "client-user-message-id",
  "source": "hermes-gateway-stream",
  "content": "partial assistant text",
  "metadata": {
    "streamMessageId": "adapter-message-id",
    "streaming": true,
    "finalize": false
  }
}
```

Core should:

- Validate the runtime delivery token.
- Resolve `runtimeId/profile/chatId` to an Iris conversation.
- Use `replyTo`, `streamMessageId`, and idempotency data to merge updates.
- Append events rather than mutate prior events.
- Update materialized `conversation_messages`.
- Publish SSE events.
- Keep profile isolation strict.

Do not use mutable inbox rows as the event cursor source. Mutating an existing
row makes it easy for clients to miss updates after their cursor has advanced.

## Desktop Refactor Plan

Add a Core TypeScript client:

```text
desktop/src/lib/agentuiCore.ts
```

The client should use HTTP against Core:

- Same-machine desktop: `http://127.0.0.1:8765/v1`.
- Remote agent host: Tailscale/private URL from settings.

Replace `desktop/src/lib/hermes.ts` gradually. Keep compatibility wrappers while
migrating views.

Desired hook changes:

- `useHermesRuntime` -> `useIrisCoreRuntime`.
- `useHermesChat` -> `useIrisChat`.
- `useHermesJobs` -> `useIrisAutomations`.
- `useHermesModelCatalog` should call Core model endpoints.
- `useHermesSlashCommands` should call Core slash endpoints.

Desktop should no longer own:

- Inbox cursor merging.
- Stream update reconciliation.
- Hermes chat ID generation rules.
- Hermes session ID migration.
- Job delivery target strings such as `agentui:desktop`.
- Profile-specific port derivation.

Desktop can still own:

- Local window layout.
- Composer input state.
- Optimistic UI while waiting for Core acknowledgement.
- Native notifications.
- Secure token storage for remote Core URLs.
- Starting/stopping a bundled local Core service.

## Service Management

The production install should support a durable local Core service on macOS.

Candidate service names:

```text
com.agentui.core
com.nousresearch.agentui.core
```

Candidate commands:

```sh
agentui-core --host 127.0.0.1 --port 8765
agentui-core --host 100.x.y.z --port 8765
```

Default host should remain `127.0.0.1`. For mobile testing, bind to a Tailscale
IP or private interface and require bearer auth.

The desktop app should be able to:

- Detect a running Core service.
- Start a bundled local Core during development or single-user desktop install.
- Show the Core URL and status in settings.
- Avoid starting duplicate Core instances.

## Security Requirements

- Bind to `127.0.0.1` by default.
- Use Tailscale or a private network for mobile/remote clients.
- Require bearer auth for any non-loopback bind.
- Prefer per-device tokens over one global shared token.
- Store only token hashes in Core.
- Show device tokens only once during pairing.
- Never accept arbitrary filesystem paths from clients.
- Never return provider API keys or Hermes secrets to clients.
- Keep CORS disabled by default.
- Use an explicit allowlist when browser clients need direct Core access.
- Add request size limits for message, attachment, and delivery endpoints.
- Add idempotency handling for mutating mobile requests.
- Log audit events for profile edits, memory writes, skill writes, automation
  changes, and device pairing/revocation.

## Mobile Readiness Requirements

Before starting the mobile app, Core should provide:

- Stable HTTP API with `/v1` routes.
- OpenAPI schema generated by FastAPI.
- Device auth and revocation.
- Event replay by cursor.
- SSE stream plus polling fallback.
- Core-owned conversation IDs.
- Core-owned automation IDs.
- Runtime adapter boundaries.
- No direct Hermes file or SQLite access from clients.
- No Tauri-only dependency for core product behavior.
- Settings support for connecting to a remote Core URL.

The mobile app should be able to implement its first chat view using only:

- `GET /v1/agents`
- `GET /v1/conversations`
- `POST /v1/conversations`
- `GET /v1/conversations/{id}/messages`
- `POST /v1/conversations/{id}/messages`
- `GET /v1/events/stream`
- `GET /v1/automations`

## Current Implementation Status

Last updated: 2026-05-06.

This document is still the target architecture. Phases 0 through 6 are
complete.

### Completed

- Added Core SQLite storage in `sidecar/src/hermes_management_server/core_store.py`.
- Added the default local Hermes runtime registry in
  `sidecar/src/hermes_management_server/runtime_registry.py`.
- Added the Hermes runtime adapter in
  `sidecar/src/hermes_management_server/runtime_adapters/hermes.py`.
- Added Core schema tables for devices, runtimes, agents, conversations,
  conversation runtime links, message events, materialized conversation
  messages, automations, and device cursors.
- Seeded `runtime_local_hermes` from local config/env defaults.
- Mapped Hermes profiles into Iris agents.
- Kept existing `/v1/profiles`, `/v1/inbox`, and management endpoints working.
- Added a root README architecture note for Iris Core.
- Added `desktop/src/lib/agentuiCore.ts`.
- Added a native bridge fallback action for Core HTTP calls.
- Added backend tests for Core storage, runtime/agent discovery, event replay,
  and runtime delivery handling.
- Core conversation routes exist:
  - `GET /v1/conversations`
  - `POST /v1/conversations`
  - `GET /v1/conversations/{conversation_id}`
  - `GET /v1/conversations/{conversation_id}/messages`
  - `POST /v1/conversations/{conversation_id}/messages`
  - `POST /v1/conversations/{conversation_id}/cancel`
- Core event routes exist:
  - `GET /v1/events`
  - `GET /v1/conversations/{conversation_id}/events`
  - `GET /v1/events/stream`
- Core runtime delivery route exists:
  - `POST /v1/runtime-deliveries/hermes`
- Core conversation list backfills Hermes management discovery into Iris
  conversation IDs and runtime links.
- Core message reads return materialized Core messages and lazily proxy Hermes
  history when a backfilled conversation has no Core-owned messages yet.
- Core event replay clamps cursors/limits and returns ordered append-only events
  after the requested cursor.
- Core SSE returns replayable and live `text/event-stream` output for local
  clients.
- Core agent filtering rejects unknown agents instead of silently returning an
  empty result.
- Profile isolation is covered for Core conversation lists, event filters,
  conversation-specific events, and runtime deliveries.
- Desktop chat creates new Core conversations and sends new messages through
  Core.
- Core generates and persists Hermes delivery targets for Core conversations;
  the desktop no longer manufactures `desktop-*` chat IDs for Core sends.
- First-message model switches for Core conversations are routed through Core
  as hidden adapter messages instead of direct desktop gateway calls.
- The desktop chat hook is now exposed as `useIrisChat`, with
  `useHermesChat` kept as a compatibility alias.
- Core reads `AGENTUI_TOKEN` / `AGENTUI_INBOX_TOKEN` from the configured Hermes
  home `.env` when the shell environment does not export them.
- Desktop Core event polling is scoped to the selected profile's Iris agent.
- Desktop chat subscribes to Core SSE for assistant deliveries, with scoped Core
  event polling as fallback.
- Desktop conversation/model/slash-command paths prefer Core-compatible routes
  with existing bridge fallbacks.
- The Iris platform adapter now delivers assistant messages to Core runtime
  deliveries instead of only to legacy inbox rows.
- Core materializes stream deltas, final assistant messages, and post-stream
  file/image deliveries into a single assistant message where appropriate.
- Legacy `/v1/inbox/messages` remains available for compatibility, but it is
  memory-only and desktop chat no longer depends on it.
- Core device routes exist:
  - `GET /v1/devices`
  - `GET /v1/devices/me`
  - `POST /v1/devices/pair`
  - `DELETE /v1/devices/{device_id}`
  - `POST /v1/devices/me/cursors`
- Core accepts either the existing management bearer token or an active paired
  device token for protected management/Core routes.
- Core stores only hashed paired-device tokens and returns the raw token only
  in the pairing response.
- Core rejects unauthenticated non-loopback binds, so Tailscale/private-network
  hosts require bearer auth.
- Desktop settings now expose the Iris Core URL and Core token in the main
  Settings view, while profile-specific connection overrides remain available.
- Desktop Core HTTP calls fall back through the native bridge on 401/403 so
  saved OS credential-store Core tokens are used for remote/private Core URLs.
- `sidecar/README.md` documents per-device pairing, revocation, Tailscale setup,
  and durable service-install notes.
- Fresh bundled app verification showed:
  - A Core-created conversation appeared in the desktop sidebar.
  - A manual runtime delivery appended a Core event.
  - The Core-delivered assistant message rendered in the packaged desktop app.

### Remaining Work

- Future mobile app implementation.
- Future production installer/launchd packaging for Iris Core.

### Verified In Phase 2 Completion Pass

```sh
npm run check
```

This covered:

- Desktop Vitest suite.
- Desktop Python bridge tests.
- Desktop TypeScript and Vite production build.
- Sidecar pytest suite, including Core Phase 2 tests.

### Verified In Phase 3 Completion Pass

```sh
npm run check
```

This covered:

- Desktop Vitest suite, including the Core-compatible chat hook tests.
- Desktop Python bridge tests.
- Desktop TypeScript and Vite production build.
- Sidecar pytest suite, including Core send tests.

Live local gateway verification used the configured Hermes `.env`
`AGENTUI_TOKEN` and the running Iris platform adapter at
`http://127.0.0.1:8766/agentui/messages`. Core created conversation
`conv_mgRLiQwBNNrFFaQHNtkpxC`, generated
`core-conv_mgRLiQwBNNrFFaQHNtkpxC`, and the Hermes adapter returned HTTP 202
with `accepted: true`.

Fresh packaged-app verification was run with:

```sh
npm run build:mac:app
```

The new bundle was launched from:

```text
desktop/src-tauri/target/release/bundle/macos/Iris.app
```

Computer Use verified the packaged app against:

```text
com.nousresearch.hermes-agent.desktop
```

The packaged app created a new Core conversation from the chat UI, rendered the
user message, showed it in the sidebar, and Core persisted the conversation
with a Core-owned `core-conv_...` external chat ID.

### Verified In Phase 4 Completion Pass

```sh
npm run check
```

This covered:

- Desktop Vitest suite, including Core event merge behavior through the chat
  hook helpers.
- Desktop Python bridge tests.
- Desktop TypeScript and Vite production build.
- Sidecar pytest suite, including Core runtime delivery materialization tests.

Live local SSE verification opened
`/v1/events/stream?after=<cursor>&agentId=<default-agent>` before posting a
runtime delivery. The stream emitted `message.assistant.delta` for conversation
`conv_UZBdS7mAUc5xGDGNdnIvIP`. A final stream delivery plus a file delivery
then materialized to one completed assistant message:

```text
Phase 4 live SSE final

File: /tmp/phase4.txt
```

Fresh packaged-app verification was run with:

```sh
npm run build:mac:app
```

Computer Use verified the packaged app against
`com.nousresearch.hermes-agent.desktop`. The packaged app created conversation
`conv_zDgD3Bam5qpmlnmCrAal`, a manual Core runtime delivery arrived through
Core events, and the assistant message rendered in the chat UI as:

```text
Phase 4 packaged SSE rendered through Core events
```

### Verified In Phase 5 Completion Pass

```sh
sidecar/.venv/bin/python -m pytest sidecar/tests
npm --workspace desktop run test -- src/features/chat/__tests__/useHermesChat.test.ts src/features/jobs/__tests__/useHermesJobs.test.ts
npm --workspace desktop run build
```

This covered:

- Core automation route tests for create, list, pause, resume, run, delete, and
  Hermes job ID mapping.
- Legacy inbox compatibility tests that mirror Hermes job deliveries into Core
  conversation events/messages.
- Desktop automation normalization and the Core-compatible chat hook tests.
- Desktop TypeScript and Vite production build.

Live local automation verification used the updated sidecar on
`http://127.0.0.1:8765`, the Hermes Jobs API on `http://127.0.0.1:8642`, and
the installed Iris Hermes platform delivery path. Core created conversation
`conv_8EeJQtJEO50wV5PU1qluF7`, created automation
`auto_1hnTh6hBCD499AB4LuAb52`, mapped it to Hermes job `4c35f2efff01`, paused
and resumed it through Core, ran it through Core, and materialized the Hermes
job result back into the same Core conversation as `message.assistant.completed`.

The delivered Core message content was:

```text
Cronjob Response: Phase 5 Core mirror smoke
(job_id: 4c35f2efff01)
-------------

Phase 5 Core mirror delivered
```

Fresh packaged-app verification was run with:

```sh
npm run build:mac:app
```

Computer Use verified the packaged app against
`com.nousresearch.hermes-agent.desktop`. The packaged app opened the
Automations view from the fresh bundle, displayed the Core-delivered Phase 5
automation result, created a new scheduled message through the UI, showed the
new Core automation under Active, and removed it after cleanup and refresh.

### Verified In Phase 6 Completion Pass

```sh
npm run check
```

This covered:

- Desktop Vitest suite, including Core auth fallback behavior.
- Desktop Python bridge tests.
- Desktop TypeScript and Vite production build.
- Sidecar pytest suite, including device pairing, hashed-token auth,
  revocation, non-loopback auth enforcement, and existing Core API behavior.

Live second-client verification used the updated Core service on
`http://127.0.0.1:8765`. A second HTTP client paired device
`dev_BwW4kTibqHrU9oQdBZECFR`, authenticated with the one-time returned device
token, listed agents, replayed 3 Core events by cursor for
`agent_393e440748_default`, saved its device cursor, revoked the device, and
confirmed the revoked token returned HTTP 401.

Live inbox compatibility verification confirmed the Hermes `.env`
`AGENTUI_TOKEN` authorizes legacy `/v1/inbox/messages` delivery when no shell
`AGENTUI_INBOX_TOKEN` is exported.

Fresh packaged-app verification was run with:

```sh
npm run build:mac:app
```

Computer Use verified the packaged app against
`com.nousresearch.hermes-agent.desktop`. The packaged app showed the Iris
Core URL/token controls in the connection UI, sent a chat through Core in
conversation `conv_IBMJgDqlvVtJ3tKl5IF6ac`, and rendered exactly one completed
assistant response:

```text
Phase 6 packaged Core auth smoke fixed
```

### Previous Packaged-App Verification

```sh
npm run check
npm run build:mac:app
```

The fresh bundle was launched from:

```text
desktop/src-tauri/target/release/bundle/macos/Iris.app
```

Computer Use verified the packaged app against:

```text
com.nousresearch.hermes-agent.desktop
```

One limitation during verification: the shell environment did not have
`AGENTUI_TOKEN`, so real Hermes gateway send correctly returned
`AGENTUI_TOKEN is required for Iris gateway chat.` Core conversation
creation, event replay, runtime delivery, and packaged-app rendering were still
verified.

## Migration Phases

### Phase 0: Freeze The Target Contract

Status: Complete.

- Create this implementation plan.
- Decide whether to rename the sidecar package now or after the first Core API
  endpoints land.
- Add a short architecture note to the root README once implementation begins.

Acceptance criteria:

- The repo has a clear Core API plan.
- Future work can be split into backend, desktop SDK, and Hermes adapter tasks.

### Phase 1: Add Core Storage And Runtime Registry

Status: Complete.

Implementation targets:

- `sidecar/src/hermes_management_server/core_store.py`
- `sidecar/src/hermes_management_server/runtime_registry.py`
- `sidecar/src/hermes_management_server/runtime_adapters/hermes.py`
- `sidecar/tests/test_core_store.py`
- `sidecar/tests/test_runtime_registry.py`

Work:

- Add SQLite schema for devices, runtimes, agents, conversations,
  conversation_runtime_links, message_events, automations, and device_cursors.
- Seed a default local Hermes runtime from existing env/config.
- Map existing Hermes profiles into Core agents.
- Keep existing `/v1/profiles`, `/v1/inbox`, and management endpoints working.

Acceptance criteria:

- Core can list runtimes and agents.
- Existing desktop behavior does not regress.
- Sidecar tests cover schema creation and default Hermes runtime discovery.

### Phase 2: Add Core Conversations And Events

Status: Complete.

Implementation targets:

- Core conversation routes in `sidecar/src/hermes_management_server/main.py`.
- Event append/replay helpers.
- SSE endpoint.
- Tests for cursor replay and profile isolation.

Work:

- Add `/v1/conversations`, `/v1/conversations/{id}/messages`, and
  `/v1/events`.
- Backfill conversation list from Hermes management discovery when Core does not
  have records yet.
- Create Iris conversation IDs and runtime links.
- Materialize transcript messages from append-only events.

Acceptance criteria:

- A client can list conversations through Core.
- A client can fetch messages through Core.
- Event replay returns ordered events after a cursor.
- SSE works for a local test client.

### Phase 3: Move Chat Send Onto Core

Status: Complete.

Implementation targets:

- Core `POST /v1/conversations/{id}/messages`.
- Hermes adapter send implementation.
- `desktop/src/lib/agentuiCore.ts`.
- New or migrated chat hook.

Work:

- Core accepts a user message, appends `message.user.created`, and calls the
  Hermes adapter.
- Hermes adapter sends through the `agentui-platform` `/agentui/messages`
  endpoint.
- Core records the durable `external_chat_id`.
- Desktop sends to Core instead of calling `sendHermesGatewayMessage` directly.

Acceptance criteria:

- Normal desktop chat works through Core.
- The desktop app no longer needs to generate Hermes delivery targets.
- Existing Hermes gateway/platform behavior still works.
- Profile isolation works for default and named profiles.

### Phase 4: Move Deliveries And Streaming Onto Core Events

Status: Complete.

Implementation targets:

- `POST /v1/runtime-deliveries/hermes`.
- Iris platform adapter delivery URL update.
- Core stream merge logic.
- Desktop event subscription.

Work:

- Replace desktop inbox polling with Core event subscription.
- Keep legacy `/v1/inbox/messages` as compatibility until desktop no longer
  depends on it.
- Make stream updates append-only.
- Materialize assistant messages server-side.

Acceptance criteria:

- Assistant text streams into the desktop chat through Core events.
- Mobile-style reconnect by cursor can replay the same stream events.
- No duplicate final assistant messages.
- Completed conversation history matches Core materialized messages and Hermes
  persisted history.

### Phase 5: Move Automations Onto Core

Status: Complete.

Implementation targets:

- Core automation routes.
- Hermes Jobs adapter.
- Desktop jobs hook migration.

Work:

- Core owns automation records in the Core SQLite store and maps them to Hermes
  job IDs through `externalJobId`.
- Hermes jobs remain the execution backend for Hermes runtimes through the
  Core Hermes adapter.
- Deliveries return through Core events/messages. Current Hermes installs that
  still post to legacy `/v1/inbox/messages` are mirrored into live Core events
  for compatibility without writing an inbox SQLite database.
- Desktop `JobsView` calls Core automation endpoints through
  `useIrisAutomations`; `useHermesJobs` remains as a compatibility alias.

Acceptance criteria:

- Complete: desktop can create, list, pause, resume, run, and delete
  automations through Core.
- Complete: one-shot "message me in 10 minutes" creates a Core automation and a
  Hermes job.
- Complete: delivery lands in the correct Core conversation and materializes as
  a Core assistant message.

### Phase 6: Device Auth And Remote Client Readiness

Status: Complete.

Implementation targets:

- Device auth routes.
- Token storage.
- Settings UI for Core URL/token.
- Service install docs.

Work:

- Add per-device tokens.
- Add pairing flow.
- Add device revocation.
- Add Tailscale setup docs.
- Verify a second local client can connect without reading Hermes files.

Acceptance criteria:

- Complete: a remote/private-network client can authenticate to Core with a
  paired device token, and non-loopback binds require bearer auth.
- Complete: event cursor replay works from a second client using only Core HTTP.
- Complete: the desktop app can connect to either local Core or a remote/private
  Core URL and use a saved Core token through the native bridge.
- Complete: no client needs direct Hermes filesystem access.

## Verification

For backend-only Core changes:

```sh
npm run sidecar:test
```

For desktop SDK or hook changes:

```sh
npm --workspace desktop run test
npm --workspace desktop run build
```

For visible desktop UI changes, follow `AGENTS.md`:

```sh
npm run check
npm run build:mac:app
```

Then launch the fresh app bundle and verify with Computer Use against:

```text
com.nousresearch.hermes-agent.desktop
```

For Core API integration smoke tests:

```sh
curl http://127.0.0.1:8765/v1/health
curl http://127.0.0.1:8765/v1/runtimes
curl http://127.0.0.1:8765/v1/agents
curl 'http://127.0.0.1:8765/v1/events?after=0&limit=10'
```

For mobile-readiness checks before building mobile:

- Start Core on the Hermes machine.
- Bind to a Tailscale IP or private interface.
- Authenticate from another device or machine.
- List agents.
- List conversations.
- Send a message.
- Reconnect from the same cursor and confirm no events are lost or duplicated.

## Open Questions

- Should the Python package be renamed from `hermes_management_server` to
  `agentui_core` immediately, or after the first Core endpoints are stable?
- Should Core run as a standalone LaunchAgent, be managed by the desktop app, or
  support both?
- What should the first pairing UX be for mobile: manual token, QR code, or
  desktop-approved request?
- Should Core eventually support cloud relay for push notifications, or should
  v1 stay Tailscale-only?
- How much of Hermes conversation history should Core import versus lazily
  proxy?
- Should Core own model switching as a first-class conversation setting instead
  of sending hidden `/model` messages?
- What is the long-term distinction between an Iris "agent" and a Hermes
  "profile" once non-Hermes runtimes exist?
