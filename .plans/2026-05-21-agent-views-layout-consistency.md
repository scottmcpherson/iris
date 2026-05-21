# Agent Views Layout Consistency

## Goal

Make the Agents area feel like one coherent workspace across the agent list, agent overview, memory, and skills views.

The user-visible problem is that each Agents subview currently chooses its own content width and page structure:

- Agent list is wide and row-heavy.
- Agent overview is much narrower because it inherits the chat content width.
- Memory also inherits the narrow chat content width even though it has editor/workbench behavior.
- Skills jumps wider again because it has its own split-pane cap.

End state:

1. The outer left/right content edge is predictable when moving between Agents subviews.
2. Width changes only when the task model changes, and the reason is visible: readable record, dense list, or workbench/editor.
3. The agent detail tabs feel like sections of one selected agent, not different apps embedded in the same route.
4. Existing runtime, memory, skills, persistence, routing, and Core/Hermes behavior remain unchanged.

## Current Repo State

Primary files:

- `desktop/src/features/agents/AgentsView.tsx`
  - Chooses list vs detail based on `detailProfile`.
  - Wraps both states in `tool-view agents-workspace`.
- `desktop/src/features/agents/AgentList.tsx`
  - Renders the agent index with `agent-list-workspace` and `agent-list-row`.
- `desktop/src/features/agents/AgentDetailView.tsx`
  - Switches between overview, memory, and skills.
  - Overview embeds `SettingsView` with `mode="profile"`.
  - Memory and skills are wrapped in `agent-subview`.
- `desktop/src/features/agents/AgentTopbar.tsx`
  - Provides back button, selected agent title, and Overview/Memory/Skills tabs.
- `desktop/src/features/memory/MemoryView.tsx`
  - Renders a full `tool-view memory-workspace`.
- `desktop/src/features/skills/SkillsView.tsx`
  - Renders a full `tool-view skills-workspace`.
- `desktop/src/features/settings/SettingsView.tsx`
  - Owns both global settings and the profile overview mode.
- `desktop/src/App.css`
  - Contains the current layout width rules and view CSS.

Current width rules:

- `--chat-content-max-width: 800px` is defined on `.chat-pane, .tool-view, .jobs-view`.
- `.settings-view-general` uses `width: min(calc(100% - 96px), var(--chat-content-max-width))`.
- `.agent-list-workspace` uses `width: min(calc(100% - 96px), 1120px)`.
- `.agent-detail-grid` uses `width: min(calc(100% - 96px), var(--chat-content-max-width))`.
- `.agent-subview > .memory-workspace` uses the same chat max width.
- `.agent-subview > .skills-workspace` overrides to `width: min(calc(100% - 96px), 1280px)`.

Observed in Vite at `http://localhost:1420/`:

- At the default in-app browser size, list and skills land around 820 px while overview and memory land at 800 px.
- At a wider viewport, list and skills land around 1113 px while overview and memory remain 800 px.
- That creates a visible horizontal jump between tabs and makes the overview feel unrelated to the list/details flow.

## Design Decision

Use one Agents layout system with three explicit content modes:

- `record`: profile overview and moderate-density records. Target max: about 1040 px.
- `workbench`: editor/split-pane views such as memory and skills. Target max: about 1200-1280 px.
- `index`: the agent list/index. Target max: about 1040 px initially, with a later master-detail option.

Do not reuse `--chat-content-max-width` for Agents. Chat has a reading/composer constraint; Agents has management/workbench constraints.

This plan intentionally separates two levels of work:

1. **Baseline consistency pass**: normalize widths, scroll, and wrappers without changing app behavior.
2. **Workspace refinement pass**: consider desktop master-detail behavior after the baseline has shipped and been visually verified.

## Non-Goals

- Do not change Iris Core, Hermes adapters, bridge commands, persistence, runtime contracts, memory save/reset behavior, or skills save/load behavior.
- Do not rename routes or change route semantics.
- Do not change chat layout widths as part of this work.
- Do not run packaged desktop verification until there is an actual visible UI implementation to verify.
- Do not overwrite unrelated existing edits in `desktop/src/App.css` or chat files.

## Phase 1: Add Agents Layout Tokens

Add Agents-scoped layout tokens in `desktop/src/App.css` near `.agents-workspace`:

```css
.agents-workspace {
  --agent-page-gutter: clamp(16px, 4vw, 48px);
  --agent-index-max-width: 1040px;
  --agent-record-max-width: 1040px;
  --agent-workbench-max-width: 1280px;
  align-content: stretch;
  padding: 0;
}
```

Then introduce a single frame class:

```css
.agent-content-frame {
  width: min(calc(100% - (var(--agent-page-gutter) * 2)), var(--agent-frame-max-width));
  min-width: 0;
  min-height: 0;
  margin: 0 auto;
  padding: 24px 0 30px;
}

.agent-content-frame[data-layout="index"] {
  --agent-frame-max-width: var(--agent-index-max-width);
  padding-top: 30px;
}

.agent-content-frame[data-layout="record"] {
  --agent-frame-max-width: var(--agent-record-max-width);
}

.agent-content-frame[data-layout="workbench"] {
  --agent-frame-max-width: var(--agent-workbench-max-width);
}
```

Responsive behavior:

- At `max-width: 820px`, set frame width to `100%` and horizontal padding to `16px`.
- Keep current small-screen row stacking behavior.
- Ensure the topbar tabs do not overflow; if needed, allow horizontal scroll or compact trigger widths under 760 px.

Remove or replace these older width rules after the frame is in place:

- `.agent-list-workspace { width: min(calc(100% - 96px), 1120px); ... }`
- `.agent-detail-grid { width: min(calc(100% - 96px), var(--chat-content-max-width)); ... }`
- `.agent-subview > .memory-workspace, .agent-subview > .skills-workspace { width: ... }`
- `.agent-subview > .skills-workspace { width: min(calc(100% - 96px), 1280px); }`

## Phase 2: Add a Small Agents Layout Component

Create:

- `desktop/src/features/agents/AgentContentFrame.tsx`

Suggested API:

```tsx
type AgentContentLayout = "index" | "record" | "workbench";

export function AgentContentFrame({
  layout,
  className,
  children,
}: {
  layout: AgentContentLayout;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("agent-content-frame", className)} data-layout={layout}>
      {children}
    </div>
  );
}
```

Use the local `cn` helper if available. If there is no shared helper in this repo, either add one in the existing shared utility location or keep the class join inline to avoid creating a broad abstraction for one use.

Update:

- `AgentList.tsx`
  - Replace root `agent-list-workspace` width ownership with `AgentContentFrame layout="index"`.
  - Keep the existing header and grid inside the frame.
- `AgentDetailView.tsx`
  - Wrap overview in `AgentContentFrame layout="record"`.
  - Wrap memory and skills in `AgentContentFrame layout="workbench"`.
  - Remove `agent-subview` as the width-owning layer, or keep it only as a `height: 100%` neutral wrapper.

## Phase 3: Stop Nesting Full Page Shells

`MemoryView` and `SkillsView` currently return `tool-view` roots even when embedded under `AgentDetailView`. This causes nested page behavior and makes width/scroll harder to reason about.

Change:

- `MemoryView.tsx`
  - Root should become `div className="memory-workspace"` instead of `div className="tool-view memory-workspace"` if the component is only used by Agents.
  - If a future standalone Memory route is expected, add a prop such as `embedded?: boolean` and default it conservatively.
- `SkillsView.tsx`
  - Root should become `div className="skills-workspace"` instead of `div className="tool-view skills-workspace"` under the same rule.

CSS cleanup:

- Make `.memory-workspace` and `.skills-workspace` content components, not page frames.
- Keep their internal grids, panels, editors, and scroll behavior.
- Make `.skills-browser` height derive from the available frame height rather than from nested `tool-view` behavior.

Acceptance check:

- The `.tool-view` class should appear once for the Agents surface, not again inside memory or skills detail content.

## Phase 4: Extract a Real Agent Overview

Overview currently comes from `SettingsView mode="profile"`. It works technically, but visually it makes the profile detail feel like a settings page with hidden toolbar pieces.

Create:

- `desktop/src/features/agents/AgentOverviewView.tsx`

Move or extract the profile-only overview markup from `SettingsView.tsx`:

- Runtime/core status strip.
- Runtime readiness banner and gateway/adapter actions.
- Runtime configuration/model card.
- Profile metadata.
- Profile workflows/actions.

Implementation options:

1. Move profile-only helper components from `SettingsView.tsx` into `AgentOverviewView.tsx`.
2. Extract shared pieces into `desktop/src/features/settings/settingsProfileComponents.tsx` if the global settings page still needs them.
3. Keep global settings behavior in `SettingsView mode="settings"` unchanged.

Preferred result:

- `SettingsView` should primarily own global settings.
- `AgentOverviewView` should own the selected agent overview.
- `AgentDetailView` should no longer import `SettingsView`.

This is also the right time to tune overview density:

- Avoid a single narrow `800px` settings stack.
- Use a `record` frame and a two-column grid only when there is enough width.
- Keep critical health/runtime actions near the top.
- Keep destructive/rare profile workflows visually lower and quieter.

## Phase 5: Tighten the Agent List

The agent list rows are currently very wide for the amount of content they contain. After the shared frame is in place:

- Reduce the index max width from the current 1120-ish behavior to about 1040 px.
- Keep row height stable around 72-78 px on desktop.
- Make stats less dominant:
  - Sessions, memory, and skills can remain in the row, but should feel like metadata rather than columns from a table.
  - Consider hiding stat labels earlier and relying on icons/tooltips where clear.
- Keep gateway health/action prominent because it is operationally important.
- Preserve the row menu affordance and existing actions.

Do not convert to cards. This is a management surface; a dense, scannable list is more appropriate than decorative cards.

## Phase 6: Optional Desktop Master-Detail Refinement

After the baseline width cleanup is stable, consider converting Agents on desktop into a persistent master-detail workspace:

- Left pane: agent list, fixed around 300-340 px.
- Right pane: selected agent detail with Overview/Memory/Skills.
- At small widths, keep the current list-then-detail route behavior.

This would reduce the feeling of "leaving" the list when opening an agent and would solve the overly wide list row problem more strongly than a simple max-width cap.

Recommended implementation path:

1. Add `AgentWorkspaceShell.tsx` with desktop split behavior.
2. Split `AgentList` into:
   - `AgentList` or `AgentIndexView` for standalone list route.
   - `AgentListPane` for master-detail sidebar use.
3. In `AgentsView.tsx`, when `detailProfile` exists, render both list pane and detail pane at desktop sizes.
4. Keep URL routing unchanged:
   - `/agents` shows the index.
   - `/agents/:profile` shows selected profile.
   - `/agents/:profile/:section` shows selected profile section.
5. On desktop detail routes, keep the list pane visible.
6. On mobile/narrow widths, hide the list pane and keep the back button behavior.

This should be a second implementation after the baseline pass because it touches interaction and responsive behavior more deeply.

## Testing and Verification

During development:

1. Assume the user usually has `npm run dev` running.
2. Use the Browser plugin against `http://localhost:1420/`, not `127.0.0.1`.
3. Check these routes:
   - `http://localhost:1420/agents`
   - `http://localhost:1420/agents/default`
   - `http://localhost:1420/agents/default/memory`
   - `http://localhost:1420/agents/default/skills`
4. Verify at least these viewport conditions:
   - Current/default in-app browser size.
   - Wide desktop, around 1460 px wide or larger.
   - Narrow desktop/tablet, around 820 px.
5. Use DOM measurements for content frame width and screenshot checks for visual jumps.

Targeted tests:

```bash
npm --workspace desktop run test -- AgentList AgentDetailView
```

If overview extraction changes settings/profile helpers, also run:

```bash
npm --workspace desktop run test -- SettingsView runtimeReadiness
```

Before finishing a visible UI implementation, follow the repository instruction for packaged verification:

```bash
npm run build:mac:app
```

Then launch the freshly built macOS app bundle and test with Computer Use against:

```text
com.nousresearch.hermes-agent.desktop
```

Do not use raw `npm run tauri dev` for final Computer Use verification.

## Acceptance Criteria

- Agent list, overview, memory, and skills no longer inherit unrelated chat width rules.
- Switching between Overview, Memory, and Skills does not produce an unexplained horizontal jump.
- Workbench views may be wider than record views, but the frame logic is explicit and shared.
- `MemoryView` and `SkillsView` no longer own full page padding when embedded in an agent detail view.
- Overview reads as an agent overview, not a settings page with hidden chrome.
- Existing agent actions still work:
  - Open agent.
  - Back to all agents.
  - Switch overview/memory/skills tabs.
  - Start/stop/restart gateway actions.
  - Install adapter action.
  - Save/reset memory.
  - Create/save skills.
- Responsive behavior remains stable under 820 px and 640 px breakpoints.
- Existing dev session should pick up CSS/component changes through Vite hot reload; no Iris Core, Hermes adapter, or gateway restart should be required for layout-only work.

## Risks and Mitigations

- Risk: Changing `tool-view` nesting could alter scroll behavior.
  - Mitigation: Verify each route can scroll independently and no editor is clipped.
- Risk: Extracting profile overview from `SettingsView` could accidentally change global settings.
  - Mitigation: Keep `mode="settings"` path untouched during the first pass, then extract profile-only helpers in a separate commit.
- Risk: Skills needs width for split-pane editing while overview does not.
  - Mitigation: Use explicit `record` and `workbench` frame modes instead of forcing one max width everywhere.
- Risk: Existing dirty worktree edits in `App.css` may overlap.
  - Mitigation: Review `git diff -- desktop/src/App.css` before editing and only touch the Agents layout regions.

## Suggested Commit Breakdown

1. `agents: add shared content frame`
   - Add layout tokens/component.
   - Normalize list/detail/memory/skills widths.
   - Remove nested page shell classes from memory/skills if safe.
2. `agents: extract overview view`
   - Add `AgentOverviewView`.
   - Move profile-only settings markup/helpers.
   - Keep global settings behavior unchanged.
3. `agents: refine index density`
   - Tune list row width, grid columns, metadata priority, and responsive behavior.
4. Optional later commit: `agents: add desktop master-detail layout`
   - Introduce persistent list pane for desktop detail routes.

