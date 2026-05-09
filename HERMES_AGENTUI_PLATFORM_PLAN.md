# Iris Hermes Platform Adapter Plan

This document captures the implementation plan for making Hermes scheduled jobs deliver messages into Iris.

The recommended architecture is a Hermes platform plugin named `agentui`. Hermes keeps ownership of scheduling and job execution. Iris exposes a small authenticated delivery surface and renders delivered messages in the desktop app.

## Goals

- Let a user ask Iris/Hermes: "send me a message in 10 minutes".
- Create a Hermes cron job that runs at the requested time.
- Deliver the completed job output into Iris as an app message/notification.
- Add an Iris sidebar link for viewing scheduled automations/jobs.
- Keep Hermes core untouched by using the Hermes plugin platform path.
- Support Hermes running on a different machine from Iris, preferably over Tailscale plus bearer auth.

## Non-Goals

- Do not modify Hermes core for the first implementation.
- Do not expose Iris publicly on the internet.
- Do not depend on local filesystem reads from remote Iris clients.
- Do not make Iris a full messaging platform in Phase 1.

## Phase 1: Outbound-Only Adapter

Phase 1 makes Hermes able to send scheduled job results to Iris. Iris can create/list/manage jobs, and Hermes can deliver job output back to Iris, but Iris-originated chat still uses the existing API path.

### Hermes Plugin

Create a plugin that installs on the Hermes machine:

```text
iris-platform/
  plugin.yaml
  __init__.py
  adapter.py
  README.md
```

`plugin.yaml`:

```yaml
name: iris-platform
kind: platform
version: 0.1.0
description: Iris delivery adapter for Hermes.
requires_env:
  - AGENTUI_BASE_URL
  - AGENTUI_TOKEN
```

`adapter.py` should register a platform via `ctx.register_platform(...)`:

- `name="iris"`
- `label="Iris"`
- `adapter_factory=lambda cfg: IrisAdapter(cfg)`
- `check_fn` returns true when `AGENTUI_BASE_URL` and `AGENTUI_TOKEN` are present or config equivalents exist.
- `validate_config` confirms `base_url`, `token`, and a default chat/device id.
- `platform_hint` tells Hermes this is an Iris desktop delivery target.

The adapter should implement:

- `connect()`: validate config, probe Iris health/inbox endpoint, mark connected.
- `disconnect()`: mark disconnected.
- `send(chat_id, content, reply_to=None, metadata=None)`: POST a message to Iris.
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
deliver="iris:scott-desktop"
```

or a default:

```text
deliver="agentui"
```

when `AGENTUI_DEFAULT_CHAT_ID` is configured.

### Iris Core

Add authenticated inbox endpoints to the Iris Iris Core:

- `GET /v1/inbox/health`
- `POST /v1/inbox/messages`
- `GET /v1/inbox/messages?after=<cursor>`
- `POST /v1/inbox/messages/{message_id}/ack`

Store delivered messages locally in a small Iris-managed store. SQLite is preferable once message ack/cursors exist; JSON is acceptable only for an initial prototype.

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

- Bind Iris Iris Core to `127.0.0.1` by default.
- For remote Hermes, use Tailscale or a private network address.
- Require `AGENTUI_INBOX_TOKEN` or equivalent Iris Core token.
- Never accept arbitrary file paths or executable payloads through the inbox.

### Iris Desktop

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

Iris bridge actions to add:

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
  "deliver": "iris:scott-desktop"
}
```

### Remote Install

On the Hermes machine:

```bash
hermes plugins install https://github.com/<org>/iris-platform.git --enable
```

or manually:

```bash
mkdir -p ~/.hermes/plugins
cp -R iris-platform ~/.hermes/plugins/iris-platform
hermes plugins enable iris-platform
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
hermes cron create "2m" "Reply exactly: test from Hermes cron" --deliver "iris:scott-desktop" --name "Iris smoke test"
hermes cron status
```

### Phase 1 Acceptance Criteria

- Iris can create a one-shot scheduled message.
- Hermes shows the job in `hermes cron list` or `/api/jobs`.
- Hermes gateway fires the job.
- The `agentui` adapter POSTs the output to Iris.
- Iris displays the delivered message without duplicate delivery.
- Iris can pause/resume/delete jobs from the new sidebar view.
- Remote Hermes delivery works over Tailscale with bearer auth.

## Phase 2: Inbound Iris-To-Hermes Routing

Phase 2 makes Iris a true Hermes platform. Messages entered in Iris can enter the Hermes gateway as `platform=iris`, giving Hermes a real origin for follow-up delivery.

### Inbound Transport

Add the inbound path directly to the `agentui` platform adapter. Iris calls
the Hermes plugin HTTP endpoint on the Hermes machine, secured by bearer token
and private network. This is the standard chat route; Iris should not split
messages between direct API chat and gateway/platform chat based on prompt
intent.

Suggested Hermes plugin endpoint:

```http
POST /iris/messages
Authorization: Bearer <AGENTUI_TOKEN>
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
- `chat_id=<Iris conversation/device id>`
- `chat_name=<Iris label>`
- `user_id=<Iris user id>`
- `message_id=<Iris message id>`

This lets Hermes cron jobs created from Iris use:

```text
deliver="origin"
```

and still route back to Iris later.

### Iris Chat Integration

Iris chat should use the gateway/platform path as the single standardized
chat route. The legacy direct `/v1/responses` API path can be removed from
normal composer flow rather than kept as a prompt-intent fallback.

Each Iris conversation gets a durable Iris chat id. The adapter uses that
id as `SessionSource.chat_id`, so Hermes session lookup, tool execution, cron
origin capture, and future `deliver="origin"` delivery all work the same way
they do for Telegram or Slack.

### Phase 2 Acceptance Criteria

- Iris sends a message into Hermes through the `agentui` platform adapter.
- Hermes processes it as a gateway message, not just an API request.
- The Iris composer uses the gateway/platform route for normal chat.
- A user can say "send me a message in 10 minutes".
- Hermes creates a cron job with `deliver="origin"`.
- The future cron result routes back to the same Iris chat/device.
- Iris shows the delivered result in the right conversation.

## Verification Workflow

For code or visible UI changes in Iris:

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
hermes cron create "2m" "Reply exactly: adapter smoke test" --deliver "iris:scott-desktop" --name "Iris adapter smoke"
```

Also verify the Iris Iris Core receives the POST and the desktop renders the message.

## Open Questions

- Should the UI label be "Jobs", "Automations", or "Scheduled"?
- Should delivered cron messages appear inside the chat transcript, a notification inbox, or both?
- Should Iris store inbox messages in the existing Iris Core, a desktop-local store, or both?
- What is the durable device/chat id format for Iris destinations?
