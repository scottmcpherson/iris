# Remove Inbox SQLite Implementation

Status: Complete.

## Goal

Remove `~/.iris/inbox.sqlite3` so Iris Core has one durable database:

```text
~/.iris/core.sqlite3
```

The legacy inbox API should remain as a compatibility facade for older Iris
Hermes Adapter health checks and manual delivery calls, but it must not create
or write a second SQLite database.

## Current Problem

Older sidecar builds used `sidecar/src/hermes_management_server/inbox_store.py`
to create `~/.iris/inbox.sqlite3` for `/v1/inbox/*` routes.

Normal desktop chat no longer uses that database:

- Desktop chat reads live delivery events from `/v1/events`.
- Hermes adapter sends assistant deliveries to `/v1/runtime-deliveries/hermes`.
- Conversation history comes from Hermes through runtime adapters.

The remaining issue is compatibility:

- `agentui-platform/adapter.py` calls `/v1/inbox/health` on connect.
- Legacy `/v1/inbox/messages` can still receive manual or old adapter-style
  deliveries.

Those routes should continue to work without persistence.

## Target Behavior

- Delete the SQLite-backed `InboxStore`.
- Remove `IRIS_INBOX_STORE` and `AGENTUI_INBOX_STORE` from active runtime
  behavior.
- `/v1/inbox/health` returns `ok`, `checkedAt`, and an empty/deprecated path
  without touching the filesystem.
- `POST /v1/inbox/messages` validates the payload, publishes a live Core event,
  and returns the accepted message shape.
- `GET /v1/inbox/messages` returns recent live events from the in-memory
  delivery bus, best effort only.
- `POST /v1/inbox/messages/{id}/ack` marks the matching live event acknowledged
  in memory when it is still present.
- No code path creates `~/.iris/inbox.sqlite3`.
- Delete any existing local `~/.iris/inbox.sqlite3` after the code no longer
  needs it.

## Files

- `sidecar/src/hermes_management_server/main.py`
- `sidecar/src/hermes_management_server/models.py`
- `sidecar/src/hermes_management_server/inbox_store.py` (deleted)
- `sidecar/tests/test_api.py`
- `sidecar/README.md`
- `README.md`
- `features/AGENT_UI_CORE_API.md`

## Verification

```bash
npm run sidecar:test
npm run check
npm run build:mac:app
```

Manual check:

```bash
find ~/.iris -maxdepth 1 -type f -print
```

Expected:

- `core.sqlite3` may exist.
- `inbox.sqlite3` should not exist.
