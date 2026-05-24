# shadcn Component Migration Audit

## Goal
Continue the desktop UI migration from hand-rolled custom components to shadcn/ui primitives while preserving the current Iris desktop behavior, custom theme, and desktop interaction model.

This plan captures the current audit findings and enough implementation detail to resume later without re-running the whole repo scan. It is intentionally scoped to visible UI/component structure only. Do not change Hermes, Iris Core, transport, persistence, runtime contracts, or business logic as part of this migration.

## Current shadcn Setup

The shadcn workspace target is `desktop`, not the repo root.

Project config:
- `apps/desktop/components.json`
- Vite app, React, TypeScript, Tailwind v4.
- shadcn style: `new-york`
- shadcn base: `radix`
- icon library: `lucide`
- UI alias: `@/shared/ui`
- UI directory: `apps/desktop/src/shared/ui`
- Theme file: `apps/desktop/src/App.css`

Installed shadcn primitives today:
- `button`
- `checkbox`
- `command`
- `context-menu`
- `dialog`
- `dropdown-menu`
- `input`
- `popover`
- `select`
- `tabs`
- `textarea`

The existing migration has already covered a lot of basic controls: most buttons, selects, text inputs, textareas, dialogs, dropdown menus, context menus, popovers, command menus, checkboxes, and tabs now import from `apps/desktop/src/shared/ui`.

The remaining obvious gaps are larger composed primitives: cards, alerts, empty states, badges/status pills, field/form wrappers, scroll areas, separators, collapsibles/accordions, tooltips, skeleton/loading states, switch/toggle controls, and toast/notification plumbing.

## Registry / Install Notes

Run shadcn commands from `desktop`, or pass `-c desktop` from the repo root.

Useful current-state command:

```bash
npx shadcn@latest info --json -c desktop
```

The audit dry run confirmed these missing primitives are available:

```bash
cd apps/desktop
npx shadcn@latest add card badge alert empty field sidebar sonner scroll-area separator accordion collapsible tooltip skeleton table switch toggle-group alert-dialog sheet --dry-run
```

Dry-run result at audit time:
- `+ src/shared/ui/card.tsx`
- `+ src/shared/ui/badge.tsx`
- `+ src/shared/ui/alert.tsx`
- `+ src/shared/ui/empty.tsx`
- `+ src/shared/ui/sonner.tsx`
- `+ src/shared/ui/scroll-area.tsx`
- `+ src/shared/ui/separator.tsx`
- `+ src/shared/ui/accordion.tsx`
- `+ src/shared/ui/collapsible.tsx`
- `+ src/shared/ui/tooltip.tsx`
- `+ src/shared/ui/skeleton.tsx`
- `+ src/shared/ui/table.tsx`
- `+ src/shared/ui/switch.tsx`
- `+ src/shared/ui/sheet.tsx`
- `+ src/shared/ui/label.tsx`
- `+ src/shared/hooks/use-mobile.ts`
- `+ src/shared/ui/toggle.tsx`
- `+ src/shared/ui/field.tsx`
- `+ src/shared/ui/alert-dialog.tsx`
- `+ src/shared/ui/sidebar.tsx`
- `+ src/shared/ui/toggle-group.tsx`
- `~ src/shared/ui/button.tsx`
- `~ src/shared/ui/input.tsx`

Important: installing all of the above at once wants to overwrite `apps/desktop/src/shared/ui/button.tsx` and `apps/desktop/src/shared/ui/input.tsx`. Those files already contain local app variants and should not be overwritten blindly. Prefer adding smaller batches and use `--dry-run` / `--diff` before accepting any overwrite.

Recommended install order:

1. Low-risk display primitives:
   ```bash
   cd apps/desktop
   npx shadcn@latest add card badge alert empty separator scroll-area tooltip skeleton --dry-run
   ```
2. Form primitives:
   ```bash
   cd apps/desktop
   npx shadcn@latest add field label switch toggle-group --dry-run
   ```
3. Overlay/feedback primitives:
   ```bash
   cd apps/desktop
   npx shadcn@latest add alert-dialog sheet sonner --dry-run
   ```
4. Navigation/layout primitives only when ready for the sidebar phase:
   ```bash
   cd apps/desktop
   npx shadcn@latest add sidebar collapsible accordion --dry-run
   ```

For each batch:
- Run dry-run first.
- If any existing file would be overwritten, run `npx shadcn@latest add <component> --diff <file>`.
- Preserve local app variants and theme integration.
- Do not use `--overwrite` unless explicitly approved.

## Highest-Priority Conversion Candidates

### 1. Automations modal, forms, cards, alerts, and empty states

Primary file:
- `apps/desktop/src/features/automations/AutomationsView.tsx`

Evidence:
- Hand-rolled alert: `AutomationsView.tsx:179` (`jobs-alert`)
- Hand-rolled modal/backdrop/dialog shell: `AutomationsView.tsx:181-344`
- Raw form layout classes: `AutomationsView.tsx:204-342`
- Custom label wrappers: `AutomationsView.tsx:207`, `216`, `225`, `262`, `274`, `280`, `286`, `295`, `311`
- Custom form notice/status: `AutomationsView.tsx:323-330`
- Custom count/status pills inside tabs: `AutomationsView.tsx:359`, `370`
- Custom empty states: `AutomationsView.tsx:416`, `445`, `597`
- Custom job rows/cards: `AutomationsView.tsx:447-539`
- Custom detail panel: `AutomationsView.tsx:551-600`
- Custom delivery row cards: `AutomationsView.tsx:615-638`

Recommended shadcn targets:
- `Dialog` for the create/edit automation modal. This component already exists in the repo; use it instead of `jobs-modal-backdrop` + `role="dialog"`.
- `Field`, `FieldGroup`, `FieldLabel`, and `FieldDescription` for the automation form.
- `Alert` for top-level error and form failure states.
- `Badge` for status/count pills: active, paused, error, run counts.
- `Card` for job rows, job detail, delivery rows, and activity containers.
- `Empty` for no active automations, no paused automations, no delivery activity, and no matched deliveries.
- `AlertDialog` for destructive delete confirmation if the current inline confirm-delete button remains awkward during conversion.

Implementation notes:
- Preserve all existing state and scheduler behavior. Do not touch `useIrisAutomations`, schedule parsing, project routing, or delivery correlation unless a type import is required.
- Keep the existing `ProjectMenu` behavior in the form. It intentionally mirrors the chat composer project selector semantics.
- If using `Field`, install `field` and `label` first. Do not replace form state with a form library.
- Keep the `maxLength` constraints on name and prompt. They mirror Hermes limits.
- The current modal closes on backdrop mouse down unless busy. `Dialog` should preserve close-on-outside-click only when `!formBusy`; block dismissal while busy.
- If using `Badge`, prefer semantic variants or local app variants rather than recreating `status-*` CSS classes.

Suggested implementation steps:
1. Add `card`, `badge`, `alert`, `empty`, `field`, and maybe `alert-dialog` via dry run.
2. Convert the top-level error at `AutomationsView.tsx:179` to `Alert`.
3. Replace the custom create/edit modal shell with `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, and `DialogDescription`.
4. Convert the form labels to `FieldGroup` / `Field` / `FieldLabel`; leave existing `Input`, `Textarea`, `Select`, and `ProjectMenu` controls in place.
5. Convert the count pills in the tab triggers to `Badge`.
6. Convert `JobList`, `JobDetail`, and `DeliveryRow` visual wrappers to `Card` composition. Do this carefully because their CSS controls dense desktop layout.
7. Convert empty state paragraphs to `Empty` after the layout is stable.

Verification:
- Targeted tests: `npm --workspace apps/desktop run test -- src/features/automations/__tests__/useIrisAutomations.test.ts`
- Broader desktop tests: `npm --workspace apps/desktop run test`
- Browser/Vite check at `http://localhost:1420/`:
  - Open Automations.
  - Create automation modal opens and closes.
  - Name, prompt, schedule mode, repeat mode, project selection, and submit controls behave exactly as before.
  - Active/paused tab counts render.
  - Empty states render without layout jumps.
  - Job detail, run-now, pause/resume, edit, and delete confirmation controls remain reachable.

### 2. Onboarding overlay

Primary file:
- `apps/desktop/src/features/polish/OnboardingOverlay.tsx`

Evidence:
- Custom scrim and dialog shell: `OnboardingOverlay.tsx:18-67`
- `section` with `role="dialog"` and `aria-modal="true"`: `OnboardingOverlay.tsx:19`
- Custom setup step cards: `OnboardingOverlay.tsx:32-54`

Recommended shadcn targets:
- `Dialog` for the overlay shell.
- `Card` only if the internal setup-step layout benefits from card composition.
- `Badge` or semantic icon treatment for connected/completed state.

Implementation notes:
- This is a very clean UI-only conversion. Keep the existing `connected`, `onClose`, `onOpenSettings`, and `onRefresh` props unchanged.
- Use `DialogTitle`. If the visible heading remains the `h1`, wire it as the title or include an accessible `DialogTitle`.
- Preserve the three actions: Open Settings, Retry connection, Start exploring.

Verification:
- Browser/Vite check at `http://localhost:1420/`.
- Trigger onboarding from the app command or existing first-run path.
- Confirm close, open settings, and retry connection actions still work.

### 3. Settings cards, fields, notices, and details disclosure

Primary file:
- `apps/desktop/src/features/settings/SettingsView.tsx`

Evidence:
- Custom service card: `SettingsView.tsx:184-208`, `379-395`
- Custom usage cards: `SettingsView.tsx:224-233`
- Custom core connection form card: `SettingsView.tsx:244-287`
- Custom model card/details disclosure: `SettingsView.tsx:399-420`
- Custom runtime/token fields: `SettingsView.tsx:423-467`, `497-523`
- Custom settings section panel: `SettingsView.tsx:470-493`
- Custom notice: `SettingsView.tsx:316`

Recommended shadcn targets:
- `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`
- `Field`, `FieldGroup`, `FieldLabel`, `FieldDescription`
- `Alert` for `settings-notice` and save/clear failures
- `Badge` for healthy/offline/stored statuses
- `Accordion` or `Collapsible` for the model configuration disclosure

Implementation notes:
- Preserve the two `mode` surfaces: `settings` and `profile`.
- Do not change remote credential storage, Core URL persistence, token save/clear behavior, or profile actions.
- `TokenField` should remain a small local component, but its markup should compose shadcn `Field` and `Input`.
- `SettingsSection` can become a thin wrapper over `Card` for `variant="panel"` and plain section markup for `variant="plain"`.
- `ModelCard` can become `Collapsible` or `Accordion` if it keeps the same summary + JSON/preformatted content behavior.

Verification:
- Targeted tests that touch runtime config if present:
  - `npm --workspace apps/desktop run test -- src/app/__tests__/runtimeConfig.test.ts`
  - `npm --workspace apps/desktop run test -- src/lib/__tests__/agentuiCore.test.ts`
- Browser/Vite:
  - Settings view renders.
  - Provider/model overrides can be edited.
  - Core URL/token fields still accept values.
  - Save/clear buttons keep disabled states.
  - Notice/status messages render.
  - Profile mode still shows agent management workflows.

### 4. Notification center / toast stack

Primary files:
- `apps/desktop/src/features/polish/NotificationCenter.tsx`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/App.css`

Evidence:
- Custom toast stack: `NotificationCenter.tsx:13-35`
- App-level notification state: `App.tsx:41`, `App.tsx:383-384`, `App.tsx:425-429`
- Custom CSS starts around `.notification-stack` in `App.css`

Recommended shadcn target:
- `sonner`

Implementation notes:
- Install `sonner` via shadcn (`npx shadcn@latest add sonner --dry-run`) and review the generated `sonner.tsx`.
- Add the shadcn `Toaster` once near the app root.
- Replace `NotificationCenter` with either:
  - direct calls to `toast.success`, `toast.error`, and `toast`, or
  - a very thin compatibility helper that maps existing `AppNotification` shape to sonner.
- Preserve the current call sites and auto-dismiss behavior while migrating. The current code keeps at most four notifications and dismisses after a timeout; sonner can own this behavior.
- Do not keep both systems active long-term. Once sonner is wired, remove the custom `notification-stack` CSS and `NotificationCenter` component.

Verification:
- Browser/Vite:
  - Trigger a success notification from a known action.
  - Trigger an error notification from a known failure path or mocked offline path.
  - Confirm dismiss works.
  - Confirm multiple notifications stack without overlapping app chrome.
- Tests: run `npm --workspace apps/desktop run test` after updating `App.tsx`.

### 5. Memory dashboard, panels, toggles, editor state, and empty states

Primary file:
- `apps/desktop/src/features/memory/MemoryView.tsx`

Evidence:
- Metric tiles: `MemoryView.tsx:125-130`, `371-379`
- Provider cards: `MemoryView.tsx:132-148`
- Checkbox/toggle rows: `MemoryView.tsx:149-172`
- Custom editor textarea: `MemoryView.tsx:210-215`
- Custom save state: `MemoryView.tsx:217-221`
- Custom lower panels: `MemoryView.tsx:224-294`
- Custom empty state: `MemoryView.tsx:277`
- Reset confirmation already uses shadcn `Dialog`: `MemoryView.tsx:301-338`

Recommended shadcn targets:
- `Card` for metric tiles, provider cards, and lower panels
- `Badge` for ready/offline, dirty/saved, diff counters
- `Switch` if the provider controls are intended to feel like on/off toggles; otherwise keep existing shadcn `Checkbox`
- `Textarea` for the memory editor if custom line-number behavior is not required
- `ScrollArea` for search results, timeline, diff, and memory editor/diff panels
- `Empty` for no revisions and no search results if added
- `Alert` for save/reset failures if any are surfaced

Implementation notes:
- Do not change memory load/save/reset semantics.
- The raw memory editor textarea might be intentionally custom for large plain-text editing. If replacing with `Textarea` loses necessary sizing or performance, leave it custom and only align its CSS tokens.
- The reset dialog already uses shadcn. It can stay as-is except for any shared `AlertDialog` decision for destructive confirmation consistency.

Verification:
- Browser/Vite:
  - Memory dashboard renders with metrics.
  - Provider toggles work visually.
  - Edit memory text, save state changes to dirty/saved.
  - Search, timeline, diff panels remain scrollable.
  - Reset dialog still blocks until `RESET MEMORY` is typed.

## Medium-Priority / Larger Migrations

### Sidebar and session/project trees

Primary file:
- `apps/desktop/src/layout/AppShell.tsx`

Evidence:
- Custom sidebar root and nav: `AppShell.tsx:404-745`
- Custom top-level nav buttons: `AppShell.tsx:419-468`
- Custom scroll region: `AppShell.tsx:470-732`
- Custom empty/notices: `AppShell.tsx:524`, `562`, `705`, `719`, `920`, `935`
- Custom resize handle: `AppShell.tsx:738-744`
- Command search is already shadcn `CommandDialog`: `AppShell.tsx:1150-1201`
- Sidebar organization menu already uses shadcn `DropdownMenu`: `AppShell.tsx:1240-1260`

Recommended shadcn targets:
- `Sidebar`
- `ScrollArea`
- `Separator`
- `Collapsible`
- `Badge`
- `Tooltip`

Implementation notes:
- Treat this as a dedicated migration, not a quick cleanup. This file contains desktop chrome, drag regions, resize behavior, project/session tree state, pinned sessions, and keyboard shortcuts.
- Preserve sidebar width state, `Meta+B`, resize-to-collapse behavior, project/session collapsed state, pinned sessions, and organization mode.
- The shadcn `Sidebar` component may bring its own mobile/responsive assumptions. Audit generated code carefully before wiring it into a Tauri desktop shell.
- Do not migrate this in the same PR as Automations or Settings. The blast radius is too large.

Verification:
- Targeted tests: `npm --workspace apps/desktop run test -- src/layout/__tests__/AppShell.test.ts`
- Browser/Vite:
  - Collapse/expand sidebar.
  - Resize sidebar.
  - Switch organization between projects and agents.
  - Pinned sessions render.
  - Project and agent trees expand/collapse and persist.
  - Session search command dialog still works.
- For this phase, consider packaged desktop verification after browser iteration because sidebar/chrome behavior is desktop-sensitive.

### Slash command menu

Primary file:
- `apps/desktop/src/features/chat/components/SlashCommandMenu.tsx`

Evidence:
- Custom absolute-positioned listbox: `SlashCommandMenu.tsx:36-96`
- Manual active state, listbox/option roles, and custom rows

Recommended shadcn targets:
- `Popover`
- `Command`
- `CommandList`
- `CommandGroup`
- `CommandItem`
- `CommandEmpty`

Implementation notes:
- The app already has `Command` and `Popover` installed and uses them for model selection and command search.
- Preserve composer anchoring and keyboard navigation from `ChatView`.
- Current listbox active index is driven by composer key handling. Either keep that model and style `CommandItem` with `data-selected`, or let cmdk own navigation only if it does not break slash insertion semantics.

Verification:
- Targeted tests: `npm --workspace apps/desktop run test -- src/features/chat/__tests__/slashCommands.test.ts src/features/chat/__tests__/ChatView.test.ts`
- Browser/Vite:
  - Type `/`.
  - Loading, error, empty, and populated states render.
  - Arrow navigation and enter selection work.
  - Mouse hover and click selection work.
  - The menu remains anchored above the composer.

## Lower-Priority / Use Judgment

These areas are custom enough that they should not be converted just for purity:

- `apps/desktop/src/shared/CodeEditor.tsx`
  - Evidence: custom line-number pre + textarea at `CodeEditor.tsx:30-37`.
  - Keep custom unless a shadcn `Textarea` wrapper can preserve line numbers and editor ergonomics.

- `apps/desktop/src/features/chat/components/MessageContent.tsx`
  - Evidence: attachment cards at `MessageContent.tsx:45-84`, audio player at `MessageContent.tsx:311-360`, markdown table wrapper at `MessageContent.tsx:470-475`.
  - The audio player and markdown renderer are domain-specific. Use shadcn tokens/wrappers opportunistically, but do not force generic primitives.

- `apps/desktop/src/features/chat/components/AttachmentTray.tsx`
  - Evidence: attachment pills at `AttachmentTray.tsx:21-56`.
  - Could use `Badge` or `Card` styling eventually, but current compact pill behavior is specific to the composer.

- `apps/desktop/src/features/chat/components/ToolEvents.tsx`
  - Evidence: custom live tool progress list and `details` disclosure at `ToolEvents.tsx:10-47`.
  - Could use `Collapsible` and `Badge` later. Not urgent.

## Cross-Cutting Cleanup Opportunities

### Form fields

Files with obvious form wrapper opportunities:
- `apps/desktop/src/features/automations/AutomationsView.tsx`
- `apps/desktop/src/features/settings/SettingsView.tsx`
- `apps/desktop/src/features/skills/SkillsView.tsx`
- `apps/desktop/src/layout/AppShellDialogs.tsx`
- `apps/desktop/src/features/agents/AgentList.tsx`

Current pattern:
- Many forms use `<label className=...><span>Label</span><Input /></label>` or `div` wrappers.

Target pattern:
- `FieldGroup`
- `Field`
- `FieldLabel`
- `FieldDescription`
- `FieldError` if available/appropriate

Migration note:
- Keep this mechanical and behavior-preserving. Do not introduce validation libraries or change submit behavior.

### Status indicators and pills

Current custom classes include:
- `source-pill`
- `job-status-dot`
- `jobs-detail-status`
- `status-dot`
- `service-health-dot`
- `attachment-pill`
- `memory-save-state`
- `notification`

Target:
- Use `Badge` for textual statuses and counts.
- Keep tiny decorative dots where they are part of compact tree rows, but use semantic tokens and consistent class names.

### Empty states

Current custom empty state classes include:
- `empty-state`
- `jobs-empty`
- `history-empty`
- `memory-empty`
- `CommandEmpty` already exists in command surfaces

Target:
- Use shadcn `Empty` for view/panel empty states.
- Keep `CommandEmpty` inside command menus.

### Scroll areas

Candidate scroll containers:
- Sidebar scroll region in `AppShell.tsx`
- Command lists already use shadcn `CommandList`
- Memory search/timeline/diff panels
- Automations job/activity lists
- Markdown table wrapper may remain custom

Target:
- Use `ScrollArea` where a styled contained scroll region exists.
- Avoid replacing StickToBottom chat transcript scrolling; it has special behavior.

## Non-Goals / Guardrails

- Do not change Hermes, Iris Core, adapter plugin code, persistence schemas, runtime API contracts, scheduler semantics, or chat transport.
- Do not rewrite business logic while converting UI structure.
- Do not overwrite existing shadcn `Button` or `Input` local variants without explicit approval and a diff review.
- Do not introduce a second design language. Use the existing custom theme tokens in `App.css`.
- Do not replace domain-specific controls such as the chat transcript scroller, composer attachment handling, audio waveform/player, or code editor unless the primitive preserves the exact interaction.
- Do not run packaged desktop verification for routine UI-only shadcn migration slices unless explicitly requested or desktop-specific risk appears. Use Browser/Vite checks for normal iteration.

## Suggested Phase Plan

### Phase 1: Add low-risk primitives and convert Automations modal/form

Components:
- `card`
- `badge`
- `alert`
- `empty`
- `field`
- `label`
- optionally `alert-dialog`

Files:
- `apps/desktop/src/features/automations/AutomationsView.tsx`
- `apps/desktop/src/App.css`

Acceptance:
- Automation create/edit modal uses shadcn `Dialog`.
- Form layout uses shadcn field primitives.
- Error/empty/status UI uses `Alert`, `Empty`, and `Badge` where sensible.
- No scheduler or project-routing behavior changes.

### Phase 2: Convert Settings surface

Components:
- `card`
- `badge`
- `alert`
- `field`
- `accordion` or `collapsible`

Files:
- `apps/desktop/src/features/settings/SettingsView.tsx`
- `apps/desktop/src/App.css`

Acceptance:
- Settings sections/cards use shadcn composition.
- Runtime/token fields use field primitives.
- Notices use `Alert`.
- Model config disclosure uses `Accordion` or `Collapsible`.
- Credential and runtime config behavior unchanged.

### Phase 3: Convert Notifications to sonner

Components:
- `sonner`

Files:
- `apps/desktop/src/features/polish/NotificationCenter.tsx`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/App.css`

Acceptance:
- App notifications use `sonner`.
- Custom notification stack and related CSS removed.
- Existing notification call sites still show success/error/info messages.

### Phase 4: Convert Onboarding overlay

Components:
- `dialog`
- optionally `card`, `badge`

Files:
- `apps/desktop/src/features/polish/OnboardingOverlay.tsx`
- `apps/desktop/src/App.css`

Acceptance:
- Onboarding uses shadcn `Dialog`.
- Close/open settings/retry actions behave unchanged.

### Phase 5: Convert Memory dashboard/panels

Components:
- `card`
- `badge`
- `empty`
- `scroll-area`
- possibly `switch`

Files:
- `apps/desktop/src/features/memory/MemoryView.tsx`
- `apps/desktop/src/App.css`

Acceptance:
- Metric/provider/panel shells use shadcn composition.
- Dirty/saved/status indicators are consistent.
- Editor behavior and reset flow unchanged.

### Phase 6: Slash command menu

Components:
- existing `command`
- existing `popover`

Files:
- `apps/desktop/src/features/chat/components/SlashCommandMenu.tsx`
- `apps/desktop/src/features/chat/ChatView.tsx` only if anchoring/control state needs adjustment

Acceptance:
- Slash menu remains anchored above composer.
- Keyboard and mouse selection are unchanged.
- Loading/error/empty states remain clear.

### Phase 7: Sidebar migration

Components:
- `sidebar`
- `scroll-area`
- `separator`
- `collapsible`
- `tooltip`
- `badge`

Files:
- `apps/desktop/src/layout/AppShell.tsx`
- `apps/desktop/src/App.css`
- `apps/desktop/src/layout/__tests__/AppShell.test.ts` only if test selectors need updating without behavior change

Acceptance:
- Sidebar behavior is identical: resize, collapse, pinned sessions, project/agent organization, project/session trees, context menus, and keyboard shortcuts.
- Browser/Vite checks pass.
- Because this touches desktop chrome, run packaged app verification if this phase is implemented.

## Test / Verification Commands

For normal UI-only shadcn migration slices:

```bash
npm --workspace apps/desktop run test
npm run dev
```

Open the Vite surface in the built-in browser:

```text
http://localhost:1420/
```

Use `http://localhost:1420/`, not `http://127.0.0.1:1420/`, because the in-app browser may block the latter.

For focused areas:

```bash
npm --workspace apps/desktop run test -- src/features/automations/__tests__/useIrisAutomations.test.ts
npm --workspace apps/desktop run test -- src/features/chat/__tests__/slashCommands.test.ts src/features/chat/__tests__/ChatView.test.ts
npm --workspace apps/desktop run test -- src/layout/__tests__/AppShell.test.ts
npm --workspace apps/desktop run test -- src/app/__tests__/runtimeConfig.test.ts
```

Run the broader gate before considering a multi-file migration done:

```bash
npm run check
```

Packaged desktop verification:
- Not required for routine UI-only shadcn migration slices.
- Required if the change touches desktop-specific chrome or behavior, especially the sidebar phase.
- When required, build with:
  ```bash
  npm run build:mac:app
  ```
- Then launch the newly built bundle and test with Computer Use against `com.nousresearch.hermes-agent.desktop`.

## Completion Criteria

The migration is complete when:
- All obvious custom cards/panels use `Card` or an intentional local component with documented reason.
- Alerts/notices use `Alert` or `sonner`.
- Empty states use `Empty` except inside command menus.
- Status/count pills use `Badge` unless they are purely decorative dots.
- Forms use `Field` composition where practical.
- Custom modal/scrim shells are replaced by `Dialog`, `AlertDialog`, `Sheet`, or intentionally documented exceptions.
- Sidebar migration is either complete or explicitly deferred with rationale.
- `npm run check` passes.
- Browser/Vite smoke checks pass on `http://localhost:1420/`.
- Final notes say whether Vite HMR picks up the change automatically or whether a restart/fresh chat/packaged rebuild is needed.
