# Automations: Audit and Future State

## Goal

Capture the full state of Iris' Automations subsystem as of 2026-05-12: how it's stored, presented, and created today; where it diverges from Hermes' actual job/cron/webhook capabilities; every concrete flaw uncovered during research; and the future-state surface we want Iris to grow into. This document is a reference + backlog — it intentionally exceeds what we'd implement in one pass. The companion doc `.plans/2026-05-12-automations-foundational-changes.md` carves out the architectural prep work that must land first.

## Current Behavior

### One-line summary

Iris exposes a thin five-field cron CRUD ("name / prompt / schedule / repeat / deliver") over Hermes' much richer jobs API, with a hand-rolled "delay/datetime/daily/custom" schedule picker and a free-form delivery target text box.

### End-to-end flow of a single "Schedule" click

1. **UI form submit** — `desktop/src/features/jobs/JobsView.tsx:75` (`submitSchedule`).
2. **Hook** — `desktop/src/features/jobs/useIrisAutomations.ts:134` (`createScheduledMessage`) builds the request via `automationRequestPayload` (`useIrisAutomations.ts:313`).
3. **Agent discovery** — `getAgentUICoreAgentForProfile(profile)` — 1 HTTP round-trip to find the Iris agent id.
4. **Client** — `createAgentUICoreAutomation` POSTs `/v1/automations` (`desktop/src/lib/agentuiCore.ts:798`).
5. **Core API** — `iris-core/src/hermes_management_server/main.py:1805` (`core_create_automation`).
6. **Payload normalization** — `automation_create_payload` (`main.py:2511`): strips `metadata`, optionally maps `deliverToSessionId` → `deliver="iris:<chatId>"`.
7. **Adapter** — `runtime_adapters/hermes.py:537` (`create_automation`) POSTs Hermes `/api/jobs`.
8. **Hermes** — `gateway/platforms/api_server.py:2390-2436` (`_handle_create_job`) → `cron/jobs.py:482` (`create_job`) → persisted to `~/.hermes/cron/jobs.json`.
9. **Reload** — hook calls `loadJobs()` which re-fetches `GET /v1/automations` — full list refresh.

Total: ~4 HTTP calls per single create.

### Storage

- **Iris Core**: nothing is persisted. `/v1/automations*` is a pass-through to the runtime adapter. `core_store.py` lists `"automations"` only as a known table name (`core_store.py:43`) but never writes there.
- **Hermes**: `~/.hermes/cron/jobs.json` (atomic file writes, `cron/jobs.py:430`). Run output saved to `~/.hermes/cron/output/{job_id}/{timestamp}.md`.
- **Desktop**: a single string in `localStorage` under `storageKeys.jobsDeliveryTarget` (`useIrisAutomations.ts:289`), defaulting to `iris:desktop`.

### Polling

`useIrisAutomations.ts:76` polls every 6 seconds: `loadJobs({ silent: true })` + `pollDeliveries()` — two HTTP calls per tick while the Automations tab is open.

### Presentation

Single 795-line file `desktop/src/features/jobs/JobsView.tsx` containing:
- List + tabs (`active` / `paused` / `completed`).
- Modal create/edit form (name, prompt, schedule, repeat, "Advanced > Delivery target").
- Job detail pane (schedule, deliver, runs, next, prompt, error).
- "Recent activity" deliveries panel.

Schedule UI is a 4-mode select:
- **delay** — `${minutes}m`
- **datetime** — ISO timestamp
- **daily** — `daily at HH:MM` (does NOT parse on the Hermes side, see flaws #3 below)
- **custom** — free text (intended for cron expressions)

### Types

- `desktop/src/types/hermes.ts:307` — `HermesJob`: flattened view (`schedule: string`, `deliver: string`, `repeat: number | null`). Drops Hermes' richer fields.
- `desktop/src/lib/agentuiCore.ts:172` — `AgentUICoreAutomation`: Core's record shape. Used only inside the transport layer; the UI never renders it directly.
- `iris-core/.../models.py:206-225` — `CoreAutomationCreateRequest` / `CoreAutomationUpdateRequest`: 6 fields (`agentId`, `name`, `schedule`, `prompt`, `repeat`, `deliver`, `deliverToSessionId`, `metadata`).

### Hermes' actual capabilities (the gap)

Per Hermes docs (`website/docs/user-guide/features/cron.md`, `…/messaging/webhooks.md`, `hermes-already-has-routines.md`) and source (`cron/jobs.py:482` `create_job`):

| Hermes field | Iris request model | UI control? |
|---|---|---|
| `prompt` | ✅ | ✅ |
| `schedule` (duration / `every X` / cron / ISO) | ✅ | ✅ |
| `name` | ✅ | ✅ |
| `repeat` | ✅ | ✅ |
| `deliver` (origin/local/telegram/discord/slack/all/comma-list/iris:…) | ✅ string | ⚠️ free-text |
| `skills` / `skill` | ❌ stripped from request model | ❌ |
| `script` (pre-run script) | ❌ | ❌ |
| `no_agent` (script-only watchdog) | ❌ | ❌ |
| `context_from` (chain output of other jobs) | ❌ | ❌ |
| `enabled_toolsets` | ❌ | ❌ |
| `workdir` | ❌ | ❌ |
| `model` / `provider` / `base_url` | ❌ | ❌ |
| Webhooks (event-triggered automations) | ❌ — Hermes' `/api/jobs` only covers cron; webhook routes are a separate surface | ❌ |

## Desired Behavior (Future State)

A near-complete pane on top of Hermes' automation capabilities, with three trigger types and full per-job configurability:

### 1. Trigger types

- **Scheduled** (cron) — what we have today, but richer.
- **Webhook / event-triggered** — `hermes webhook subscribe …` surface. Currently in Hermes via `gateway/platforms/webhook.py` + dynamic route reload; not in Iris at all.
- **Manual / on-demand** — implicit today (`/run` action exists); should be a real distinction in the UI.

### 2. Per-job configuration the UI should eventually expose

- **Skills picker** — multi-select bound to Hermes' skill registry (existing `runtime_adapter.list_agent_skills`).
- **Pre-run script** — path picker bound to `~/.hermes/scripts/` (sandboxed dir). Plus a `no_agent` toggle for script-only watchdogs.
- **Context-from** — multi-select on existing automations to chain outputs.
- **Toolsets** — opt-in checkbox group for `enabled_toolsets`.
- **Workdir** — directory picker for repo-context jobs.
- **Per-job model override** — model/provider/base_url overrides.
- **Delivery picker** — enumerated list of connected platforms (telegram, discord, slack, all, iris session, …) instead of a free-text box. Backed by a Core endpoint enumerating Hermes' configured home channels.

### 3. Run history

- Read `~/.hermes/cron/output/{job_id}/{timestamp}.md` via a new Hermes route (doesn't exist yet) proxied through Core.
- Correlate each delivery to its source automation via a stamped `automationId` metadata field (the `iris-platform` plugin should stamp this; see flaw #9).
- Job detail pane shows: last 10 outputs, timestamps, success/fail markers, full text expandable.

### 4. Limits + validation

- Surface Hermes' `MAX_NAME_LENGTH=200` and `MAX_PROMPT_LENGTH=5000` as client-side constraints (with `maxLength=`).
- Pass Hermes' prompt-injection scanner errors through verbatim.

### 5. Status semantics

- Drop the misleading "Completed" tab (Hermes has no `completed` state).
- Tabs: `Active` (enabled, scheduled or recurring), `Paused` (`paused_at != null`), `Spent` (one-shots whose `repeat.completed >= times` — derived).
- Or simpler: `Enabled` / `Disabled` with sort-by-next-run.

## Findings (flaws found during research)

1. **Identity drift + per-action full list refetch**
   - **Finding**: Core mints a synthetic Iris id `auto_<stable_hash(runtimeId, externalJobId)>` (`main.py:2488`) and every mutating endpoint (`PATCH`, `DELETE`, `pause`, `resume`, `run`) calls `resolve_runtime_automation` (`main.py:2464`), which does a full `GET /api/jobs?include_disabled=true` before issuing the second mutating call.
   - **Evidence**: `main.py:1832-1888`, `main.py:2449-2472`.
   - **Why it matters**: Each UI click = 2+ HTTP calls Hermes-side. Re-listing scales O(n) with job count. Adding webhook automations would make the list even bigger and split across two Hermes APIs.
   - **Confidence**: high.

2. **`metadata.kind=scheduled-message` is dead weight**
   - **Finding**: The UI hook always sets `metadata.kind="scheduled-message"` and `metadata.profile` (`useIrisAutomations.ts:339`), then strips metadata before update (`useIrisAutomations.ts:156-157`, `void metadata`). Core also drops it — `automation_create_payload` ignores `metadata` entirely (`main.py:2511`). Hermes' `_UPDATE_ALLOWED_FIELDS` (`api_server.py:2353`) doesn't include `metadata`.
   - **Evidence**: cross-referenced four files.
   - **Why it matters**: Nobody consumes this field. Removing it shrinks request payloads and removes a misleading API surface.
   - **Confidence**: high.

3. **Schedule parsing reinvents Hermes' and `daily at HH:MM` doesn't round-trip**
   - **Finding**: Hermes' `parse_schedule` (`cron/jobs.py:184`) accepts `30m`, `every 2h`, 5-field cron, and ISO timestamps. The UI invents four modes (`delay`, `datetime`, `daily`, `custom`) and emits strings that mostly match — except `daily at HH:MM` (`JobsView.tsx:689`), which `parse_schedule` will reject as `Invalid schedule`. `formStateFromJob` (`JobsView.tsx:740`) also tries to match `^daily at (\d{2}:\d{2})$` against `job.schedule` on read, which will never round-trip since Hermes never stored that string.
   - **Evidence**: `JobsView.tsx:687-691`, `cron/jobs.py:201-270`.
   - **Why it matters**: A whole UI mode produces non-functional schedules. Verify by submitting "Daily" through the form — Hermes should error.
   - **Confidence**: medium (claim is read from source; would benefit from a runtime check).

4. **`HermesJob` flattens away most of Hermes' rich job shape**
   - **Finding**: `normalizeJob` at `useIrisAutomations.ts:231` collapses Hermes' `schedule` dict (`kind`, `expr`, `run_at`, `display`, `minutes`) into a single string and drops `script`, `skills`, `no_agent`, `context_from`, `workdir`, `enabled_toolsets`, `model`, `provider`, `base_url`, `last_status`, etc. The full row is preserved at `row.raw` but nothing in the UI consumes it.
   - **Evidence**: `useIrisAutomations.ts:231-258`, `types/hermes.ts:307-323`, `JobsView.tsx:541-601` (detail pane shows 4 fields only).
   - **Why it matters**: Every future feature (skills, scripts, no_agent, chaining, workdir, toolsets, model override) needs these fields. Today they're discarded at the type boundary.
   - **Confidence**: high.

5. **Delivery target is a free-form text input**
   - **Finding**: `JobsView.tsx:294` is a raw `<input>` defaulting to `iris:desktop`. Users have to know magic values like `telegram`, `telegram:-100…:42`, `discord:#engineering`, `all`, `slack`, `iris:<chatId>`, comma-lists.
   - **Evidence**: `JobsView.tsx:290-300`; Hermes' delivery enumeration in `website/docs/user-guide/features/cron.md:220-246`.
   - **Why it matters**: A picker requires Core to know which platforms Hermes has configured. No such endpoint exists today.
   - **Confidence**: high.

6. **No webhook trigger surface**
   - **Finding**: Hermes' second trigger type — webhook subscriptions (`gateway/platforms/webhook.py`, `cron/jobs.py` is unrelated to it) — has no representation in Iris Core. The adapter doesn't list webhook routes; the request models don't mention triggers.
   - **Evidence**: `runtime_adapters/base.py:64-68` (only `automation` = cron methods), `runtime_adapters/hermes.py:528` (only `/api/jobs`).
   - **Why it matters**: This is the single biggest "future capability" gap. Parity with Claude Code Routines requires it.
   - **Confidence**: high.

7. **Two parallel naming systems (`jobs` vs `automations`)**
   - **Finding**: Externally the feature is "Automations" (`navigation.ts:8`, route `/v1/automations`, UI title). Internally everything below the route says "jobs": type `HermesJob`, hook fields `activeJobs`/`pausedJobs`/`completedJobs`, file `JobsView.tsx`, CSS `jobs-*`, storage key `jobs.deliveryTarget`. `AgentUICoreAutomation` (`agentuiCore.ts:172`) exists but is used nowhere in the UI.
   - **Evidence**: cross-referenced naming across 6+ files.
   - **Why it matters**: Naming inconsistency makes search-and-replace risky and creates two mental models for the same thing.
   - **Confidence**: high.

8. **"Completed" tab almost never matches anything real**
   - **Finding**: Hermes jobs are `scheduled` or `paused`; `state="completed"` is not set by `mark_job_run` / `advance_next_run` (need to verify). The UI's `completedJobs = jobs not in (active, paused)` (`useIrisAutomations.ts:71`) only catches `error` and `unknown` statuses. A one-shot job whose `repeat.completed >= times` stays in "Active" forever.
   - **Evidence**: `useIrisAutomations.ts:69-71`, `cron/jobs.py:597-630` (state initialized as `scheduled`).
   - **Why it matters**: A whole UI tab is dead code.
   - **Confidence**: medium (claim about `mark_job_run` was not directly verified).

9. **No run history beyond chat-id heuristic**
   - **Finding**: `iris-platform/adapter.py:187` only stamps `source="hermes-cron"` on cron-origin deliveries; it does NOT stamp `automationId`. `matchingDeliveries` (`JobsView.tsx:769`) tries to correlate by `metadata.automationId|jobId|job_id` against both the synthesized `auto_*` id and the Hermes external id — but those keys never get set, so correlation falls back to chat-id equality only. Hermes' own per-job output files at `~/.hermes/cron/output/{job_id}/*.md` aren't reachable from Iris.
   - **Evidence**: `iris-platform/adapter.py:185-200`, `JobsView.tsx:769-786`, `cron/jobs.py:972`.
   - **Why it matters**: Foundational for any "run history" feature; plumbing must exist before UI can render it.
   - **Confidence**: medium (the iris-platform side wasn't read end-to-end; there may be a stamper I missed).

10. **No security/limits visibility**
    - **Finding**: Hermes enforces `_MAX_NAME_LENGTH=200`, `_MAX_PROMPT_LENGTH=5000`, and prompt-injection scanning at create/update (`api_server.py:2353-2417`, `cron.md:557`). Iris-side validation is "non-empty" only (`main.py:2511-2517`). The UI has no `maxLength` hints. Hermes errors come back as opaque 500s through Core's adapter wrapper (`hermes.py:576-589`).
    - **Evidence**: cross-referenced limits.
    - **Why it matters**: Users hit cryptic errors when prompts exceed 5KB.
    - **Confidence**: high.

## Future-state capabilities to expose (backlog)

Ordered by user value / Hermes-parity priority:

1. **Real delivery target picker** — enumerated, backed by `GET /v1/runtime/delivery-targets` (new). Free-text fallback for `iris:<sessionId>`.
2. **Skills attachment** — multi-select on the create form, persisted via Hermes' existing `skills[]` field.
3. **Per-job model override** — three optional fields (model, provider, base_url).
4. **`enabled_toolsets`** — checkbox group of available toolsets.
5. **Pre-run scripts + `no_agent` watchdogs** — file picker bound to `~/.hermes/scripts/`, plus a "Run script only (no LLM)" toggle.
6. **`context_from` chaining** — multi-select on existing automations.
7. **`workdir`** — directory picker; show context files (AGENTS.md / CLAUDE.md / .cursorrules) detected at that path.
8. **Webhook trigger type** — new "Add automation" choice between "Scheduled" and "Webhook"; webhook form exposes events, secret, prompt template, skills, deliver, deliver_only.
9. **Run history** — read job output files, render alongside detail pane.
10. **Bulk operations** — pause/resume/delete multiple at once.
11. **Schedule preview improvements** — show next N runs for cron expressions; warn on unparseable strings before submit.
12. **Templates / gallery** — curated starter automations matching Hermes' docs patterns (site monitor, weekly report, GitHub watcher).

## Claims To Verify

- [ ] `iris-core/src/hermes_management_server/main.py:2464` — every mutating endpoint re-lists all jobs via `resolve_runtime_automation` before mutating.
- [ ] `iris-core/src/hermes_management_server/main.py:2488` — `id` is computed as `f"auto_{stable_hash(agent['runtimeId'], external_job_id, length=22)}"`.
- [ ] `desktop/src/features/jobs/useIrisAutomations.ts:339` — every create/update sets `metadata.kind="scheduled-message"`, and `useIrisAutomations.ts:156-157` then discards the metadata before sending to Core.
- [ ] `iris-core/src/hermes_management_server/main.py:2511` — `automation_create_payload` does not forward `metadata` to Hermes.
- [ ] `/Users/scott/Development/hermes-agent/gateway/platforms/api_server.py:2353` — `_UPDATE_ALLOWED_FIELDS` is `{"name", "schedule", "prompt", "deliver", "skills", "skill", "repeat", "enabled"}` (no `metadata`).
- [ ] `desktop/src/features/jobs/JobsView.tsx:689` — "daily" mode emits `daily at ${dailyTime}`.
- [ ] `/Users/scott/Development/hermes-agent/cron/jobs.py:184` — `parse_schedule` rejects `daily at 09:00` (run it: `python -c "from cron.jobs import parse_schedule; parse_schedule('daily at 09:00')"`).
- [ ] `desktop/src/features/jobs/useIrisAutomations.ts:231-258` — `normalizeJob` does not preserve `script`, `skills`, `no_agent`, `context_from`, `workdir`, `enabled_toolsets`, `model`, `provider`.
- [ ] `iris-platform/adapter.py` — no path stamps `automationId` on outbound cron deliveries (grep for `automationId`).
- [ ] `/Users/scott/Development/hermes-agent/cron/jobs.py:768` — `mark_job_run` does NOT set `state="completed"`; `state` only flips between `scheduled` and `paused`.
- [ ] `iris-core/src/hermes_management_server/runtime_adapters/base.py:64-68` — only cron methods (`list_automations`, `create_automation`, `update_automation`, `delete_automation`, `control_automation`); no webhook surface.
- [ ] `desktop/src/lib/agentuiCore.ts:172` — `AgentUICoreAutomation` type is exported but no UI file imports it (`grep -r AgentUICoreAutomation desktop/src/features` returns nothing).

## Implementation Plan

This document is a **reference and backlog**, not a single implementable change. For concrete edits, see the companion handoff `.plans/2026-05-12-automations-foundational-changes.md`. The future-state items in "Future-state capabilities to expose" should each get their own scoped handoff when they're prioritized.

## Non-Goals / Must Not Change

- Don't try to land all 12 backlog items in one pass.
- Don't add UI for features (skills, scripts, no_agent, context_from, workdir, toolsets, webhooks) before the foundational data-model and identity changes land — the type/transport plumbing must come first.
- Don't change Hermes' `/api/jobs` HTTP contract from the Iris side; if Hermes needs an API addition, that's a Hermes PR.
- Don't move automation persistence into Iris Core's SQLite — Hermes remains the source of truth per `CLAUDE.md`.
- Don't drop the legacy `agentui:` delivery prefix path (`useIrisAutomations.ts:345-350`); legacy compat stays.

## Tests

This doc captures the audit; no tests to run for the doc itself. For the foundational changes that follow, see the test sections in `.plans/2026-05-12-automations-foundational-changes.md`.

## Verification

- [ ] User reads this doc and confirms the audit matches their understanding.
- [ ] Each item in "Findings" has an entry in "Claims To Verify".
- [ ] Open questions are explicitly listed (or closed) before downstream handoffs reference them.

## Open Questions

1. **Scope of "automations":** is Iris meant to be a thin pane on Hermes' full job feature set, or stay scoped to "scheduled reminders" with advanced jobs left to CLI/chat?
2. **Webhooks as a second trigger type:** in scope for the UI, or pushed to chat/CLI only?
3. **Delivery picker:** add a `GET /v1/runtime/delivery-targets` endpoint and enumerate Hermes' configured home channels?
4. **Identity model:** keep `auto_*` synthetic ids + per-action re-list, or round-trip Hermes' job id directly and add `GET /v1/automations/{id}`?
5. **"Completed" tab:** drop it, rename to "Inactive" with `enabled=false` + spent one-shots, or push Hermes to track a real completed state?
6. **Run history:** worth wiring through to `~/.hermes/cron/output/{job_id}/*.md`? Requires a new Hermes route (Hermes doesn't expose this today).
7. **Limits surface:** add a `GET /v1/runtime/limits` endpoint, or hard-code the constants on the desktop side and document them?
8. **Schedule UI:** drop the "Daily" mode entirely (since Hermes can't parse it) or translate it to cron (`<min> <hr> * * *`) before send?
