# Hermes AgentUI Platform Adapter Plan

This document captures the implementation plan for making Hermes scheduled jobs deliver messages into AgentUI.

The recommended architecture is a Hermes platform plugin named `agentui`. Hermes keeps ownership of scheduling and job execution. AgentUI exposes a small authenticated delivery surface and renders delivered messages in the desktop app.

## Goals

- Let a user ask AgentUI/Hermes: "send me a message in 10 minutes".
- Create a Hermes cron job that runs at the requested time.
- Deliver the completed job output into AgentUI as an app message/notification.
- Add an AgentUI sidebar link for viewing scheduled automations/jobs.
- Keep Hermes core untouched by using the Hermes plugin platform path.
- Support Hermes running on a different machine from AgentUI, preferably over Tailscale plus bearer auth.

## Non-Goals

- Do not modify Hermes core for the first implementation.
- Do not expose AgentUI publicly on the internet.
- Do not depend on local filesystem reads from remote AgentUI clients.
- Do not make AgentUI a full messaging platform in Phase 1.

## Phase 1: Outbound-Only Adapter

Phase 1 makes Hermes able to send scheduled job results to AgentUI. AgentUI can create/list/manage jobs, and Hermes can deliver job output back to AgentUI, but AgentUI-originated chat still uses the existing API path.

### Hermes Plugin

Create a plugin that installs on the Hermes machine:

```text
agentui-platform/
  plugin.yaml
  __init__.py
  adapter.py
  README.md
```

`plugin.yaml`:

```yaml
name: agentui-platform
kind: platform
version: 0.1.0
description: AgentUI delivery adapter for Hermes Agent.
requires_env:
  - AGENTUI_BASE_URL
  - AGENTUI_TOKEN
```

`adapter.py` should register a platform via `ctx.register_platform(...)`:

- `name="agentui"`
- `label="AgentUI"`
- `adapter_factory=lambda cfg: AgentUIAdapter(cfg)`
- `check_fn` returns true when `AGENTUI_BASE_URL` and `AGENTUI_TOKEN` are present or config equivalents exist.
- `validate_config` confirms `base_url`, `token`, and a default chat/device id.
- `platform_hint` tells Hermes this is an AgentUI desktop delivery target.

The adapter should implement:

- `connect()`: validate config, probe AgentUI health/inbox endpoint, mark connected.
- `disconnect()`: mark disconnected.
- `send(chat_id, content, reply_to=None, metadata=None)`: POST a message to AgentUI.
- `get_chat_info(chat_id)`: return basic destination metadata.

Suggested outbound request:

```http
POST /v1/inbox/messages
Authorization: Bearer <AGENTUI_TOKEN>
Content-Type: application/json
```

```json
{
  "source": "hermes-cron",
  "platform": "agentui",
  "chatId": "scott-desktop",
  "content": "Cronjob Response: ...",
  "metadata": {
    "jobId": "aabbccddeeff",
    "threadId": null,
    "deliveredAt": 1778000000
  }
}
```

Cron delivery should then use:

```text
deliver="agentui:scott-desktop"
```

or a default:

```text
deliver="agentui"
```

when `AGENTUI_DEFAULT_CHAT_ID` is configured.

### AgentUI Sidecar

Add authenticated inbox endpoints to the AgentUI sidecar:

- `GET /v1/inbox/health`
- `POST /v1/inbox/messages`
- `GET /v1/inbox/messages?after=<cursor>`
- `POST /v1/inbox/messages/{message_id}/ack`

Store delivered messages locally in a small AgentUI-managed store. SQLite is preferable once message ack/cursors exist; JSON is acceptable only for an initial prototype.

Message model:

```json
{
  "id": "uuid",
  "source": "hermes-cron",
  "chatId": "scott-desktop",
  "content": "...",
  "metadata": {},
  "createdAt": 1778000000,
  "acknowledgedAt": null
}
```

Security requirements:

- Bind AgentUI sidecar to `127.0.0.1` by default.
- For remote Hermes, use Tailscale or a private network address.
- Require `AGENTUI_INBOX_TOKEN` or equivalent sidecar token.
- Never accept arbitrary file paths or executable payloads through the inbox.

### AgentUI Desktop

Add a Jobs/Automations view:

- Extend `View` with `"jobs"` or `"automations"`.
- Add sidebar nav item with a clock/list icon.
- Add a jobs data hook that can list, create, pause, resume, run, and delete jobs.
- Add a delivered-message hook that polls or subscribes to inbox messages.
- Surface delivered scheduled messages in a notification center and/or a dedicated inbox panel.

Suggested UI sections:

- Active jobs
- Paused jobs
- Completed one-shot jobs
- Recent deliveries
- Create scheduled message

### Job Management

Use Hermes' Jobs API when available:

- `GET /api/jobs`
- `POST /api/jobs`
- `GET /api/jobs/{job_id}`
- `PATCH /api/jobs/{job_id}`
- `DELETE /api/jobs/{job_id}`
- `POST /api/jobs/{job_id}/pause`
- `POST /api/jobs/{job_id}/resume`
- `POST /api/jobs/{job_id}/run`

AgentUI bridge actions to add:

- `jobs_list`
- `jobs_create`
- `jobs_update`
- `jobs_delete`
- `jobs_pause`
- `jobs_resume`
- `jobs_run`

For "send me a message in X minutes", create a one-shot job:

```json
{
  "name": "Reminder",
  "schedule": "10m",
  "prompt": "Reply exactly with this message: <message>",
  "repeat": 1,
  "deliver": "agentui:scott-desktop"
}
```

### Remote Install

On the Hermes machine:

```bash
hermes plugins install https://github.com/<org>/agentui-platform.git --enable
```

or manually:

```bash
mkdir -p ~/.hermes/plugins
cp -R agentui-platform ~/.hermes/plugins/agentui-platform
hermes plugins enable agentui-platform
```

Configure:

```bash
export AGENTUI_BASE_URL="http://<agentui-tailscale-host>:8765"
export AGENTUI_TOKEN="<shared-secret>"
export AGENTUI_DEFAULT_CHAT_ID="scott-desktop"
```

Restart Hermes gateway:

```bash
hermes gateway restart
```

Verify:

```bash
hermes plugins list
hermes cron create "2m" "Reply exactly: test from Hermes cron" --deliver "agentui:scott-desktop" --name "AgentUI smoke test"
hermes cron status
```

### Phase 1 Acceptance Criteria

- AgentUI can create a one-shot scheduled message.
- Hermes shows the job in `hermes cron list` or `/api/jobs`.
- Hermes gateway fires the job.
- The `agentui` adapter POSTs the output to AgentUI.
- AgentUI displays the delivered message without duplicate delivery.
- AgentUI can pause/resume/delete jobs from the new sidebar view.
- Remote Hermes delivery works over Tailscale with bearer auth.

## Phase 2: Inbound AgentUI-To-Hermes Routing

Phase 2 makes AgentUI a true Hermes platform. Messages entered in AgentUI can enter the Hermes gateway as `platform=agentui`, giving Hermes a real origin for follow-up delivery.

### Inbound Transport

Add one of these inbound paths:

1. AgentUI calls a Hermes plugin HTTP endpoint.
2. AgentUI sidecar opens a persistent websocket/SSE connection to the Hermes adapter.
3. Hermes adapter polls AgentUI for queued outbound user messages.

Preferred starting point: AgentUI calls a plugin HTTP endpoint on the Hermes machine, secured by bearer token and private network.

Suggested Hermes plugin endpoint:

```http
POST /agentui/messages
Authorization: Bearer <AGENTUI_TO_HERMES_TOKEN>
Content-Type: application/json
```

```json
{
  "chatId": "scott-desktop",
  "userId": "scott",
  "userName": "Scott",
  "messageId": "uuid",
  "text": "send me a message in 10 minutes"
}
```

The adapter builds a `MessageEvent` and calls `self.handle_message(event)`.

### Session Origin

Inbound events should use:

- `platform="agentui"`
- `chat_id=<AgentUI conversation/device id>`
- `chat_name=<AgentUI label>`
- `user_id=<AgentUI user id>`
- `message_id=<AgentUI message id>`

This lets Hermes cron jobs created from AgentUI use:

```text
deliver="origin"
```

and still route back to AgentUI later.

### AgentUI Chat Integration

AgentUI should distinguish:

- Direct API chat sessions.
- Gateway/platform sessions through `agentui`.

Once inbound routing exists, scheduled-message prompts should go through the gateway/platform path when the user expects future delivery. That gives Hermes the same origin metadata it has for Telegram/Slack.

### Phase 2 Acceptance Criteria

- AgentUI sends a message into Hermes through the `agentui` platform adapter.
- Hermes processes it as a gateway message, not just an API request.
- A user can say "send me a message in 10 minutes".
- Hermes creates a cron job with `deliver="origin"`.
- The future cron result routes back to the same AgentUI chat/device.
- AgentUI shows the delivered result in the right conversation.

## Verification Workflow

For code or visible UI changes in AgentUI:

```bash
npm run check
npm run build:mac:app
```

Then launch the fresh macOS app bundle and verify with Computer Use against:

```text
com.nousresearch.hermes-agent.desktop
```

For Hermes plugin changes:

```bash
hermes plugins list
hermes cron status
hermes cron create "2m" "Reply exactly: adapter smoke test" --deliver "agentui:scott-desktop" --name "AgentUI adapter smoke"
```

Also verify the AgentUI sidecar receives the POST and the desktop renders the message.

## Open Questions

- Should the UI label be "Jobs", "Automations", or "Scheduled"?
- Should delivered cron messages appear inside the chat transcript, a notification inbox, or both?
- Should AgentUI store inbox messages in the existing sidecar, a desktop-local store, or both?
- Should Phase 1 job creation go through Hermes `/api/jobs` directly or through AgentUI sidecar proxy endpoints?
- What is the durable device/chat id format for AgentUI destinations?
