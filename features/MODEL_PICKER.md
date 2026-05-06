# Model Picker Implementation Plan

## Goal

Add a profile-scoped model picker to the Iris chat composer.

The user should be able to pick an available Hermes model before starting a chat. The available models must come from the selected Hermes profile, because each profile can have different provider credentials, config, gateway port, and model catalog.

The first implementation should use Hermes' existing session-scoped `/model` command under the hood for switching. Do not make profile selection carry the model-selection job unless the product explicitly changes to "profile equals model preset".

## Product Behavior

- The chat composer should replace the static `Hermes` model chip with a model menu.
- The model menu is profile-scoped. Changing profiles refreshes the catalog for the new profile.
- On a new conversation, the user can select a model before sending the first prompt.
- Once a conversation has started, lock the model picker for that conversation in the first pass.
- During an active request, disable the picker.
- If model catalog discovery fails, keep chat usable and show the current profile model as a disabled fallback.
- Do not render hidden `/model` command messages in the transcript.
- Do not expose provider API keys or credential details to the frontend.

## Current Code Paths

Chat UI:

- `desktop/src/features/chat/ChatView.tsx`
  - The static composer model chip currently lives near the composer actions as `.composer-model`.
  - The profile selector already exists in the composer and locks after a conversation starts.

Chat state and sending:

- `desktop/src/features/chat/useHermesChat.ts`
  - `sendMessage()` creates the `gatewayChatId`.
  - Normal chat sends through `sendHermesGatewayMessage(...)`.
  - New conversations use optimistic local state before Hermes history refresh catches up.

Bridge:

- `desktop/src/lib/hermes.ts`
  - `runtimePayload()` forwards the runtime config into Tauri bridge calls.
  - `sendHermesGatewayMessage(...)` posts to bridge action `gateway_message`.

- `desktop/src-tauri/python/hermes_bridge.py`
  - `gateway_message(payload)` sends Iris messages to the profile's Iris inbound adapter endpoint.
  - `agentui_gateway_base_url(payload)` already supports profile-specific derived Iris gateway URLs.
  - `agentui_platform_token(payload)` already resolves `AGENTUI_TOKEN` / `AGENTUI_INBOX_TOKEN`.

Iris Hermes platform adapter:

- `agentui-platform/adapter.py`
  - `_inbound_message()` receives Iris chat messages, builds a Hermes `MessageEvent`, and calls `await self.handle_message(event)`.
  - This adapter runs inside the selected Hermes gateway/profile process, so it is the right place to ask Hermes which models are available for that profile.

Hermes local implementation details to rely on:

- Hermes `MessageEvent` has `raw_message`, but no first-class `model` field.
- Hermes does have session-scoped `/model` support.
- Hermes exposes the structured picker helper `hermes_cli.model_switch.list_authenticated_providers(...)`.
- Hermes API server `GET /v1/models` only advertises the API server model name and is not enough for this picker.

## Data Contracts

Add these TypeScript types in `desktop/src/types/hermes.ts`.

```ts
export type HermesModelProvider = {
  slug: string;
  name: string;
  isCurrent: boolean;
  isUserDefined: boolean;
  models: string[];
  totalModels: number;
  source: string;
};

export type HermesModelSelection = {
  provider: string;
  model: string;
  providerName?: string;
};

export type HermesModelCatalog = {
  ok: boolean;
  profile: string;
  current: HermesModelSelection | null;
  providers: HermesModelProvider[];
  generatedAt: number;
  url?: string;
  error?: string;
};
```

Add this bridge helper in `desktop/src/lib/hermes.ts`.

```ts
export async function getHermesModelCatalog(
  profile?: string,
  runtime?: HermesRuntimeConfig,
) {
  return bridge<HermesModelCatalog>("models", {
    profile,
    ...runtimePayload(runtime),
  });
}
```

## Backend Discovery

### Preferred Path

Expose model catalog discovery from the Iris platform adapter.

Add a new authenticated endpoint in `agentui-platform/adapter.py`:

```http
GET /agentui/models?maxModels=100
Authorization: Bearer <AGENTUI_TOKEN>
```

Response:

```json
{
  "ok": true,
  "profile": "default",
  "current": {
    "provider": "openai-codex",
    "model": "gpt-5.5",
    "providerName": "OpenAI Codex"
  },
  "providers": [
    {
      "slug": "openai-codex",
      "name": "OpenAI Codex",
      "isCurrent": true,
      "isUserDefined": false,
      "models": ["gpt-5.5", "gpt-5.4"],
      "totalModels": 2,
      "source": "built-in"
    }
  ],
  "generatedAt": 1778080000
}
```

Implementation notes:

- Register the route in `_start_inbound_server()`.
- Reuse `_authorized(request)`.
- Clamp `maxModels` to a reasonable range, for example `1..200`.
- Load current model/provider from Hermes config using gateway internals available in the running process.
- Call `list_authenticated_providers(...)` from `hermes_cli.model_switch`.
- Use the profile/gateway process environment as-is. Do not try to read another profile's config from this endpoint.
- Return `ok: false` with a clear `error` if model discovery throws.

Sketch:

```py
async def _inbound_models(self, request):
    if not self._authorized(request):
        return web.json_response({"ok": False, "error": "Unauthorized"}, status=401)

    max_models = safe_int(request.query.get("maxModels"), 100)
    max_models = min(max(max_models, 1), 200)

    try:
        from gateway.run import _load_gateway_config
        from hermes_cli.config import get_compatible_custom_providers
        from hermes_cli.model_switch import list_authenticated_providers
        from hermes_cli.providers import get_label

        cfg = _load_gateway_config() or {}
        model_cfg = cfg.get("model", {})
        current_model = ""
        current_provider = "openrouter"
        current_base_url = ""

        if isinstance(model_cfg, str):
            current_model = model_cfg
        elif isinstance(model_cfg, dict):
            current_model = str(model_cfg.get("default") or model_cfg.get("model") or "")
            current_provider = str(model_cfg.get("provider") or current_provider)
            current_base_url = str(model_cfg.get("base_url") or "")

        custom_providers = get_compatible_custom_providers(cfg)
        providers = list_authenticated_providers(
            current_provider=current_provider,
            current_base_url=current_base_url,
            current_model=current_model,
            user_providers=cfg.get("providers"),
            custom_providers=custom_providers,
            max_models=max_models,
        )

        return web.json_response({
            "ok": True,
            "profile": self.profile,
            "current": {
                "provider": current_provider,
                "model": current_model,
                "providerName": get_label(current_provider),
            } if current_model else None,
            "providers": providers,
            "generatedAt": int(time.time()),
        })
    except Exception as exc:
        return web.json_response({
            "ok": False,
            "profile": self.profile,
            "providers": [],
            "current": None,
            "generatedAt": int(time.time()),
            "error": str(exc),
        }, status=500)
```

### Desktop Bridge Action

Add bridge action `"models"` in `desktop/src-tauri/python/hermes_bridge.py`.

Implementation:

- Resolve the selected profile from `profile_name_from_payload(payload)`.
- Build URL with `agentui_gateway_endpoint(payload, "/agentui/models?...")`.
- Use `http_get_json(..., token_kind="agentui")`.
- Normalize provider rows to frontend casing.
- Preserve `url`, `status`, and `error` for troubleshooting.
- If the endpoint is unavailable, return a structured `ok: false` result.

Important: this call must go through the profile's Iris adapter endpoint, not the root management sidecar, so remote/profile-specific credentials remain correct.

### Runtime Config

`HermesRuntimeConfig` already has optional `agentuiGatewayUrls?: Record<string, string>`, and the bridge already knows how to derive Iris gateway URLs from profile API URLs using the port offset.

Follow-up cleanup:

- Add `agentuiGatewayUrls` to `defaultRuntimeConfig`.
- Normalize/load/save it like `profileApiUrls`.
- In settings, do not expose this until needed. Derivation is fine for local profile gateway ports.

## Frontend State

Create a small hook for profile-scoped catalogs, for example:

```txt
desktop/src/features/chat/useHermesModelCatalog.ts
```

Responsibilities:

- Accept `profile`, `runtimeConfig`, and `connected`.
- Load the catalog when profile or relevant runtime routes change.
- Track loading/error per profile.
- Cache by profile plus resolved Iris gateway URL.
- Invalidate on:
  - profile change
  - profile connection settings save
  - global refresh
  - profile create/clone/rename/delete
  - explicit catalog refresh from the menu
- Guard against races when the user switches profiles while a catalog request is in flight.

Suggested returned state:

```ts
{
  catalog,
  currentSelection,
  draftSelection,
  loading,
  error,
  selectDraftModel,
  refreshModelCatalog,
  modelLabel,
}
```

Selection rules:

- If the user has a saved draft selection for the profile and it still exists in the catalog, use it.
- Otherwise use `catalog.current`.
- Otherwise use the profile summary model/provider.
- Persist last draft selection per profile in localStorage, for example `hermes.desktop.modelSelectionByProfile`.
- Remove a persisted selection if it is no longer present in the refreshed catalog.

## Chat Send Flow

Extend `useHermesChat.sendMessage()` to accept a model selection.

Current shape:

```ts
sendMessage(attachments?: MessageAttachment[])
```

Target shape:

```ts
sendMessage(options?: {
  attachments?: MessageAttachment[];
  modelSelection?: HermesModelSelection | null;
})
```

Compatibility shortcut: allow ChatView to pass attachments through a wrapper if a broader signature touches too many tests.

New first-message flow:

1. User selects profile.
2. Hook loads catalog for that profile.
3. User selects model.
4. User sends first prompt.
5. `sendMessage()` creates or reuses the `gatewayChatId`.
6. If this is a brand-new conversation and selected model differs from the profile current model, send hidden command first:

```txt
/model <model> --provider <provider>
```

7. Use the same `chatId`, same `profile`, and a generated hidden `messageId`.
8. Wait for `sendHermesGatewayMessage(...)` to return.
9. Then send the real user prompt to the same `chatId`.
10. Store the selected model against the conversation in local state so the UI can show and lock it.

Why waiting for the POST is enough:

- The Iris adapter awaits `self.handle_message(event)` before returning from `_inbound_message()`.
- The Hermes `/model` command writes the session override before returning.
- The next message on the same `chatId` should see that session override.

Risk:

- The bridge currently only knows that the hidden command was accepted, not whether Hermes returned `Model switched` or `Error`.
- Better version: mark the hidden command with metadata and wait for the matching inbox reply with a short timeout.
- Acceptable first pass: if the hidden command POST fails, abort send and show an error. If Hermes accepts but the model command itself fails, the actual prompt may run on the old model. This should be tightened before calling the feature done.

Recommended robust pass:

- Add `hidden: true` metadata to the hidden command.
- Teach `agentui-platform` to copy inbound `metadata` from payload into `raw_message`.
- Ensure gateway responses include `replyTo` for command responses if possible.
- In `pollGatewayInbox()`, consume hidden command replies without rendering them.
- If content starts with `Error:` or contains a known failure phrase, abort the pending user prompt and show a composer-level error.
- If content starts with `Model switched to`, continue the real prompt immediately.

## UI Design

Update `ChatView.tsx`:

- Replace `.composer-model` static span with a button/menu.
- Use `Zap`, `ChevronDown`, `Check`, and optionally `RefreshCw` from `lucide-react`.
- Keep the control compact, similar to the current profile menu.
- Display text should be the selected model short name, for example `gpt-5.5`.
- Tooltip should say why disabled:
  - "Model is locked for this conversation"
  - "Models are loading"
  - "Connect Hermes to select a model"
  - "No model catalog available"
- Menu groups by provider.
- Include a refresh icon/button inside the menu or as a menu item.
- Do not add explanatory in-app text blocks.

Locking behavior:

- New empty chat: profile selector and model selector are enabled.
- Existing conversation: both profile and model are locked.
- Active request: both are disabled.

CSS:

- Reuse composer menu styles where possible.
- Keep stable dimensions so model label changes do not shift the send button.
- Ensure long model names truncate with ellipsis.
- Do not introduce a card inside the composer.

## Conversation Metadata

Extend optimistic conversation creation so it stores the selected model:

- `optimisticConversationFromPrompt(...)` currently sets `model: ""`.
- Add optional `model` parameter and set it to selected model.

Also add local state if needed:

```ts
const [modelSelectionByConversation, setModelSelectionByConversation] =
  useState<Record<string, HermesModelSelection>>({});
```

Use this to:

- Lock and display the model for optimistic conversations.
- Show a useful label before Hermes history has the session row.
- Clear/migrate it when optimistic conversation IDs are replaced by real IDs.

Existing Hermes history may provide `conversation.model`. Prefer explicit local selection while optimistic, then accept server history after refresh.

## Error Handling

Catalog errors:

- Show disabled fallback chip with current profile model if available.
- Menu can include a refresh action.
- Do not block chat if no catalog exists.

Switch errors:

- If hidden `/model` POST fails, do not send the real user prompt.
- Restore input and attachments.
- Replace the optimistic assistant message with the switch error or show a composer notice.

Race conditions:

- If profile changes while catalog is loading, discard the stale result.
- If selected model disappears after refresh, fall back to profile current model.
- If user sends while catalog is loading, use current saved selection if valid; otherwise profile current model.

Security:

- Do not return API keys, token source, credential store paths, or provider secrets from `/agentui/models`.
- Keep the endpoint behind the existing `AGENTUI_TOKEN`.

## Tests

Frontend unit tests:

- `desktop/src/features/chat/__tests__/useHermesChat.test.ts`
  - New conversation sends hidden `/model` before real prompt when selection differs.
  - Existing conversation does not send hidden `/model`.
  - Model selection migrates from optimistic conversation ID to real conversation ID.
  - Failed hidden command POST prevents real prompt.

- Add tests for the catalog hook.
  - Loads on profile change.
  - Ignores stale profile results.
  - Falls back when catalog is unavailable.
  - Drops persisted selection if missing from catalog.

Python bridge tests:

- `desktop/src-tauri/python/tests/test_hermes_bridge.py`
  - `models` action calls the profile-specific Iris gateway URL.
  - `models` action uses `AGENTUI_TOKEN`.
  - Unavailable model endpoint returns structured `ok: false`.
  - Provider rows normalize to frontend casing.

Sidecar tests:

- No management sidecar tests are required unless the model catalog is added there. The preferred path is the Iris adapter endpoint.

Adapter tests:

- Add focused tests if a plugin test harness already exists.
- Otherwise manually exercise with `curl` during final verification.

## Manual Verification

For the eventual visible UI implementation, follow `AGENTS.md`:

1. Run fast checks while iterating:

```bash
npm run check
```

2. Build a fresh macOS app bundle:

```bash
npm run build:mac:app
```

3. Launch the fresh bundle, not the raw Tauri dev binary:

```bash
open -n "/Users/scott/Development/agent-ui/desktop/src-tauri/target/release/bundle/macos/Iris.app"
```

4. Use Computer Use against:

```txt
com.nousresearch.hermes-agent.desktop
```

5. Verify:

- Default profile loads a model catalog.
- Switching to another profile refreshes the model list.
- A model selected in profile A does not appear selected in profile B unless both catalogs contain it and it was separately selected.
- Sending the first message after selecting a model uses the chosen model.
- Hidden `/model` command is not shown in the transcript.
- Existing conversation locks the picker.
- Active request disables the picker.
- Failed catalog endpoint does not block normal chat.

## Implementation Order

1. Add the `GET /agentui/models` endpoint to `agentui-platform/adapter.py`.
2. Add bridge action `"models"` to `desktop/src-tauri/python/hermes_bridge.py`.
3. Add TypeScript model catalog types and `getHermesModelCatalog(...)`.
4. Add the profile-scoped catalog hook.
5. Replace the static composer model chip with the picker.
6. Thread selected model into `useHermesChat.sendMessage()`.
7. Implement hidden `/model` before first real prompt.
8. Add tests.
9. Run `npm run check`.
10. Run `npm run build:mac:app` and verify with Computer Use.

## Open Questions

- Should model selection be allowed mid-conversation later? Hermes supports session-scoped switches, but locking first avoids confusing history and transcript identity.
- Should Iris eventually own a provider-neutral model catalog instead of showing Hermes' curated provider list directly?
- Should model choice be stored in Iris conversation metadata permanently, even after Hermes history refresh?
- Should Settings expose explicit `agentuiGatewayUrls` overrides for remote profiles where the port-offset derivation is wrong?

## Future Direction

This first implementation is Hermes-adapter-first but should not trap Iris into being Hermes-only.

Longer term, Iris should own a provider-neutral runtime contract:

```txt
Iris Core
  - projects
  - conversations
  - memories
  - files
  - automations
  - run history
  - permissions
  - model selection

Runtime adapters
  - Hermes
  - OpenAI
  - Anthropic
  - local models
  - future agents
```

The model picker should therefore keep UI state and domain types generic enough that Hermes is one adapter behind the control plane, not the product center of gravity.
