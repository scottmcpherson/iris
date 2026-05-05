# AgentUI Sidecar

Small read-only FastAPI sidecar for AgentUI profile metadata. Hermes itself remains untouched: the desktop app can keep sending chat traffic to Hermes' existing `/v1/responses` API, while this service exposes profile, memory, skill, status, and conversation metadata over HTTP from the machine where Hermes is running.

This service lives in the `sidecar/` workspace of the AgentUI monorepo.

The default bind address is `127.0.0.1`. For remote use, prefer Tailscale and a bearer token over public port forwarding.

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
hermes-sidecar --host 127.0.0.1 --port 8765
```

Use a custom Hermes home:

```bash
hermes-sidecar --hermes-home ~/.hermes --host 127.0.0.1 --port 8765
```

Environment variables are also supported:

```bash
export HERMES_HOME="$HOME/.hermes"
export HERMES_MGMT_HOST="127.0.0.1"
export HERMES_MGMT_PORT="8765"
export HERMES_MGMT_TOKEN="replace-with-a-long-random-token"
export HERMES_MGMT_CORS_ORIGINS="http://localhost:3000"
hermes-sidecar
```

If `HERMES_HOME` points at a named profile such as `~/.hermes/profiles/work`, the server normalizes the root back to `~/.hermes`. The `default` profile maps to the root; named profiles map to `~/.hermes/profiles/<name>`.

## Tailscale Setup

1. Install Tailscale on the Hermes machine and on the AgentUI machine.
2. Sign in to the same tailnet on both machines.
3. On the Hermes machine, create a token:

```bash
export HERMES_MGMT_TOKEN="$(openssl rand -base64 32)"
```

4. Start the sidecar on the Hermes machine:

```bash
HERMES_HOME="$HOME/.hermes" \
HERMES_MGMT_TOKEN="$HERMES_MGMT_TOKEN" \
hermes-sidecar --host 0.0.0.0 --port 8765
```

5. From the AgentUI machine, connect to:

```text
http://<tailscale-hostname>:8765/v1
```

Example:

```bash
curl -H "Authorization: Bearer $HERMES_MGMT_TOKEN" \
  http://<tailscale-hostname>:8765/v1/profiles
```

You can bind to a specific Tailscale IP instead of `0.0.0.0`:

```bash
hermes-sidecar --host 100.x.y.z --port 8765
```

Do not expose this service directly to the public internet without TLS and bearer-token auth. Memory and skills may contain sensitive local context.

## API

All responses are JSON. Errors use:

```json
{ "ok": false, "error": "..." }
```

When `HERMES_MGMT_TOKEN` is set, include:

```http
Authorization: Bearer <token>
```

### Health

```bash
curl http://127.0.0.1:8765/health
```

Returns `ok`, `checkedAt`, `hermesHome`, and `profilesRootExists`.

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
