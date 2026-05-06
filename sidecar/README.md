# Iris Core

Iris Core is the local-first control plane for Iris. It owns Iris agents, conversations, messages, automations, devices, auth, and runtime routing, and connects to Hermes through the Iris Hermes Adapter. Hermes itself remains untouched: normal Iris chat enters Hermes through the `agentui` compatibility platform adapter, while this service exposes profile, memory, skill, status, conversation metadata, and delivered platform messages over HTTP from the machine where Hermes is running.

This service lives in the `sidecar/` workspace of the Iris monorepo.

The default bind address is `127.0.0.1`. For remote use, prefer Tailscale and a bearer token over public port forwarding. Non-loopback binds require bearer auth from either `IRIS_CORE_TOKEN`, the legacy `HERMES_MGMT_TOKEN`, or an active paired device token.

## Install

From the monorepo root:

```bash
npm run sidecar:setup
```

From this `sidecar/` directory:

```bash
python3.11 -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
```

Run tests from the monorepo root:

```bash
npm run sidecar:test
```

## Run Locally

From the monorepo root:

```bash
npm run sidecar:dev
```

From this `sidecar/` directory:

```bash
iris-core --host 127.0.0.1 --port 8765
```

Use a custom Hermes home:

```bash
iris-core --hermes-home ~/.hermes --host 127.0.0.1 --port 8765
```

Environment variables are also supported:

```bash
export HERMES_HOME="$HOME/.hermes"
export IRIS_CORE_HOST="127.0.0.1"
export IRIS_CORE_PORT="8765"
export IRIS_CORE_TOKEN="replace-with-a-long-random-token"
export IRIS_INBOX_TOKEN="replace-with-a-long-random-token"
export IRIS_CORE_CORS_ORIGINS="http://localhost:3000"
iris-core
```

If `HERMES_HOME` points at a named profile such as `~/.hermes/profiles/work`, the server normalizes the root back to `~/.hermes`. The `default` profile maps to the root; named profiles map to `~/.hermes/profiles/<name>`.

`IRIS_INBOX_TOKEN` protects only `/v1/inbox/*`. If it is unset, the inbox accepts local unauthenticated delivery. For same-machine development this is usually fine because the default bind address is `127.0.0.1`. For Tailscale or any non-loopback bind address, set `IRIS_INBOX_TOKEN` and configure the Iris Hermes Adapter with the same value as `IRIS_TOKEN`. Legacy `AGENTUI_INBOX_TOKEN` and `AGENTUI_TOKEN` are still accepted.

The inbox stores delivered scheduled-job messages in SQLite. Override the default path with:

```bash
export IRIS_INBOX_STORE="$HOME/.agent-ui/inbox.sqlite3"
```

## Tailscale Setup

1. Install Tailscale on the Hermes machine and on the Iris client machine.
2. Sign in to the same tailnet on both machines.
3. On the Hermes machine, create a temporary management token:

```bash
export IRIS_CORE_TOKEN="$(openssl rand -base64 32)"
```

4. Start Iris Core on the Hermes machine:

```bash
HERMES_HOME="$HOME/.hermes" \
IRIS_CORE_TOKEN="$IRIS_CORE_TOKEN" \
iris-core --host 0.0.0.0 --port 8765
```

5. Pair each remote client and copy the returned `token` once:

```bash
curl -X POST http://<tailscale-hostname>:8765/v1/devices/pair \
  -H "Authorization: Bearer $IRIS_CORE_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"Scott MacBook","kind":"desktop","metadata":{"network":"tailscale"}}'
```

6. In Iris Desktop, open Settings, set the Iris Core URL, and save the paired device token in the Core token field. Remote clients should connect to:

```text
http://<tailscale-hostname>:8765/v1
```

Example:

```bash
curl -H "Authorization: Bearer <paired-device-token>" \
  http://<tailscale-hostname>:8765/v1/agents
```

You can bind to a specific Tailscale IP instead of `0.0.0.0`:

```bash
iris-core --host 100.x.y.z --port 8765
```

Do not expose this service directly to the public internet without TLS and bearer-token auth. Memory and skills may contain sensitive local context.

## Device Auth

Pair a device:

```bash
curl -X POST http://127.0.0.1:8765/v1/devices/pair \
  -H "Content-Type: application/json" \
  --data '{"name":"Local desktop","kind":"desktop"}'
```

When `IRIS_CORE_TOKEN` or legacy `HERMES_MGMT_TOKEN` is set, include it as a bearer token on the pairing request. The pairing response shows the device token once. Core stores only a token hash.

List devices:

```bash
curl -H "Authorization: Bearer $IRIS_CORE_TOKEN" \
  http://127.0.0.1:8765/v1/devices
```

Revoke a device:

```bash
curl -X DELETE -H "Authorization: Bearer $IRIS_CORE_TOKEN" \
  http://127.0.0.1:8765/v1/devices/dev_...
```

Verify a second client without Hermes filesystem access:

```bash
curl -H "Authorization: Bearer <paired-device-token>" \
  'http://<tailscale-hostname>:8765/v1/conversations?agentId=<agent-id>'

curl -H "Authorization: Bearer <paired-device-token>" \
  'http://<tailscale-hostname>:8765/v1/events?after=0&limit=50&agentId=<agent-id>'
```

The second client needs only the Core URL and paired device token. It should not read `~/.hermes`, Hermes SQLite files, or the Iris Core SQLite file directly.

## Service Install Notes

For a durable local agent host, run Core under a service manager such as launchd on macOS. Keep the bind address loopback for same-machine desktop use:

```bash
iris-core --host 127.0.0.1 --port 8765 --hermes-home "$HOME/.hermes"
```

For remote clients over Tailscale, bind to the Tailscale IP or `0.0.0.0`, set `IRIS_CORE_TOKEN`, pair per-device tokens, and keep CORS disabled unless a browser client has an explicit trusted origin.

## API

All responses are JSON. Errors use:

```json
{ "ok": false, "error": "..." }
```

When `IRIS_CORE_TOKEN` is set, or when Core is bound to a non-loopback host, include either the management token or a paired device token:

```http
Authorization: Bearer <token>
```

### Health

```bash
curl http://127.0.0.1:8765/health
```

Returns `ok`, `checkedAt`, `hermesHome`, and `profilesRootExists`.

### Inbox Health

```bash
curl http://127.0.0.1:8765/v1/inbox/health
```

Returns `ok`, `checkedAt`, and the inbox SQLite `path`.

### Inbox Messages

Create a delivery:

```bash
curl -X POST http://127.0.0.1:8765/v1/inbox/messages \
  -H "Content-Type: application/json" \
  --data '{"source":"hermes-cron","platform":"agentui","chatId":"desktop","content":"Iris inbox smoke test","metadata":{"jobId":"manual-test"}}'
```

List deliveries:

```bash
curl http://127.0.0.1:8765/v1/inbox/messages
```

When `IRIS_INBOX_TOKEN` is set, include the bearer token on these requests.

### Status

```bash
curl http://127.0.0.1:8765/v1/status
```

Returns `ok`, `checkedAt`, `hermesHome`, `activeProfile`, and `profileCount`.

### Profiles

```bash
curl http://127.0.0.1:8765/v1/profiles
curl http://127.0.0.1:8765/v1/profiles/default
curl http://127.0.0.1:8765/v1/profiles/work
```

Each profile summary includes `name`, `path`, `active`, `exists`, `provider`, `model`, `memoryBytes`, `memoryUpdatedAt`, `skillCount`, and `gatewayRunning`.

### Memory

```bash
curl http://127.0.0.1:8765/v1/profiles/default/memory
```

Returns metadata and content for `MEMORY.md` and `USER.md`.

### Conversations

```bash
curl 'http://127.0.0.1:8765/v1/profiles/default/conversations?limit=80'
```

Returns existing Hermes conversations for the selected profile without requiring the client to read Hermes files or SQLite directly. `limit` defaults to `80` and is clamped to `1..200`.

Response shape:

```json
{
  "ok": true,
  "profile": "default",
  "path": "/Users/scott/.hermes/state.db",
  "source": "hermes-management",
  "schemaVersion": 11,
  "conversations": [
    {
      "id": "session-id",
      "source": "api_server",
      "model": "gpt-5.5",
      "title": "How do I list profiles?",
      "preview": "Use the profiles endpoint.",
      "startedAt": 1777804077,
      "endedAt": null,
      "lastActiveAt": 1777804079,
      "messageCount": 2
    }
  ],
  "warning": "optional warning"
}
```

Conversation discovery is schema-tolerant and read-only. The server first inspects profile-local SQLite candidates such as `state.db` by reading `sqlite_master` and table columns. It supports the observed Hermes `sessions` and `messages` schema, then falls back to profile-local `sessions/*.json` files when no supported SQLite conversation table exists. If no supported store is found, it returns `ok: true`, an empty `conversations` array, and a warning instead of crashing.

### Skills

```bash
curl http://127.0.0.1:8765/v1/profiles/default/skills
curl http://127.0.0.1:8765/v1/profiles/default/skills/<skill_id>
```

Skill ids are URL-safe base64 encodings of the relative `SKILL.md` path under the selected profile's `skills` directory. The server rejects ids that decode to absolute paths, parent traversal, or anything other than a `SKILL.md` file.

## Security Notes

- The service is read-only.
- It never accepts arbitrary file paths from clients.
- Profile names are limited to letters, numbers, dots, dashes, and underscores.
- Memory, skill, and conversation reads are resolved and checked so they stay inside the selected profile directory.
- Conversation discovery opens SQLite stores in read-only mode and never writes to Hermes databases or session files.
- CORS is disabled by default. Set `HERMES_MGMT_CORS_ORIGINS` to a comma-separated allowlist when browser clients need direct access.
