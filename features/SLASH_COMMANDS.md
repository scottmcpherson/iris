# Slash Commands Implementation Plan

## Goal

Expose Hermes slash commands and skill slash commands inside the Iris chat composer.

When the user types `/` in the chat input, Iris should show a compact command list sourced from Hermes. The user can select a command with the keyboard or mouse, or press `Tab` to autocomplete the closest match.

Important UI direction: this is not the centered `CommandMenu` / command palette. It should be an anchored composer menu, like the model picker, positioned next to the chat input box where the slash command is being typed.

## Product Behavior

- Typing `/` at the start of the composer opens a slash command menu.
- Typing additional characters filters the list, for example `/re` shows `/reload-skills`, `/resume`, `/reasoning`, etc.
- The menu should be anchored to the composer/input area, not the viewport center.
- There should be no scrim, modal dialog, or global command-palette treatment.
- `Tab` autocompletes the first or currently highlighted match.
- `ArrowDown` / `ArrowUp` move the highlighted command.
- `Enter` selects the highlighted command while the menu is open and the command token is still partial.
- `Escape` closes the menu without changing the input.
- Clicking a command inserts it into the input.
- After insertion, focus returns to the textarea.
- Sending remains normal chat sending: Iris sends the slash text to Hermes through the gateway. Iris does not execute Hermes commands locally.

## Current Code Paths

Chat composer:

- `desktop/src/features/chat/ChatView.tsx`
  - The composer is the `<form className="composer">`.
  - The controlled `<textarea>` currently receives `input`, `onInput`, and handles Enter-to-send.
  - Existing anchored composer menus already exist for add context, profile, and model.

Chat state and sending:

- `desktop/src/features/chat/useHermesChat.ts`
  - `sendMessage()` reads the controlled input, creates optimistic state, then posts to Hermes through `sendHermesGatewayMessage(...)`.
  - Slash commands should go through this existing send path unchanged.

Hermes runtime data:

- `desktop/src/features/hermes/useHermesRuntime.ts`
  - Already refreshes profile-scoped Hermes state.
  - Already loads Hermes skills via `getHermesSkills(profile, config)`.

Bridge:

- `desktop/src/lib/hermes.ts`
  - Add bridge helpers for slash command discovery and optional completion.

- `desktop/src-tauri/python/hermes_bridge.py`
  - Add bridge actions that call the selected profile's Iris gateway endpoint.

Hermes plugin endpoint:

- `agentui-platform/adapter.py`
  - Add authenticated Iris endpoints that run inside the selected Hermes gateway/profile process.
  - This is the right runtime context for command discovery because it can import Hermes command registry, plugin command registration, quick commands, and skill command scanning.

## Source Of Truth

Hermes should own the command catalog.

Do not hardcode a parallel command list in Iris. Iris should request a catalog from the selected Hermes profile and render it. This keeps Iris aligned with:

- Hermes built-in slash commands.
- Hermes aliases.
- Hermes config-gated commands.
- `quick_commands` from `~/.hermes/config.yaml`.
- Plugin-registered slash commands.
- Skill slash commands from Hermes skill scanning.
- Disabled skills and platform-specific skill visibility.

Iris can filter and rank the already-fetched catalog locally for fast UI response, but the catalog itself should be Hermes-derived.

## Data Contracts

Add these types in `desktop/src/types/hermes.ts`.

```ts
export type HermesSlashCommandSource =
  | "hermes"
  | "skill"
  | "quick-command"
  | "plugin";

export type HermesSlashCommand = {
  id: string;
  name: string;
  text: string;
  label: string;
  description: string;
  category: string;
  source: HermesSlashCommandSource;
  aliases: string[];
  argsHint: string;
  subcommands: string[];
  requiresArgument: boolean;
};

export type HermesSlashCommandsResult = {
  ok: boolean;
  profile: string;
  commands: HermesSlashCommand[];
  generatedAt: number;
  warning?: string;
  error?: string;
};

export type HermesSlashCompletionItem = {
  text: string;
  display: string;
  meta?: string;
};

export type HermesSlashCompletionResult = {
  ok: boolean;
  items: HermesSlashCompletionItem[];
  replaceFrom: number;
  error?: string;
};
```

Add bridge helpers in `desktop/src/lib/hermes.ts`.

```ts
export async function getHermesSlashCommands(
  profile?: string,
  runtime?: HermesRuntimeConfig,
) {
  return bridge<HermesSlashCommandsResult>("slash_commands", {
    profile,
    ...runtimePayload(runtime),
  });
}

export async function completeHermesSlashCommand(
  text: string,
  profile?: string,
  runtime?: HermesRuntimeConfig,
) {
  return bridge<HermesSlashCompletionResult>("slash_complete", {
    text,
    profile,
    ...runtimePayload(runtime),
  });
}
```

The completion helper is optional for the first UI pass if the local catalog covers command-token completion well. Keep the type and bridge plan in the doc because Hermes already has completion behavior and it is the clean extension point for subcommands later.

## Backend Discovery

### Iris Platform Endpoints

Add authenticated endpoints in `agentui-platform/adapter.py`.

```http
GET /agentui/slash-commands
Authorization: Bearer <AGENTUI_TOKEN>
```

Response:

```json
{
  "ok": true,
  "profile": "default",
  "generatedAt": 1778080000,
  "commands": [
    {
      "id": "hermes:reload-skills",
      "name": "reload-skills",
      "text": "/reload-skills",
      "label": "/reload-skills",
      "description": "Re-scan ~/.hermes/skills/ for newly installed or removed skills",
      "category": "Tools & Skills",
      "source": "hermes",
      "aliases": ["reload_skills"],
      "argsHint": "",
      "subcommands": [],
      "requiresArgument": false
    },
    {
      "id": "skill:software-development",
      "name": "software-development",
      "text": "/software-development",
      "label": "/software-development",
      "description": "Invoke the software-development skill",
      "category": "Skills",
      "source": "skill",
      "aliases": [],
      "argsHint": "[instruction]",
      "subcommands": [],
      "requiresArgument": false
    }
  ]
}
```

Optional completion endpoint:

```http
POST /agentui/slash-complete
Authorization: Bearer <AGENTUI_TOKEN>
Content-Type: application/json

{ "text": "/re", "limit": 30 }
```

Response:

```json
{
  "ok": true,
  "items": [
    { "text": "/reload-skills", "display": "/reload-skills", "meta": "Re-scan ~/.hermes/skills/" }
  ],
  "replaceFrom": 1
}
```

### Catalog Implementation Notes

Inside `agentui-platform/adapter.py`, derive rows from Hermes runtime modules:

- Built-ins: `hermes_cli.commands.COMMAND_REGISTRY`.
- Gateway availability: use Hermes' gateway availability helpers if importable, or apply the same rule: show commands that are not `cli_only`, plus config-gated commands only when their gate is enabled.
- Aliases and argument hints: preserve `CommandDef.aliases`, `CommandDef.args_hint`, and `CommandDef.subcommands`.
- Quick commands: read `quick_commands` from Hermes config.
- Plugin commands: use `hermes_cli.plugins.get_plugin_commands()` if available.
- Skill commands: use `agent.skill_commands.scan_skill_commands()` so disabled skills, external skill dirs, platform filtering, and slug normalization match Hermes.

The endpoint should degrade gracefully:

- If plugin discovery fails, return built-ins and skills with a `warning`.
- If skill scanning fails, return built-ins with a `warning`.
- If the whole catalog fails, return `ok: false`, `commands: []`, and a clear error.

Recommended row rules:

- `text` always includes the leading slash.
- `name` never includes the leading slash.
- `label` should usually match `text`.
- `description` should be short enough for a single row.
- `requiresArgument` is `true` when `argsHint` starts with `<`.
- Skill commands should use category `Skills` and source `skill`.
- Quick commands should use category `User commands` and source `quick-command`.
- Plugin commands should use category `Plugins` and source `plugin`.

### Desktop Bridge Actions

Add handlers in `desktop/src-tauri/python/hermes_bridge.py`:

- `"slash_commands"`
- `"slash_complete"`

Both should route through the selected profile's Iris adapter endpoint, not the management sidecar.

Use the existing Iris gateway URL helpers already used for chat/model-adjacent bridge calls:

```py
url = agentui_gateway_endpoint(payload, "/agentui/slash-commands")
result = http_get_json(url, payload, timeout=8, token_kind="agentui")
```

For completion, use a JSON request:

```py
url = agentui_gateway_endpoint(payload, "/agentui/slash-complete")
result = http_json_request(
    url,
    payload,
    method="POST",
    body={"text": text, "limit": limit},
    timeout=8,
    token_kind="agentui",
)
```

Normalize casing for the frontend and preserve `url`, `status`, and `error` in failure results where useful.

## Frontend State

Create:

```txt
desktop/src/features/chat/useHermesSlashCommands.ts
```

Responsibilities:

- Accept `profile`, `runtimeConfig`, `connected`, and `refreshKey`.
- Load commands when profile, runtime routes, or refresh key changes.
- Cache by profile plus resolved Iris gateway URL.
- Track `loading`, `error`, and `warning`.
- Discard stale results if profile changes mid-request.
- Return an empty command list when disconnected.

Suggested return shape:

```ts
{
  commands,
  loading,
  error,
  warning,
  refreshSlashCommands,
}
```

Use it in `App.tsx` near `useHermesModelCatalog(...)`, then pass the results to `ChatView`.

```tsx
const slashCommands = useHermesSlashCommands({
  profile: hermes.selectedProfile,
  runtimeConfig: hermes.runtimeConfig,
  connected: hermes.connected,
  refreshKey: hermes.status?.checkedAt || 0,
});
```

Add props to `ChatView`:

```ts
slashCommands: HermesSlashCommand[];
slashCommandsLoading: boolean;
slashCommandsError: string | null;
onSlashCommandsRefresh: () => void;
```

## Composer UI

### Placement

The slash menu should be anchored to the composer input, not centered.

Recommended structure:

```tsx
<div className="composer-input-wrap" ref={composerInputRef}>
  <textarea ... />
  {slashMenuOpen ? (
    <div className="composer-slash-menu" role="listbox" ...>
      ...
    </div>
  ) : null}
</div>
```

Recommended CSS direction:

```css
.composer-input-wrap {
  position: relative;
}

.composer-slash-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 32;
  width: min(460px, 100%);
  max-height: 320px;
  overflow: auto;
}
```

This makes the menu feel like the model picker: attached to the composer, close to the control that opened it, and part of the chat surface.

Do not:

- Use `.command-scrim`.
- Use `role="dialog"` or centered modal layout.
- Reuse `CommandMenu`.
- Render a full-screen or viewport-centered overlay.

### Visual Design

Use the composer/menu language already in `App.css`:

- Background similar to `.composer-model-menu`.
- 8px row radius.
- Single-line command labels.
- Description/meta text on the right or second line, truncated.
- Stable width and max height.
- No nested cards.
- No explanatory text blocks inside the app.

Suggested row content:

- `Command` icon for Hermes commands.
- `Sparkles` or `Zap` icon for skill commands.
- Strong label: `/reload-skills`.
- Muted meta: `Tools & Skills` or short description.
- Optional `Tab` hint only for the active row if it does not create clutter.

### Filtering

Add pure helpers near the bottom of `ChatView.tsx` or in a small local module if tests get large:

```ts
function slashTokenAtCursor(value: string, cursor: number) {
  const before = value.slice(0, cursor);
  const lineStart = before.lastIndexOf("\n") + 1;
  const token = before.slice(lineStart);
  if (!token.startsWith("/")) return null;
  if (/\s/.test(token)) return null;
  return { from: lineStart, to: cursor, query: token.slice(1) };
}

function filterSlashCommands(commands: HermesSlashCommand[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands.slice(0, 30);
  return commands
    .map((command) => ({
      command,
      score: scoreSlashCommand(command, needle),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.command.text.localeCompare(b.command.text))
    .slice(0, 30)
    .map((row) => row.command);
}
```

Scoring rules:

- Exact command name match wins.
- Prefix match on `name` or `text` wins next.
- Prefix match on aliases follows.
- Substring match on name/aliases follows.
- Description/category matches are allowed but lower priority.
- Skills and commands should not be separated into different modes; they share one list.

### Keyboard Behavior

Inside textarea `onKeyDown`:

1. If slash menu is open and key is `ArrowDown`, prevent default and increment active index.
2. If slash menu is open and key is `ArrowUp`, prevent default and decrement active index.
3. If slash menu is open and key is `Tab`, prevent default and insert the active command.
4. If slash menu is open and key is `Enter` with no `Shift`, prevent default and insert the active command when the current slash token is partial.
5. If slash menu is closed and key is `Enter` with no `Shift`, keep the existing send behavior.
6. If key is `Escape`, close the menu.

Insertion rules:

```ts
function insertSlashCommand(command: HermesSlashCommand) {
  const suffix = command.requiresArgument || command.source === "skill" ? " " : "";
  const nextValue = input.slice(0, token.from) + command.text + suffix + input.slice(token.to);
  onInput(nextValue);
  requestAnimationFrame(() => {
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
  });
}
```

For skills, add a trailing space so the user can type an instruction after the skill invocation.

For commands with required args, add a trailing space.

For commands with no args, inserting the command without a trailing space is acceptable; pressing Enter after insertion sends it.

## Send Flow

Do not add a special command execution path in Iris.

The existing send path should send `/command ...` through:

```txt
ChatView -> useHermesChat.sendMessage() -> sendHermesGatewayMessage(...) -> Hermes gateway
```

This matters because Hermes command dispatch owns session state, permissions, model switching, background jobs, skill invocation messages, and plugin hooks.

## Error Handling

Catalog unavailable:

- Keep chat usable.
- Do not show a broken menu.
- If the user types `/` and commands are unavailable, show a small disabled menu row like `Commands unavailable` only if it fits the existing menu style.
- Prefer silent absence over an intrusive notification.

Disconnected:

- Do not open the slash menu unless there is a cached catalog for the current profile.

Refresh:

- Refresh slash commands when the user runs the global refresh.
- Refresh after `/reload-skills` is sent if a cheap hook is available. If not, the next global refresh is acceptable for first pass.

Race conditions:

- Do not apply a command result for an old profile after profile changes.
- If commands refresh while the menu is open, keep the highlighted index clamped.

## Tests

Add unit coverage for pure helpers, either in a new test file or alongside chat tests:

```txt
desktop/src/features/chat/__tests__/slashCommands.test.ts
```

Cover:

- `/` opens the full command list.
- `/re` ranks `/reload-skills` above weaker substring matches.
- Aliases are matched.
- Skill commands are included and receive a trailing space on insertion.
- Commands requiring args receive a trailing space.
- Commands without args can be inserted without a trailing space.
- `Escape` closes the menu.
- `Tab` completes the highlighted command.
- Arrow keys wrap or clamp predictably.
- Enter sends normally when the slash menu is closed.

Bridge tests:

- Add Python tests in `desktop/src-tauri/python/tests/test_hermes_bridge.py` for `slash_commands` and `slash_complete` normalization.
- Mock the Iris gateway response, similar to existing bridge endpoint tests.

Platform adapter tests:

- Add tests for the new endpoint if the adapter test harness supports it.
- Verify built-in command rows, quick command rows, plugin command failure degradation, and skill row normalization.

## Verification

Fast checks:

```sh
npm test -- desktop/src/features/chat/__tests__/slashCommands.test.ts
npm test -- desktop/src/features/chat/__tests__/useHermesChat.test.ts
npm --workspace desktop run test:bridge
npm run build
```

Because this is a visible chat UI change, final verification must follow `AGENTS.md`:

```sh
npm run build:mac:app
```

Then launch the fresh macOS app bundle and test with Computer Use against:

```txt
com.nousresearch.hermes-agent.desktop
```

Manual verification checklist:

- Type `/` in the chat composer.
- Confirm the menu appears attached to the composer/input, not centered.
- Confirm commands and skills appear in the same list.
- Type a partial command and confirm filtering.
- Use arrow keys and `Tab` to complete a command.
- Click a command and confirm the textarea retains focus.
- Send a simple command like `/help` or `/status`.
- Invoke a skill slash command with a short instruction and confirm Hermes treats it as a skill invocation.
- Switch profiles and confirm the catalog refreshes.

## Acceptance Criteria

- Slash commands are sourced from Hermes, not hardcoded in Iris.
- Hermes skill slash commands appear alongside built-in commands.
- The slash menu is anchored to the chat composer/input, visually aligned with the model picker style.
- `Tab` autocompletes the closest/highlighted match.
- Keyboard and mouse selection both work.
- Sending slash commands uses the normal Hermes gateway message path.
- Chat remains usable if command discovery fails.
- Final verification uses a fresh Tauri app build and Computer Use against the app bundle id.
