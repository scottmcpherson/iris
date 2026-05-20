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
export IRIS_BASE_URL="http://<iris-core-host>:8765"
export IRIS_TOKEN="<iris bearer token>"
export IRIS_DEFAULT_CHAT_ID="desktop"
export IRIS_INBOUND_HOST="127.0.0.1"
export IRIS_INBOUND_PORT="8766"
export IRIS_ALLOWED_USERS="iris-user"
```

Then restart the Hermes gateway process or service.

`IRIS_TOKEN` may be omitted only when `IRIS_BASE_URL` points at loopback
(`localhost`, `127.0.0.1`, or `::1`). Non-loopback Core traffic requires
`IRIS_TOKEN`. Explicit Hermes delivery targets should use the `iris:` platform
prefix.

Enable gateway streaming in each Hermes profile that should stream into Iris:

```yaml
streaming:
  enabled: true
```

`display.streaming` only controls the terminal UI and does not enable platform
message edits.

Use a private network address for direct remote delivery. Keep Iris Core bound to `127.0.0.1` for local-only use and for Hermes via SSH, or bind it to a private interface only when you intentionally use non-loopback Core traffic with a bearer token or paired device token.

For Hermes via SSH, keep Iris Core and this plugin on the host that owns Hermes. Core can remain bound to `127.0.0.1`; Iris Desktop reaches it through an SSH tunnel, so the plugin can also use loopback config.

For direct private-network setups such as Tailscale, bind Iris Core to the selected private IP and use a paired device token for non-loopback Core traffic. Do not expose Core on a public interface.

## Chat Inbound

Iris posts user messages to the host running Hermes:

```bash
curl -X POST http://127.0.0.1:8766/iris/messages \
  -H "Authorization: Bearer $IRIS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chatId":"desktop","userId":"scott","userName":"Scott","messageId":"test-1","text":"hello"}'
```

Omit the `Authorization` header for loopback-only setups where `IRIS_TOKEN` is
unset.

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
