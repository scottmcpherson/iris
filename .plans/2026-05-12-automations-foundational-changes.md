# Automations: Foundational Changes

## Goal

Land the architectural prep work now — before any new automation features — so future work (skills attachment, scripts, no_agent, context_from, workdir, toolsets, model overrides, delivery picker, webhook trigger type, run history) isn't blocked or made harder by today's flattened types, dead-weight metadata, broken schedule mode, naming drift, missing identity primitives, and missing correlation plumbing.

Companion doc: `.plans/2026-05-12-automations-audit-and-future-state.md` (full audit + backlog).

## Current Behavior

See the companion doc's "Current Behavior" section for the full flow. Foundational pain points being addressed here:

- Iris Core's `id` is a synthetic `auto_<hash>` (`main.py:2488`); every mutating endpoint full-list-refetches via `resolve_runtime_automation` (`main.py:2464`).
- `HermesJob` (`types/hermes.ts:307`) flattens away `skills`, `script`, `no_agent`, `context_from`, `workdir`, `enabled_toolsets`, `model`, `provider`, plus the structured `schedule` dict.
- `metadata.kind="scheduled-message"` is set on the desktop side (`useIrisAutomations.ts:339`) and dropped at three subsequent layers without ever being consumed.
- "Daily" schedule mode emits `daily at HH:MM`, which Hermes' `parse_schedule` rejects (`cron/jobs.py:184`).
- The feature is split between two naming conventions: external "Automations", internal "jobs" everywhere (`navigation.ts`, `JobsView.tsx`, `HermesJob`, `jobs-*` CSS, storage key).
- `iris-platform/adapter.py:187` stamps `source="hermes-cron"` on deliveries but does NOT receive/stamp `automationId` / Hermes `job_id`; without a Hermes scheduler metadata change, reliable per-automation delivery correlation is impossible.
- Hermes' `_MAX_NAME_LENGTH=200` and `_MAX_PROMPT_LENGTH=5000` are invisible to the UI.
- "Completed" tab is not a reliable architectural state: Hermes can mark some one-shots completed, but repeat-exhausted jobs may be removed from `jobs.json`, so the UI cannot derive a trustworthy "spent" list from `/api/jobs` alone.

## Desired Behavior

After this change:

1. `HermesJob` (or its successor) preserves every Hermes field — `skills`, `script`, `no_agent`, `context_from`, `workdir`, `enabled_toolsets`, `model`, `provider`, `base_url`, the structured `schedule` dict — even if the current UI doesn't render them. Adding a new feature later means adding a UI control, not changing the type and re-plumbing the transport.
2. `iris-core/src/hermes_management_server/main.py` mutating endpoints stop full-list-refetching. The Core `id` is the Hermes job id; mutations target it directly. A new `GET /v1/automations/{id}` exists for single-row refresh.
3. The dead `metadata.kind="scheduled-message"` field is removed from the desktop hook, the request model, and any tests that assert on it.
4. The "Daily" schedule mode either:
   - **(A)** translates to a cron string (`${minute} ${hour} * * *`) before sending, or
   - **(B)** is removed from the UI.
   Decision deferred to Open Questions; default plan = (A).
5. The desktop feature directory is renamed `jobs/` → `automations/` (file + folder); types renamed `HermesJob` → `HermesAutomation` (or `Automation`); the navigation key stays `"jobs"` only if doing so avoids a router migration (otherwise rename it too).
6. Delivery/run-history correlation is documented as blocked on a future Hermes contract: Hermes must either pass job identity through scheduler delivery metadata or expose per-job run output through an API. Iris keeps best-effort matching only.
7. The status model aligns with Hermes' reliable live-list states: active/scheduled, paused/disabled, and error. The misleading "Completed" tab is removed from this pass; a true run-history/completed view is deferred until Hermes exposes durable run records.
8. Hermes' limits surface to the UI either via a `GET /v1/runtime/limits` endpoint or via shared constants; the form enforces `maxLength` and shows Hermes' validation errors verbatim.

## Findings

- **F1 — Identity model invites round-trip bloat.** `main.py:2464` `resolve_runtime_automation` lists ALL jobs on every PATCH/DELETE/pause/resume/run. Confidence: high.
- **F2 — `HermesJob` is the type bottleneck.** `useIrisAutomations.ts:231-258` `normalizeJob` discards 8+ Hermes fields. Future features can't ship without expanding this type first. Confidence: high.
- **F3 — Dead `metadata.kind` field.** Set in `useIrisAutomations.ts:339`, stripped in `useIrisAutomations.ts:156`, dropped by `main.py:2511`, not in Hermes' `_UPDATE_ALLOWED_FIELDS` (`api_server.py:2353`). Confidence: high.
- **F4 — Broken `daily at HH:MM` schedule.** `JobsView.tsx:689` emits a string Hermes' `parse_schedule` rejects (`cron/jobs.py:201-270`). Confidence: medium — verify by running `python -c "from cron.jobs import parse_schedule; parse_schedule('daily at 09:00')"`.
- **F5 — Naming drift (`jobs` vs `automations`).** Inconsistent across 6+ files: `navigation.ts:8`, `App.tsx:19`, `JobsView.tsx`, `useIrisAutomations.ts`, types, CSS, storage keys. Confidence: high.
- **F6 — Cron delivery correlation is blocked by the Hermes boundary.** `iris-platform/adapter.py:187` only sets `source="hermes-cron"` when the delivery content starts with `Cronjob Response:`. Hermes' scheduler currently calls platform `send(...)` without job-id metadata, so Iris cannot reliably stamp `automationId` without a Hermes-side contract. Confidence: high.
- **F7 — Limits invisible to UI.** Hermes errors surface as opaque 500s through `hermes.py:576-589`. Confidence: high.
- **F8 — "Completed" tab is not a reliable live-list concept.** Hermes can set `state="completed"` for some terminal one-shot paths, but repeat-exhausted jobs may be deleted from the job list. `useIrisAutomations.ts:71` therefore cannot become a trustworthy "spent" history without a new durable run-history source. Confidence: high.

## Claims To Verify

- [ ] `iris-core/src/hermes_management_server/main.py:1832` — `core_update_automation` calls `resolve_runtime_automation(app, automation_id)` which lists all jobs.
- [ ] `iris-core/src/hermes_management_server/main.py:1865-1888` — `delete`, `pause`, `resume`, `run` all call `resolve_runtime_automation` (directly or via `control_core_automation`).
- [ ] `iris-core/src/hermes_management_server/main.py:2488` — `id = f"auto_{stable_hash(agent['runtimeId'], external_job_id, length=22)}"` — the synthetic id format.
- [ ] `/Users/scott/Development/hermes-agent/gateway/platforms/api_server.py:3350` — `/api/jobs/{job_id}` accepts the Hermes job id directly, so Core can pass through `automation_id` once we stop synthesizing a new one.
- [ ] `desktop/src/features/jobs/useIrisAutomations.ts:339` — `metadata: { kind: "scheduled-message", profile }` is always set; `useIrisAutomations.ts:156` does `void metadata`.
- [ ] `iris-core/src/hermes_management_server/models.py:206-225` — `CoreAutomationCreateRequest` and `CoreAutomationUpdateRequest` declare a `metadata` field that's never consumed.
- [ ] `iris-core/src/hermes_management_server/main.py:2511` — `automation_create_payload` does not pass `metadata` to the runtime call.
- [ ] `desktop/src/features/jobs/JobsView.tsx:689` — `scheduleValue` returns `daily at ${dailyTime || "09:00"}` for `daily` mode.
- [ ] `/Users/scott/Development/hermes-agent/cron/jobs.py:184` — `parse_schedule` raises `ValueError("Invalid schedule …")` for `daily at 09:00`.
- [ ] `desktop/src/features/jobs/JobsView.tsx:740` — `formStateFromJob` regex `^daily at (\d{2}:\d{2})$` against `job.schedule`.
- [ ] `desktop/src/features/jobs/useIrisAutomations.ts:231-258` — `normalizeJob` drops `script`, `skills`, `no_agent`, `context_from`, `workdir`, `enabled_toolsets`, `model`, `provider`, `base_url` (none of these names appear in the return object).
- [ ] `desktop/src/types/hermes.ts:307` — `HermesJob` declares 14 fields; none of them are `skills`, `script`, `no_agent`, `context_from`, `workdir`, `enabled_toolsets`, `model`.
- [ ] `iris-platform/adapter.py:187` — `source = "hermes-cron" if content.lstrip().startswith("Cronjob Response:") else "hermes-gateway"` is the only branch; no `automationId` set on the delivery metadata anywhere in the file (`grep automationId iris-platform/`).
- [ ] `/Users/scott/Development/hermes-agent/cron/scheduler.py:581-588` — live adapter delivery passes only thread metadata to `runtime_adapter.send(...)`, not job id metadata.
- [ ] `/Users/scott/Development/hermes-agent/cron/jobs.py:768-832` — `mark_job_run` can set one-shot jobs to `state="completed"` but can also remove repeat-exhausted jobs from the live list.
- [ ] `/Users/scott/Development/hermes-agent/gateway/platforms/api_server.py:2353` — `_UPDATE_ALLOWED_FIELDS = {"name", "schedule", "prompt", "deliver", "skills", "skill", "repeat", "enabled"}`.
- [ ] `/Users/scott/Development/hermes-agent/gateway/platforms/api_server.py:2354-2355` — `_MAX_NAME_LENGTH = 200`, `_MAX_PROMPT_LENGTH = 5000`.

## Implementation Plan

Steps are grouped by area so each can be reviewed independently. Run them in order — later steps depend on earlier ones.

### Step 1 — Drop dead metadata (small, safe)

1. **`desktop/src/features/jobs/useIrisAutomations.ts`** — Remove `metadata` from `AutomationRequestPayload` (`:41`), from the return of `automationRequestPayload` (`:332-343`), and the `metadata` strip dance in `updateScheduledMessage` (`:156-157`).
2. **`desktop/src/lib/agentuiCore.ts`** — Remove `metadata?: CoreMetadata` from the `createAgentUICoreAutomation` and `updateAgentUICoreAutomation` payload types (`:798-839`).
3. **`iris-core/src/hermes_management_server/models.py:206-225`** — Remove the `metadata: dict[str, Any] = Field(default_factory=dict)` fields from `CoreAutomationCreateRequest` and `CoreAutomationUpdateRequest`.
4. **`desktop/src/features/jobs/__tests__/useIrisAutomations.test.ts`** — Update any assertions that expect `metadata.kind` in the request payload.
5. **`iris-core/tests/test_api.py`** — Remove or update any test that posts `metadata` in the automation request body.

### Step 2 — Stop synthesizing `auto_*` ids; use Hermes' job id directly

1. **`iris-core/src/hermes_management_server/main.py:2475-2508`** — In `automation_record_from_job`, change `"id": f"auto_{stable_hash(...)}"` to `"id": external_job_id`. Keep `"externalJobId": external_job_id` (or merge them — they'd be the same). Make sure `runtimeId` is still on the record so the right adapter can be picked.
2. **`iris-core/src/hermes_management_server/main.py:2464-2472`** — Replace `resolve_runtime_automation` with a thin lookup: take the `automation_id` (= Hermes job id), pick the adapter via the agent that owns it. New helper signature: `resolve_runtime_automation(app, automation_id) -> tuple[agent, adapter, external_id] | None`. Implementation: walk `registry.agents()`, for each adapter try `GET /api/jobs/{automation_id}` — fail fast as soon as one returns 200. Do **not** add a Core SQLite `automation_id → agent_id` map in this pass; Hermes remains the job source of truth and this app does not need legacy-id compatibility.
3. **`iris-core/src/hermes_management_server/runtime_adapters/base.py`** — Add `def get_automation(self, external_job_id: str) -> dict[str, Any]: ...` to the protocol.
4. **`iris-core/src/hermes_management_server/runtime_adapters/hermes.py`** — Implement `get_automation` as a `GET /api/jobs/{external_job_id}`.
5. **`iris-core/src/hermes_management_server/main.py`** — Add a new endpoint:
   ```python
   @app.get("/v1/automations/{automation_id}")
   async def core_get_automation(automation_id: str, _auth: None = Depends(require_auth)) -> dict[str, Any]:
       ...  # returns one record via the single-row lookup, not list_runtime_automations
   ```
6. **`iris-core/src/hermes_management_server/main.py:1831-1888`** — Update PATCH / DELETE / pause / resume / run handlers to use the single-row resolve, not `list_runtime_automations`.
7. **`desktop/src/lib/agentuiCore.ts`** — Add `getAgentUICoreAutomation(automationId, runtime?)` that hits the new endpoint.
8. **Iris-side tests** — Add tests in `iris-core/tests/test_api.py` covering `GET /v1/automations/{id}` for hit, miss, and wrong-runtime cases.

> If single-row mutation requires too much adapter rework in one PR, an acceptable middle ground is: keep `list_runtime_automations` for read paths, but pass the Hermes job id (not `auto_*`) as the canonical Iris id. There is no requirement to support old `auto_*` ids.

### Step 3 — Preserve Hermes' rich job shape end-to-end

1. **`desktop/src/types/hermes.ts:307-323`** — Replace flat `HermesJob` with a richer shape:
   ```ts
   export type HermesAutomationSchedule = {
     kind: "once" | "interval" | "cron" | "unknown";
     display: string;
     runAt?: string;          // ISO, for "once"
     minutes?: number;        // for "interval"
     expr?: string;           // for "cron"
   };

   export type HermesAutomation = {
     id: string;                       // = Hermes job id
     name: string;
     schedule: HermesAutomationSchedule;
     prompt: string;
     deliver: string;
     status: HermesJobStatus;          // keep alias for now
     enabled: boolean;
     nextRunAt: number | null;
     lastRunAt: number | null;
     lastStatus: string;
     lastError: string;
     lastDeliveryError: string;
     runCount: number;
     repeat: number | null;            // null = forever
     skills: string[];
     skill: string | null;
     script: string | null;
     noAgent: boolean;
     contextFrom: string[];
     workdir: string | null;
     enabledToolsets: string[] | null;
     model: string | null;
     provider: string | null;
     baseUrl: string | null;
     createdAt: number | null;
     raw: Record<string, unknown>;
   };

   export type HermesJob = HermesAutomation; // temporary internal alias only if it reduces same-PR churn
   ```
2. **`desktop/src/features/jobs/useIrisAutomations.ts:231-258`** — Update `normalizeJob` to populate the new fields from the raw Hermes record (everything is already available in `row.raw`):
   - `schedule` from `row.schedule` dict (preserve `kind`, `display`, `run_at`, `minutes`, `expr`).
   - `enabled` from `row.enabled ?? row.state !== "paused"`.
   - `skills` from `row.skills ?? []`; `skill` from `row.skill ?? null`.
   - `script` from `row.script`; `noAgent` from `row.no_agent`; `contextFrom` from `row.context_from`; `workdir` from `row.workdir`; `enabledToolsets` from `row.enabled_toolsets`; `model` / `provider` / `baseUrl` from same-named fields.
3. **`desktop/src/features/jobs/JobsView.tsx`** — Where today it does `job.schedule || "Manual"`, switch to `job.schedule.display || "Manual"`. No new UI controls in this step — just thread the type change through.
4. **Iris Core**: no change required — Core already returns `metadata.runtimeJob` (`main.py:2506`) which carries the raw Hermes payload. But take this opportunity to also surface the structured fields on the top level of the `AgentUICoreAutomation` Pydantic-ish response in `automation_record_from_job` (`main.py:2475-2508`):
   ```python
   record["skills"] = list(job.get("skills") or [])
   record["script"] = job.get("script")
   record["noAgent"] = bool(job.get("no_agent"))
   record["contextFrom"] = list(job.get("context_from") or [])
   record["workdir"] = job.get("workdir")
   record["enabledToolsets"] = job.get("enabled_toolsets")
   record["model"] = job.get("model")
   record["provider"] = job.get("provider")
   record["baseUrl"] = job.get("base_url")
   record["enabled"] = job.get("enabled", True)
   ```
5. **`desktop/src/lib/agentuiCore.ts:172-187`** — Expand `AgentUICoreAutomation` to include the new fields, matching the Core response.

### Step 4 — Fix or remove the broken "Daily" schedule mode

Pick **(A)** (recommended) unless Open Questions resolve otherwise.

#### Plan (A): translate "Daily" to a cron string before send

1. **`desktop/src/features/jobs/JobsView.tsx:687-691`** — In `scheduleValue`, change the `daily` branch:
   ```ts
   if (scheduleMode === "daily") {
     const [hh = "9", mm = "0"] = (dailyTime || "09:00").split(":");
     return `${Number(mm) || 0} ${Number(hh) || 9} * * *`;
   }
   ```
2. **`desktop/src/features/jobs/JobsView.tsx:740-756`** — In `formStateFromJob`, detect cron strings of the form `^(\d{1,2}) (\d{1,2}) \* \* \*$` and round-trip back to `daily` mode + `HH:MM`; otherwise fall through to `custom`.
3. **`desktop/src/features/jobs/JobsView.tsx`** — Update `schedulePreview` for the daily branch so the preview reads "Will deliver next at 9:00 AM, repeating until paused" (existing helper `nextDailyLabel` already does this).

#### Plan (B): remove the mode entirely

1. **`desktop/src/features/jobs/JobsView.tsx`** — Remove the `"daily"` option from the `ScheduleMode` union, the select option (`:233`), the daily-time input (`:254-259`), and the daily branch in `scheduleValue` / `schedulePreview` / `formStateFromJob`.

### Step 5 — Rename `jobs/` → `automations/` in the desktop tree

1. **Move** `desktop/src/features/jobs/` → `desktop/src/features/automations/`. Files inside:
   - `JobsView.tsx` → `AutomationsView.tsx` (rename `JobsView` symbol).
   - `useIrisAutomations.ts` stays.
   - `__tests__/useIrisAutomations.test.ts` stays.
2. **`desktop/src/App.tsx:19-20, 453-471`** — Update imports + the `JobsView` usage to `AutomationsView`.
3. **`desktop/src/types/hermes.ts:307`** — Rename `HermesJob` → `HermesAutomation`. Keep a temporary `HermesJob` alias only if it materially reduces same-PR churn; there is no release-compatibility requirement.
4. **`desktop/src/features/automations/useIrisAutomations.ts`** — Rename internal hook fields away from job terminology: `activeJobs` → `activeAutomations`, `pausedJobs` → `pausedAutomations`. Remove `completedJobs` with the Completed tab in Step 7.
5. **`desktop/src/app/storage.ts`** — Rename `storageKeys.jobsDeliveryTarget` → `storageKeys.automationsDeliveryTarget`. No migration is required; this is a single-user pre-compatibility app and old localStorage state can be dropped.
6. **`desktop/src/App.css`** — Either rename `jobs-*` CSS classes to `automations-*`, or scope the rename to the `.tsx` only and leave CSS for a follow-up (lower risk).
7. **Navigation key** (`desktop/src/app/navigation.ts:8`) — leave the route id `"jobs"` unless we want to also migrate the `View` union type and any URL hashes that reference it. Adding router changes here would balloon scope.

### Step 6 — Document delivery-correlation boundary; keep matching best-effort

1. **Do not edit Hermes code in this pass.** Iris cannot directly change Hermes scheduler behavior, and `iris-platform` does not receive the job id in delivery metadata today.
2. **Do not parse `(job_id: ...)` out of delivery message text.** That text exists only when Hermes cron wrapping is enabled and is not a reliable API boundary.
3. **`desktop/src/features/automations/AutomationsView.tsx:769-786`** — Keep `matchingDeliveries` best-effort:
   - Match `metadata.automationId`, `metadata.jobId`, or `metadata.job_id` if a future Hermes/plugin path provides them.
   - Fall back to delivery chat id equality as the current behavior does.
4. **Companion/future-state doc** — Add or keep a blocker note: reliable run correlation requires Hermes to pass job identity through scheduler delivery metadata or expose run history/output via a Hermes API.

### Step 7 — Normalize status semantics; remove "Completed"

1. **`desktop/src/features/automations/useIrisAutomations.ts:69-71`** — Replace:
   ```ts
  const activeAutomations = useMemo(() => automations.filter((automation) => automation.status === "active"), [automations]);
  const pausedAutomations = useMemo(() => automations.filter((automation) => automation.status === "paused"), [automations]);
   ```
   with:
   ```ts
  const activeAutomations = useMemo(
    () => automations.filter((automation) => automation.enabled && automation.status !== "paused" && automation.status !== "error"),
    [automations],
  );
  const pausedAutomations = useMemo(() => automations.filter((automation) => automation.status === "paused"), [automations]);
  const erroredAutomations = useMemo(() => automations.filter((automation) => automation.status === "error"), [automations]);
  ```
2. **`desktop/src/features/automations/AutomationsView.tsx`** — Remove the "Completed" tab. Optionally add an "Errored" tab only if the UI has enough error rows to justify it; otherwise show error state in Active/Paused rows.
3. **`desktop/src/features/automations/__tests__/useIrisAutomations.test.ts`** — Update assertions on the tab predicates.

### Step 8 — Surface Hermes' limits to the UI

1. **`desktop/src/features/automations/AutomationsView.tsx:213-225`** — Add `maxLength={200}` to the name input, `maxLength={5000}` to the prompt textarea. Hard-code for now; document the source in a one-line comment pointing at Hermes' `_MAX_NAME_LENGTH` / `_MAX_PROMPT_LENGTH`.
2. **`iris-core/src/hermes_management_server/runtime_adapters/hermes.py:576-589`** — In `jobs_request`, when Hermes returns a 4xx with an `error` field, propagate the error string through the Iris response unchanged. Avoid converting to generic 500s.
3. **`desktop/src/features/automations/useIrisAutomations.ts:147`** — `createScheduledMessage` already surfaces `result.error`; just confirm the message reaches `setFormNotice` for users to see the real reason (length / injection scanner).
4. **Optional follow-up** (Open Question 5): add `GET /v1/runtime/limits` returning `{ name_max, prompt_max }` so the desktop doesn't need to hard-code. Punt unless someone asks.

### Step 9 — Cleanup pass after the above lands

1. Remove the unused `AgentUICoreAutomation` export if nothing references it anymore (`desktop/src/lib/agentuiCore.ts:172`), or rename it to `HermesAutomationRecord` so its purpose is obvious.
2. Delete dead pause/resume/active dispatch code if any branch became unreachable after the status change in Step 7.

## Non-Goals / Must Not Change

- Do **not** add any new UI controls for skills, scripts, no_agent, context_from, workdir, toolsets, or model overrides in this pass. The types must support them, but the form stays unchanged.
- Do **not** introduce a webhook trigger type yet. This is the largest future-state item; it needs its own handoff.
- Do **not** add a delivery target picker yet. Free-text input stays; only the surrounding plumbing changes.
- Do **not** add run-history reading from `~/.hermes/cron/output/{job_id}/*.md`. Requires a new Hermes route.
- Do **not** change Hermes' `/api/jobs` HTTP contract. All changes are on the Iris side.
- Do **not** move automation persistence into Iris Core's SQLite. Hermes is the source of truth per `CLAUDE.md`.
- Do **not** drop the legacy `agentui:` delivery prefix (`useIrisAutomations.ts:345-350`).
- Do **not** change the `/v1/automations` URL.
- No legacy `auto_*` id compatibility is required. This is a single-user pre-compatibility app; choose the cleaner architecture.
- Do **not** edit Hermes code directly. If a change requires Hermes scheduler/API support, document it as a blocked future dependency instead.

## Tests

Each step has at least one targeted test below. Run the full pre-commit gate before merging the bundle: `npm run check`.

### Step 1 (drop metadata)

- Desktop: `npm --workspace desktop run test -- desktop/src/features/jobs/__tests__/useIrisAutomations.test.ts`
- Core: `iris-core/.venv/bin/python -m pytest iris-core/tests/test_api.py -k automation`
- New: assert `automationRequestPayload` does NOT include a `metadata` key.

### Step 2 (identity + single-row endpoint)

- Core: `iris-core/.venv/bin/python -m pytest iris-core/tests/test_api.py -k "automation and (get or update or delete or pause or resume)"`
- New: test that `GET /v1/automations/{id}` returns the right record, hits the runtime adapter once, and 404s on miss.
- New: test that `PATCH /v1/automations/{id}` does NOT call `list_automations` on the adapter (use a mock and assert call count = 1, not 2).

### Step 3 (rich type)

- Desktop: `npm --workspace desktop run test -- desktop/src/features/jobs/__tests__/useIrisAutomations.test.ts`
- New: `normalizeJobsResult` test with a fixture Hermes job containing `skills`, `script`, `no_agent=true`, `context_from`, `workdir`, `enabled_toolsets`, `model` — assert each round-trips into the `HermesAutomation` shape.

### Step 4 (Daily mode)

- Desktop: new test on `scheduleValue` and `formStateFromJob` covering the daily-mode round-trip.
- Manual (or scripted): from a Python environment with Hermes' dependencies installed, run `python -c "from cron.jobs import parse_schedule; print(parse_schedule('0 9 * * *'))"` in `/Users/scott/Development/hermes-agent`; it should print a cron-kind dict.

### Step 5 (rename)

- `npm --workspace desktop run test` should pass with the renamed paths.
- `tsc && vite build` (part of `npm run check`) must still pass.
- Add/update one test asserting `automationsDeliveryTarget` is used. Do not add a migration test for the old `jobs.deliveryTarget` key.

### Step 6 (delivery-correlation boundary)

- Desktop: keep or add a unit test that `matchingDeliveries` matches `metadata.automationId|jobId|job_id` when present and falls back to delivery chat id when metadata is absent.
- Manual: in the running app, schedule a 1-minute job to `iris:desktop`; after it fires, confirm the delivery appears in Recent activity. Do not require per-automation history correlation yet.

### Step 7 (status semantics)

- Desktop: new test on `useIrisAutomations` that paused jobs land in paused, enabled scheduled jobs land in active, and the old completed bucket/tab is gone.

### Step 8 (limits)

- Manual: paste a 5500-char prompt into the form; submit; confirm error notice shows Hermes' actual message rather than a generic failure.

### Full gate

```
npm run check
```

(Desktop vitest + Python bridge unittest + tsc + vite build + Core pytest.)

## Verification

### Restart / reinstall requirements

- **Step 1, 3, 7, 8**: Desktop-only changes. The user's existing `npm run dev` will pick them up via Vite HMR.
- **Step 2** (Core changes): Restart Core. `npm run dev` orchestrates Core, so users on `npm run dev` get it on restart of the orchestrator.
- **Step 4** (UI only): HMR.
- **Step 5** (rename): HMR for the desktop reload. Old localStorage delivery-target state may reset because no migration is required.
- **Step 6** (delivery-correlation boundary): no plugin reinstall and no Hermes gateway restart, because this pass does not change `iris-platform` or Hermes code.
- **Step 7-9**: HMR.

State the restart requirement clearly in any commit/PR description.

### Manual acceptance checklist

- [ ] Create an automation with a 1-minute delay and the `iris:desktop` deliver target. After it fires, the delivery row appears in global "Recent activity". Per-automation history remains best-effort until Hermes exposes job identity in delivery metadata or run history.
- [ ] Edit the same automation — only one full `GET /api/jobs` happens (check Core access logs); after Step 2, that drops to one `GET /api/jobs/{id}` plus one `PATCH /api/jobs/{id}`.
- [ ] Schedule a "Daily at 9:00" automation. Inspect the persisted `~/.hermes/cron/jobs.json` — the `schedule.kind` should be `cron` and `schedule.expr` should be `0 9 * * *`. The UI should re-open the same automation in "Daily" mode.
- [ ] Paste a 5500-char prompt into the form — submit fails with Hermes' actual length error message.
- [ ] Schedule with a one-shot delay (`30m`) and immediately click "Run now". Confirm the live list does not show a misleading Completed/Spent tab; durable run history is deferred.
- [ ] No regressions in chat, agents, or sessions panels — `npm run check` passes.

### Database / file inspection

- `cat ~/.hermes/cron/jobs.json` after each test — verify Hermes stores what the UI showed.
- `ls ~/.hermes/cron/output/<job_id>/` after a run — output files appear (foundation for future run-history feature).

## Open Questions

1. **Daily schedule: translate to cron, or remove?** Default plan = translate (Plan A in Step 4). Confirm.
2. **Errored tab:** after removing Completed, should error rows stay in Active/Paused lists with row-level styling, or get a separate "Errored" tab if enough real error cases exist?
3. **Naming migration scope:** rename only files + types, or also CSS class names + nav route id in one pass? Recommended split: this PR handles files + types + storage key rename with no migration; CSS rename is a follow-up to keep diff size manageable.
4. **Identity lookup strategy in Step 2:** probe adapters on lookup vs. require agent/runtime context in the single-row route. Recommended: probe + a single-process in-memory cache; do not add Core SQLite persistence.
5. **Limits endpoint:** add `GET /v1/runtime/limits` now or hard-code on the desktop? Recommended: hard-code now (simpler), revisit if a second consumer ever shows up.
6. **Run correlation dependency:** what exact Hermes contract should Iris ask for later: delivery metadata (`automationId`/`jobId`) or a run-history API over `~/.hermes/cron/output/{job_id}`? Deferred because Hermes code is out of scope.
7. **`HermesJob` alias:** keep a temporary alias only to reduce same-PR churn, or delete now? Recommended: delete if the rename is straightforward; no long-term compatibility is required.
