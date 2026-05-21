# Iris Hermes Adapter

Bidirectional Hermes platform adapter for Iris.

Iris sends chat messages into Hermes through this platform, and Hermes delivers
responses and scheduled job output back into Iris Core.

## Install

On the machine running Hermes:

```bash
iris-core install-hermes-plugin --hermes-home ~/.hermes --host 127.0.0.1 --port 8765
```

Iris Desktop exposes the same action in first-run Local Hermes setup and in Settings -> Local -> Service management -> Install Iris adapter. The installer copies the version-matched plugin bundled with Iris Core, enables `iris-platform` when the Hermes CLI is available, writes Iris env hints, and then requires a Hermes gateway restart.

Manual installation remains useful for plugin development:

```bash
mkdir -p ~/.hermes/plugins
cp -R iris-platform ~/.hermes/plugins/iris-platform
hermes plugins enable iris-platform
```

Or install from a Git repository:

```bash
hermes plugins install https://github.com/<org>/iris-platform.git --enable
```

## Configure

Set these values where the Hermes gateway process can read them:

```bash
export IRIS_BASE_URL="http://127.0.0.1:8765"
export IRIS_DEFAULT_CHAT_ID="desktop"
export IRIS_INBOUND_HOST="127.0.0.1"
export IRIS_INBOUND_PORT="8766"
export IRIS_ALLOWED_USERS="iris-user"
```

Then restart the Hermes gateway process or service.

For both local Iris and Iris Desktop over SSH, `IRIS_BASE_URL` should point at
Core on loopback from the Hermes host's point of view. Iris Desktop reaches a
remote host by opening an SSH tunnel to that host; the adapter still talks to
`127.0.0.1:8765` on the host running Hermes. Explicit Hermes delivery targets
should use the `iris:` platform prefix.

Enable gateway streaming in each Hermes profile that should stream into Iris:

```yaml
streaming:
  enabled: true
```

`display.streaming` only controls the terminal UI and does not enable platform
message edits.

Keep Iris Core and this plugin on the host that owns Hermes. Core should remain
bound to `127.0.0.1`; Iris Desktop reaches remote hosts through SSH, so the
plugin can use the same loopback config locally and remotely. Direct
private-network Core URLs are not a supported Iris Desktop setup path.

## Chat Inbound

Iris posts user messages to the host running Hermes:

```bash
curl -X POST http://127.0.0.1:8766/iris/messages \
  -H "Content-Type: application/json" \
  -d '{"chatId":"desktop","userId":"scott","userName":"Scott","messageId":"test-1","text":"hello"}'
```

Product-supported local and SSH paths normally omit authorization headers
because traffic is loopback on the Hermes host. `IRIS_TOKEN` is only for
unsupported low-level non-loopback operator setups, not Iris Desktop.

The adapter converts each POST into a Hermes `MessageEvent` with
`platform=iris`, so Hermes owns session routing, tool execution, and cron
origin capture.

## Cron Delivery

Jobs created from an Iris-originated chat can use the normal Hermes origin
delivery path:

```text
deliver="origin"
```

Explicit Iris targets use the `iris:` delivery prefix:

```bash
hermes cron create "10m" "Reply exactly: stretch before your next call" --deliver "iris:desktop" --name "Iris reminder"
```
