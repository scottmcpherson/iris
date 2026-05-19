# Iris Core

Iris Core is the local-first control plane for Iris. It owns devices, auth, runtime routing, and Core-only coordination, and connects to Hermes through the Iris Hermes Adapter. Hermes itself remains untouched and remains the source of truth for Hermes profiles, sessions, messages, jobs, memory, skills, models, and command catalogs. Normal Iris sessions enter Hermes through the `iris` platform adapter, while this service exposes normalized adapter-backed records and live delivery events over HTTP from the machine where Hermes is running.

Product terminology uses "sessions" for user-facing work threads. Hermes-level adapter metadata may still carry lower-level `chat` identifiers when Hermes requires them.

This service lives in the `iris-core/` workspace of the Iris monorepo.

The default bind address is `127.0.0.1`. For remote use, prefer Tailscale and a bearer token over public port forwarding. Non-loopback binds require `IRIS_TOKEN` or an active paired device token.

## Install

From the monorepo root:

```bash
npm run core:setup
```

From this `iris-core/` directory:

```bash
python3.11 -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
```

Run tests from the monorepo root:

```bash
npm run core:test
```

## Run Locally

From the monorepo root:

```bash
npm run core:dev
```

From this `iris-core/` directory:

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
export IRIS_TOKEN="replace-with-a-long-random-token"
export IRIS_CORE_CORS_ORIGINS="http://localhost:3000"
iris-core
```

If `HERMES_HOME` points at a named profile such as `~/.hermes/profiles/work`, the server normalizes the root back to `~/.hermes`. The `default` profile maps to the root; named profiles map to `~/.hermes/profiles/<name>`.

Same-machine loopback development can omit `IRIS_TOKEN`; auth headers are omitted in that mode. Remote or other non-loopback Core/plugin traffic requires `IRIS_TOKEN`. Core uses `HERMES_API_TOKEN` when set, otherwise it discovers Hermes' `API_SERVER_KEY` from `$HERMES_HOME/.env` for Jobs API calls. The old `/v1/inbox/*` routes are gone; Hermes deliveries use `POST /v1/runtime-deliveries/hermes`.

Core-owned service state defaults to `~/.iris/core.sqlite3`. On startup, the default `~/.agent-ui/core.sqlite3` path is migrated into `~/.iris/core.sqlite3` with timestamped backups, then duplicate runtime-owned tables are removed. To run the migration manually:

```bash
iris-core migrate-source-of-truth --backup
```

Set `IRIS_CORE_DISABLE_SOURCE_OF_TRUTH_MIGRATION=1` only as a temporary rollback guard.

## Bundled Desktop Sidecar

Release builds package Iris Core as a standalone sidecar binary inside `Iris.app`. Build it from the monorepo root:

```bash
npm run core:build:binary
```

The output is `iris-core/dist/iris-core`. The desktop build stages that binary into Tauri's `externalBin` location before bundling:

```bash
npm run build:mac:app
```

When Iris Desktop opens, Tauri probes `127.0.0.1:8765/v1/health`. If a version-matched Iris Core is already running, the app uses it. If nothing is listening, the app starts the bundled sidecar with `IRIS_CORE_MANAGED=1` and writes logs to `~/Library/Logs/Iris/core.log`. If another service or a mismatched Core owns the port, Settings surfaces the conflict instead of silently switching ports.

Health responses include `service`, `version`, `pid`, `managed`, `bindHost`, and `port` so Desktop can fail loudly when Core and Desktop versions differ.

## Hermes Plugin Installer

The Core binary carries a version-matched `iris-platform` payload and can install or update it:

```bash
iris-core install-hermes-plugin --hermes-home ~/.hermes --host 127.0.0.1 --port 8765
```

The command copies the bundled plugin to `$HERMES_HOME/plugins/iris-platform`, runs `hermes plugins enable iris-platform` when the Hermes CLI is available, updates `.env` hints for `IRIS_BASE_URL`, `IRIS_TOKEN` when set, `IRIS_INBOUND_HOST`, and `IRIS_INBOUND_PORT` (default `8766`), then prints a reminder to restart the Hermes gateway. Use `--inbound-port` if the Hermes plugin listener needs a non-default port.

## Remote Mac Setup

### SSH Mode

SSH mode keeps Core private on the Hermes Mac:

```text
MacBook Iris -> 127.0.0.1:<local-forward-port> -> ssh -> Mac mini 127.0.0.1:8765
```

Run Core on the Mac that owns Hermes, preferably through Iris Desktop or the LaunchAgent service below. On the client Mac, Settings -> Iris Core -> SSH uses system OpenSSH with `BatchMode=yes`, the user's normal `~/.ssh/config`, `known_hosts`, and ssh-agent. Host-key and auth failures should be fixed in Terminal first, for example:

```bash
ssh user@mac-mini.local true
```

Core remains bound to `127.0.0.1` on the remote Mac, and the default SSH tunnel path does not require a Core bearer token.

### Tailscale Mode

1. Install Tailscale on the Hermes machine and on the Iris client machine.
2. Sign in to the same tailnet on both machines.
3. On the Hermes machine, open Iris Settings -> This Mac, enable Tailscale connections, enter the Tailscale IP or MagicDNS name, and create a pairing token.
4. Install or update the Core login service bound to the selected Tailscale/private address.
5. On the client Mac, open Settings -> Tailscale, enter the same host and port, paste the paired device token, and connect.

CLI-only setup is also possible. On the Hermes machine, create a temporary management token:

```bash
export IRIS_TOKEN="$(openssl rand -base64 32)"
```

Start Iris Core on the Hermes machine:

```bash
HERMES_HOME="$HOME/.hermes" \
IRIS_TOKEN="$IRIS_TOKEN" \
iris-core --host 100.x.y.z --port 8765
```

Pair each remote client and copy the returned `token` once:

```bash
curl -X POST http://<tailscale-hostname>:8765/v1/devices/pair \
  -H "Authorization: Bearer $IRIS_TOKEN" \
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

Do not default to public interfaces such as `0.0.0.0`. Prefer a specific `100.x.y.z` address:

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

When `IRIS_TOKEN` is set, include it as a bearer token on the pairing request. The pairing response shows the device token once. Core stores only a token hash.

List devices:

```bash
curl -H "Authorization: Bearer $IRIS_TOKEN" \
  http://127.0.0.1:8765/v1/devices
```

Revoke a device:

```bash
curl -X DELETE -H "Authorization: Bearer $IRIS_TOKEN" \
  http://127.0.0.1:8765/v1/devices/dev_...
```

Verify a second client without Hermes filesystem access:

```bash
curl -H "Authorization: Bearer <paired-device-token>" \
  'http://<tailscale-hostname>:8765/v1/sessions?agentId=<agent-id>'

curl -H "Authorization: Bearer <paired-device-token>" \
  'http://<tailscale-hostname>:8765/v1/events?after=0&limit=50&agentId=<agent-id>'
```

The second client needs only the Core URL and paired device token. It should not read `~/.hermes`, Hermes SQLite files, or the Iris Core SQLite file directly.

## LaunchAgent Service

For a durable local agent host on macOS, install Core as a LaunchAgent:

```bash
iris-core service install --replace --host 127.0.0.1 --port 8765 --hermes-home "$HOME/.hermes"
iris-core service status
iris-core service uninstall
```

The service label is `com.nousresearch.iris-core`. The plist lives at `~/Library/LaunchAgents/com.nousresearch.iris-core.plist`, with logs under `~/Library/Logs/Iris/`.

For SSH access from another Mac, keep the service bound to `127.0.0.1`. For Tailscale access, bind to the selected Tailscale/private IP, pair per-device tokens, and keep CORS disabled unless a browser client has an explicit trusted origin.

## API

All responses are JSON. Errors use:

```json
{ "ok": false, "error": "..." }
```

When `IRIS_TOKEN` is set, or when Core is bound to a non-loopback host, include either the Iris token or a paired device token:

```http
Authorization: Bearer <token>
```

### Health

```bash
curl http://127.0.0.1:8765/health
```

Returns `ok`, `checkedAt`, `hermesHome`, and `profilesRootExists`.
`/v1/health` also returns Core identity fields used by Desktop: `service`, `version`, `pid`, `managed`, `bindHost`, and `port`.

### Runtime Deliveries

Hermes adapter deliveries enter Core through `POST /v1/runtime-deliveries/hermes`.
Clients read live delivery activity from `/v1/events` or `/v1/events/stream`.
The old `/v1/inbox/*` routes return 404.


### Status

```bash
curl http://127.0.0.1:8765/v1/status
```

Returns `ok`, `checkedAt`, `hermesHome`, `activeProfile`, and `profileCount`.

### Agents

```bash
curl http://127.0.0.1:8765/v1/agents
curl http://127.0.0.1:8765/v1/agents/<agent_id>
```

Each agent includes its Core id, runtime id, runtime kind, display name, runtime profile, default status, and runtime metadata. Legacy `/v1/profiles/**` routes remain compatibility shims and delegate through the same runtime adapter methods.

### Memory

```bash
curl http://127.0.0.1:8765/v1/agents/<agent_id>/memory
curl -X PUT http://127.0.0.1:8765/v1/agents/<agent_id>/memory/memory \
  -H "Content-Type: application/json" \
  -d '{"content":"updated memory"}'
```

Returns metadata and content for `MEMORY.md` and `USER.md`.

### Sessions

```bash
curl 'http://127.0.0.1:8765/v1/sessions?agentId=<agent_id>&limit=80'
```

Returns existing runtime sessions for the selected agent without requiring the client to read runtime files or SQLite directly. `limit` defaults to `80` and is clamped to `1..200`.

Response shape:

```json
{
  "ok": true,
  "sessions": [
    {
      "id": "session_abc",
      "agentId": "agent_abc_default",
      "title": "How do I list profiles?",
      "preview": "Use the profiles endpoint.",
      "updatedAt": 1777804079
    }
  ]
}
```

Session discovery is schema-tolerant and read-only inside the Hermes runtime adapter. The adapter inspects Hermes-local stores and falls back to session JSON when no supported SQLite session table exists. Unsupported stores fail soft with an empty list and a warning.

### Skills

```bash
curl http://127.0.0.1:8765/v1/agents/<agent_id>/skills
curl http://127.0.0.1:8765/v1/agents/<agent_id>/skills/<skill_id>
```

Skill ids are URL-safe base64 encodings of the relative `SKILL.md` path under the selected profile's `skills` directory. The server rejects ids that decode to absolute paths, parent traversal, or anything other than a `SKILL.md` file.

## Security Notes

- The service is read-only.
- It never accepts arbitrary file paths from clients.
- Profile names are limited to letters, numbers, dots, dashes, and underscores.
- Memory, skill, and session reads are resolved and checked so they stay inside the selected profile directory.
- Session discovery opens SQLite stores in read-only mode and never writes to Hermes databases or session files.
- CORS is disabled by default. Set `IRIS_CORE_CORS_ORIGINS` to a comma-separated allowlist when browser clients need direct access.
