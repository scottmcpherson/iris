# CSS architecture cleanup

## Goal

Bring the Iris desktop styling architecture in line with how the rest of the codebase is organized. Today, almost all styling lives in a single 6,724-line `desktop/src/App.css`. Many of those rules exist for no good reason — they're named classes that wrap two or three Tailwind utilities — and the file's size makes refactors slow, merge-conflict-prone, and intimidating to new contributors.

End state:

1. **Design tokens live in their own file** — `:root` variables and the `@theme inline` block are extracted from `App.css` into a dedicated `tokens.css` (or similarly named) entry. The token taxonomy stays exactly as it is after the 2026-05-22 tokenization pass.
2. **Trivial layout classes are inlined as Tailwind utilities** — any CSS rule whose declarations are all replaceable by Tailwind utility classes (flex/grid/gap/padding/margin/sizing/font/position/overflow) is deleted, and its class name is replaced with the equivalent utility string in TSX.
3. **Remaining "real" CSS lives per-feature** — rules that genuinely need to stay in CSS (pseudo-elements, keyframes, `-webkit-app-region`, complex compound selectors, scrollbar styling, drag handles) move out of `App.css` into a per-feature stylesheet imported by the owning component.
4. **`App.css` shrinks to a thin entry file** — it imports tokens, global resets, and any cross-cutting base styles only. Target size: under 400 lines.
5. **Future regressions are guarded** — a lightweight check (lint rule, eslint plugin, or CI script) flags new CSS rules consisting solely of utility-equivalent properties.

This is a refactor, not a redesign. The visible UI must be pixel-identical before and after, on every page, every state. The Iris token system from 2026-05-22 stays exactly as-is.

## Current Repo State

### App.css size and shape

- File: `desktop/src/App.css`, **6,724 lines**.
- Only stylesheet in `desktop/src/` — no other `.css` files exist.
- Imports at top: `tailwindcss`, `tw-animate-css`, `streamdown/styles.css`.
- Lines 1-122: `@theme inline` block (Tailwind v4 token mappings — ~110 `--color-*` entries).
- Lines 123-304: `:root` block (~150 design tokens — the canonical color/shadow/gradient palette).
- Lines 305-6724: ~836 named class rules grouped roughly by feature, no internal section comments.

### Class rule distribution

Top-level named class rules in `App.css`, grouped by prefix:

```
 125  .agent-*       (agent list, agent detail, agent gateway, agent topbar, etc.)
  89  .message-*     (message rendering, audio waveform, markdown, attachments)
  79  .profile-*     (profile tree, config, workflows, node)
  64  .skill-*       (skill row, group, detail)
  63  .sidebar-*     (sidebar layout, sessions, scroll regions, toggle, resize)
  57  .jobs-*        (jobs detail, form, header, body, alert)
  56  .settings-*    (settings panes, advanced, notice, row)
  55  .memory-*      (memory history, capacity, workspace, revision)
  32  .tool-*        (tool result, tool progress)
  30  .onboarding-*  (onboarding card, path, copy)
  27  .core-*        (core connection, core status)
  27  .composer-*    (composer recording, attachment, pill)
  20  .service-*     (service card)
  17  .ssh-*
  17  .job-*
  15  .diagnostics-*
  14  .brand-*       (brand block, brand mark, brand status)
  13  .topbar-*
  13  .connection-*
  12  .runtime-*
  12  .model-*       (model card)
  11  .nav-*         (nav list, nav item, nav shortcut)
  11  .chat-*
   9  .setup-*
   9  .attachment-*
   ...
```

### Trivially-Tailwind-able rules

A scan classifying rules by whether their declarations are entirely "easy Tailwind" properties (`display`, `flex*`, `gap`, `grid-template-*`, `padding*`, `margin*`, `width`, `height`, `min/max-*`, `border-radius`, `font-size`, `font-weight`, `line-height`, `text-align`, `letter-spacing`, `overflow*`, `position`, `top`/`right`/`bottom`/`left`, `inset`, `z-index`, `opacity`, `cursor`, `user-select`, `pointer-events`, `box-sizing`, `white-space`, `text-overflow`, `word-break`, `overflow-wrap`):

- **347 of 836 rules (~41%)** consist only of utility-equivalent properties.
- These are the rules with no good reason to exist as named classes. They can be deleted and inlined as Tailwind utility strings in TSX.
- The remaining ~489 rules have at least one property that's awkward in utilities — pseudo-elements (`::before`, `::after`, `::-webkit-scrollbar`), keyframes, `-webkit-app-region`, complex compound `box-shadow`, `:has()`, `[data-state=...]` patterns, custom CSS properties used as runtime knobs (`--audio-progress`, `--sidebar-width`), etc.

### Feature directory structure

`desktop/src/features/` already organizes code by feature:

```
agents/
automations/
chat/
iris/
memory/
polish/
preview/
projects/
runtime/
settings/
skills/
```

These map cleanly onto the class-prefix clusters above, which gives an obvious destination for per-feature CSS files when we split.

### Imports of `App.css`

`App.css` is imported once in `desktop/src/main.tsx`. Nothing else in the codebase imports it. There is no per-component CSS today.

### Token system (already done — do not redo)

The 2026-05-22 tokenization pass converted every literal color in the app to a CSS variable. After this plan ships, that token set stays exactly the same — only its location may change. Do not re-token, re-name, or reshape colors as part of this work.

## Design Decisions

### Where things live after the refactor

```
desktop/src/styles/
  tokens.css           — :root variables + @theme inline mappings + @custom-variant dark
  base.css             — global resets, html/body, *, font setup, scrollbar baseline,
                          keyframes used cross-feature (shimmer-sweep, tool-pulse, etc.)
  app-shell.css        — .app-shell, .sidebar, .workspace, .topbar, .content-grid,
                          .window-drag-zone, .nav-list/.nav-item (cross-cutting layout chrome)

desktop/src/features/
  agents/agents.css         — .agent-*, .agent-list-*, .agent-detail-*, .agent-gateway-*,
                                .agent-topbar-*, .agent-switcher-*, .agent-overview-*
  automations/automations.css — anything matching automation surfaces
  chat/chat.css             — .chat-*, .new-chat-*, .composer-*, .message-*, .tool-*,
                                .attachment-*, .thinking-*, .hero-strip
  memory/memory.css         — .memory-*
  polish/polish.css         — small UX polish surfaces (onboarding, setup, growth)
  projects/projects.css     — project-tree and project-node CSS
  runtime/runtime.css       — .runtime-*, .core-*, .service-*, .diagnostics-*,
                                .core-connection-*, .core-status-*
  settings/settings.css     — .settings-*
  skills/skills.css         — .skill-*, .skills-*, .skill-group-*, .skill-row-*, .skill-detail-*
  iris/iris.css             — anything iris-specific not covered elsewhere

desktop/src/App.css         — thin entry file:
                                @import "./styles/tokens.css";
                                @import "./styles/base.css";
                                @import "./styles/app-shell.css";
                                + maybe a "@import everything else via feature roots"
                                pattern, depending on Vite resolution preferences
```

### Per-feature CSS lives next to the feature, not in a central styles dir

The per-feature `.css` files live in their feature directory (e.g. `desktop/src/features/chat/chat.css`), not in a central `desktop/src/styles/features/`. They're imported by the feature's root component (e.g. `ChatView.tsx`). Co-location > centralization for feature CSS.

The `desktop/src/styles/` directory holds only:
- Tokens
- Global base styles
- App shell chrome that isn't owned by any one feature

### What counts as "trivial" (must inline as Tailwind)

A CSS rule is **trivially Tailwind-able** iff *every* declaration in its body maps to a single Tailwind utility class with no custom config. Concretely:

- `display: flex` / `inline-flex` / `grid` / `inline-grid` / `block` / `inline-block` / `inline` / `none` / `contents`
- `flex-direction`, `flex-wrap`, `flex`, `flex-grow`, `flex-shrink`, `flex-basis`
- `align-items`, `align-self`, `justify-content`, `justify-items`, `justify-self`, `align-content`
- `gap`, `row-gap`, `column-gap` — only if value is a standard spacing scale token
- `grid-template-columns`, `grid-template-rows`, `grid-column`, `grid-row` — if value matches a Tailwind preset; otherwise keep as CSS
- `padding`, `padding-*`, `margin`, `margin-*` — if value is a standard spacing scale
- `width`, `height`, `min-width`, `max-width`, `min-height`, `max-height` — if value is a standard sizing
- `border-radius` — if value matches `--radius-*`
- `font-size`, `font-weight`, `line-height`, `letter-spacing`, `text-align` — standard scale
- `overflow`, `overflow-x`, `overflow-y`
- `position` (and `top`/`right`/`bottom`/`left`/`inset`), `z-index`
- `opacity`, `cursor`, `user-select`, `pointer-events`, `box-sizing`
- `white-space`, `text-overflow`, `word-break`, `overflow-wrap`

A rule is **not trivial** if it contains any of:

- Pseudo-elements (`::before`, `::after`, `::-webkit-scrollbar`, `::placeholder`)
- Pseudo-classes beyond `:hover`/`:focus`/`:focus-visible`/`:disabled`/`:checked` that aren't covered by Tailwind variants
- Combined selectors with descendants/children (e.g. `.sidebar .nav-item.active span`) — Tailwind doesn't express these
- `:has()`, `:where()`, `:is()` chains
- `@keyframes`
- `animation`, `transition` with multiple properties or non-standard easing
- `box-shadow` with compound or custom values not in the shadow scale
- `background` with gradients, multiple layers, `url()`, or `noise` SVG data URIs
- `transform` with non-trivial composition (matrix, multiple ops)
- `backdrop-filter`, `filter`
- `-webkit-app-region`, `-webkit-font-smoothing`, `font-synthesis`, and other browser-prefixed properties
- Custom CSS properties used as runtime knobs (e.g. `--audio-progress`, `--sidebar-width`)
- `attr()`, `counter()`, `clamp()`, `calc()` with non-trivial expressions
- Media queries, container queries, `@supports`
- `[data-*]` selectors used as state machines

The threshold matters because we'll convert hundreds of rules. If a rule is genuinely ambiguous, default to **keeping it as CSS** — being conservative is cheaper than introducing visual regressions.

### Don't introduce new abstractions

This refactor does not add a styling framework on top of Tailwind. No CSS-in-JS, no styled-components, no `cva()` outside where it already exists, no `tw()` helper. The tools are: Tailwind utilities, plain CSS files imported by components, and the token system.

### Run the change in small visible batches

Each batch should:

1. Cover one feature directory at a time (chat, then agents, then memory, etc.).
2. Be a single PR / commit per feature.
3. Verify visually in the browser at `http://localhost:1420/` after the change — every screen the feature owns.
4. Not bundle "trivial → Tailwind" conversions with "move to per-feature file" in the same commit, because the two changes have different risk profiles and reviewing them together is confusing.

The phase order in this plan keeps risky changes after low-risk ones, so a regression in a later phase doesn't have to be untangled from a prior phase's churn.

## Non-Goals

- Do not change the token system: names, values, organization. The 2026-05-22 pass is final.
- Do not migrate any rule into Tailwind utilities that doesn't pass the "trivial" test above.
- Do not introduce a new theming mechanism. `next-themes` wiring and a light-theme variant are separate work (the "step 2" the user mentioned).
- Do not add CSS-in-JS, styled-components, or any equivalent.
- Do not touch the `tw-animate-css` import or any other third-party styles.
- Do not change anything in shared shadcn primitives (`desktop/src/shared/ui/*`). Those already use utility-first patterns correctly.
- Do not refactor TypeScript or component logic to better-fit the new CSS structure. If a component is awkward but currently works, leave it.
- Do not introduce a CSS-modules naming convention. Class names stay global to match the current codebase.
- Do not rename, restructure, or split `desktop/src/features/`.
- Do not change the `:root` location during phase 1 — it stays at the top of `tokens.css`, mirroring how it lives at the top of `App.css` now.

## Implementation Phases

The plan runs in five phases. Phase 1 is the lowest-risk and should be done first. Phase 5 ships the regression guard so we don't slowly regrow the problem.

### Phase 1 — Extract tokens to `tokens.css` (low risk)

**Scope:** Cut lines 1-304 of `App.css` (imports + `@theme inline` + `:root`) into `desktop/src/styles/tokens.css`. Update `App.css` to import it as the first line.

**Specifics:**

- Create `desktop/src/styles/tokens.css`. Move:
  - `@import "tailwindcss";`
  - `@import "tw-animate-css";`
  - `@import "streamdown/styles.css";`
  - `@source "../node_modules/streamdown/dist/*.js";`
  - `@custom-variant dark (&:is(.dark *));`
  - The entire `@theme inline { … }` block.
  - The entire `:root { … }` block.
- In `App.css`, replace those lines with `@import "./styles/tokens.css";`.
- Verify `:root` resolutions still work — every `var(--foo)` reference elsewhere in `App.css` must still find its token. Tailwind v4 picks up `@theme` from imported files; verify dev server picks up the change.

**Visual verification:**

- Reload `http://localhost:1420/`. Compare visually against pre-change screenshots on:
  - Home (`/`)
  - Agents view (`/agents/default`)
  - Settings view (`/settings`)
  - At least one chat session with messages, attachments, and tool progress visible.
- No pixel-level diff is expected. Anything visibly different here is a regression introduced by the move and must be fixed before phase 2.

**Done when:**

- `tokens.css` exists; `App.css` imports it as line 1.
- All four reference views render identically.
- TypeScript still type-checks (`npx tsc --noEmit`).

### Phase 2 — Extract global base styles and app-shell chrome (low risk)

**Scope:** Move the rules that aren't feature-owned out of `App.css` into `desktop/src/styles/base.css` and `desktop/src/styles/app-shell.css`.

**`base.css` contents:**

- `html`, `body`, `#root` rules.
- `*` (`box-sizing`).
- `body` background and font-family resets.
- `button`, `textarea`, `select`, `input` `font: inherit` and `-webkit-app-region: no-drag`.
- `button` `cursor: default` rules.
- The shared `@keyframes` (e.g. `shimmer-sweep`, `tool-pulse`, anything else used cross-feature).
- The shared `kbd` styling.

**`app-shell.css` contents:**

- `.app-shell`, `.workspace`, `.window-drag-zone`, `.sidebar-collapsed *`, `.sidebar-resizing *` — only the cross-cutting layout chrome.
- `.topbar`, `.topbar-drag-zone`, `.topbar > :not(...)`, `.topbar-title`, `.topbar-actions`.
- `.content-grid`, `.primary-pane`, `.connection-banner`.
- The four `.nav-*` rules and `.nav-shortcut`.
- `.sidebar` shell, `.sidebar-toggle`, `.sidebar-resize-handle`, `.sidebar-scroll-region`, `.sidebar-section`, `.sidebar-settings`, `.brand-block`, `.brand-mark`, `.brand-name`, `.brand-status`, `.status-dot`, `.eyebrow`. (Note: leaves `.sidebar-session-*` and `.profile-*` rules in their feature files — those belong to chat history / projects respectively. The line gets fuzzier here; **default to leaving close-call rules in their feature file** rather than promoting them to app-shell.)

**Specifics:**

- Create both files. Cut the matching rules out of `App.css` and into the new file. Verify there are no duplicate rules. Verify there are no broken `var(--…)` references — these should all still resolve through `tokens.css`.
- Add `@import "./styles/base.css";` and `@import "./styles/app-shell.css";` after the tokens import in `App.css`.
- Order matters in CSS — keep the import order matching the rule order in the current `App.css` to avoid specificity surprises.

**Visual verification:**

Same four reference views as phase 1. Also test:

- Resize the sidebar (drag the handle).
- Toggle the sidebar with ⌘B.
- Resize the window — confirm the responsive sidebar auto-collapse still triggers.

**Done when:**

- `App.css` is down to feature-only CSS, lines roughly 305-end of the original.
- The three shell views render and behave identically.

### Phase 3 — Split feature CSS into per-feature files (low-medium risk)

**Scope:** For each feature in `desktop/src/features/`, create `<feature>.css`, move its class rules out of `App.css`, and import that file from the feature's root component. Do not change any rules during the move.

**Order (recommended, by independence):**

1. `runtime` — `.runtime-*`, `.core-*`, `.service-*`, `.diagnostics-*`, `.core-connection-*`, `.core-status-*`, `.ssh-*`. Imported by `runtime`'s root component. Independent of chat/agent/memory.
2. `settings` — `.settings-*`. Imported by `SettingsView.tsx`.
3. `memory` — `.memory-*`. Imported by `MemoryView.tsx`.
4. `skills` — `.skill-*`, `.skills-*`. Imported by `SkillsView.tsx`.
5. `polish` — onboarding/setup/growth surfaces. Imported by their respective components.
6. `automations` — anything matching automation surfaces.
7. `projects` — `.project-*`, `.profile-node.project-node`. Imported wherever projects are rendered (likely `AppShell.tsx`'s project tree).
8. `agents` — `.agent-*`, `.profile-*` (the profile tree lives here visually), `.agent-list-*`, `.agent-detail-*`, `.agent-gateway-*`, `.agent-topbar-*`, `.agent-switcher-*`, `.agent-overview-*`. Imported by `AgentsView.tsx`.
9. `chat` — the big one. `.chat-*`, `.new-chat-*`, `.composer-*`, `.message-*`, `.tool-*`, `.attachment-*`, `.thinking-*`, `.hero-strip`, `.streaming-*`, `.delivery-*`, `.history-*`, `.session-*`, `.sidebar-session-*`, `.pinned-*`. Imported by `ChatView.tsx`.

The order is deliberately last-the-largest. By the time we touch `chat.css` we've built confidence in the move pattern via 7 smaller features.

**Per-feature procedure:**

For each feature `<f>`:

1. Create `desktop/src/features/<f>/<f>.css`.
2. Use `grep`/`awk` to find every class rule in `App.css` whose selector prefix maps to this feature (use the prefix clusters from "Current Repo State" as a starting point — the actual mapping needs a manual pass).
3. Cut those rules to `<f>.css`, preserving their order relative to each other. Order across features doesn't need to be preserved.
4. In the feature's root component file (e.g. `desktop/src/features/<f>/<F>View.tsx`), add `import "./<f>.css";` after the existing imports.
5. Reload the dev surface and visit every screen the feature owns. Compare against pre-change screenshots.
6. If something looks off, the most likely culprit is a cross-feature rule that needed to stay in `app-shell.css` or another feature's file. Find it and put it back. Do not work around the issue with `!important` or specificity hacks.

**Cross-feature shared rules:**

Some rules are used across features (e.g. `.tool-progress-*` might appear in chat and elsewhere). If a class is genuinely shared, leave it in `app-shell.css` or hoist a small `desktop/src/styles/shared.css`. Do not duplicate the rule in two feature files.

**Visual verification per feature:**

For each feature, exercise:

- Default state
- Loading state if applicable
- Error/empty state if applicable
- Hover/focus states on interactive elements
- Any dialogs/modals the feature owns

Phase 3 is the longest phase by wall-clock time. Budget multiple sessions.

**Done when:**

- `App.css` contains only `@import` statements + maybe a handful of orphans we couldn't classify.
- Each feature's root component imports its own `.css` file.
- All views render identically.

### Phase 4 — Convert trivial rules to Tailwind utilities (highest risk)

**Scope:** For each per-feature CSS file produced in phase 3, identify rules that pass the "trivial" test (see Design Decisions). For each such rule:

1. Find every TSX file using its class name.
2. Replace the className with the equivalent Tailwind utility string. Keep any non-color/layout classes (e.g. data attributes, animations) on the element.
3. Delete the CSS rule from the feature file.
4. Verify visually.

**Important:** The trivial-rule audit ran against `App.css` returned **347 candidates across the whole codebase**. After phase 3, each feature file will own a subset. Process each file feature-by-feature, with verification in between.

**Tooling considerations:**

- A class might appear many times across TSX files — use `grep -rn "className.*<class-name>" desktop/src/` to find call sites. Some classes are also composed via `cn(...)` helpers — search for the bare string token too.
- Some classes are dynamically composed (template literals, conditional arrays). Inlining Tailwind utilities in those branches is fine but requires care to preserve semantics.
- If a class is used only once, inlining is trivial. If it's used dozens of times with the same surrounding utilities, consider whether the abstraction is genuinely worth keeping (rare — usually still better to inline).
- A class used in 3+ places with no other utilities around it may be worth keeping as a CSS rule **if** removing it would make the markup illegible. Default to inlining; revisit only if a specific call site becomes harder to read.

**Don't replace `cn()` calls with class strings.** Components that already use `cn(...)` to compose conditional classes should keep doing so. The change is purely "this class name represented a layout pattern; that layout pattern is now expressed in utilities at the call site."

**Per-rule procedure (for example, `.diagnostics-remote-command`):**

1. Identify the rule:
   ```css
   .diagnostics-remote-command {
     display: flex;
     align-items: center;
     gap: 8px;
     flex-wrap: wrap;
   }
   ```
2. Tailwind equivalent: `flex items-center gap-2 flex-wrap`.
3. Find call sites: `grep -rn '"diagnostics-remote-command"\|className.*diagnostics-remote-command' desktop/src/`.
4. At each call site, replace `className="diagnostics-remote-command"` (or its presence inside a `cn(...)`) with `className="flex items-center gap-2 flex-wrap"` (preserving any other classes already present).
5. Delete the rule from `runtime.css`.
6. Visually verify the page renders identically.

**Visual verification per batch:**

Inline trivial rules in batches of ~10-20 per feature file at a time. After each batch, exercise the feature in the browser. Catching a regression after 10 changes is much easier than after 100.

**Done when:**

- Each per-feature CSS file contains only "real" CSS (pseudo-elements, animations, complex selectors, etc.).
- Total non-trivial CSS rules in the codebase: approximately 489 (the original audit estimate). The actual number may shift by ±50 as edge cases are reclassified during the work.

### Phase 5 — Guardrail to prevent regression (one-time setup)

**Scope:** Add an automated check that fails CI (or pre-commit, depending on team preference) when someone adds a new CSS rule consisting only of trivial-utility properties.

**Implementation options (pick one):**

1. **Stylelint rule.** Write a small custom stylelint plugin that walks each rule, classifies its declarations against the trivial-set in this plan, and reports rules where every declaration is trivial. Run it in the existing lint script (or add one if none).
2. **Custom node script in CI.** Same logic as the audit script used to produce the "347 trivial rules" number in this plan. Compare against a committed allowlist of grandfathered rules (empty after phase 4). Fail if the script finds anything not in the allowlist.
3. **Pre-commit hook.** Same script, but local to the dev machine. Lower friction but easier to bypass; combine with CI option for belt-and-suspenders.

**Recommendation:** Stylelint plugin if the team is already using stylelint. Custom node script otherwise — it's a ~50-line file and gives a clean CI signal.

**The allowlist mechanism:**

Some rules might legitimately stay as named CSS classes even though they're trivial — for example, a class shared across 20+ components where inlining would create real friction. The allowlist exists for those. **Strongly prefer inlining**; only add to the allowlist with an explanatory comment.

**Done when:**

- Lint or CI check is wired up and runs on every PR.
- The allowlist is empty (or contains only entries with explicit "why this stays a class" comments).
- The README or AGENTS.md mentions the rule briefly so contributors know to expect it.

## Files Touched

- **Created:**
  - `desktop/src/styles/tokens.css`
  - `desktop/src/styles/base.css`
  - `desktop/src/styles/app-shell.css`
  - `desktop/src/features/<each-feature>/<feature>.css`
  - A stylelint config or CI script for the regression guard
  - Possibly `desktop/src/styles/shared.css` if a small set of cross-feature rules emerges
- **Heavily modified:**
  - `desktop/src/App.css` — shrinks to under 400 lines
  - Many TSX files in `desktop/src/features/*/` and `desktop/src/layout/*` — className changes
- **Untouched:**
  - `desktop/src/shared/ui/*` — shadcn primitives already use the right pattern
  - Any Iris Core, Hermes, bridge, transport, or runtime code

## Verification Strategy

This is a refactor with no intended visible change. The verification bar is correspondingly strict.

### Per-phase

1. **TypeScript** must continue to pass: `cd desktop && npx tsc --noEmit`.
2. **Vite dev server** at `http://localhost:1420/` must continue to serve without errors. Watch the browser console for any "failed to load resource" or unresolved-import errors after each import-path change.
3. **Visual diff** on a fixed set of reference views:
   - Home (`/`)
   - New session in default profile
   - At least one existing chat session with messages, attachments, tool progress, and audio (if any sessions have audio).
   - Agents view (`/agents/default`) — Overview, Memory, Skills tabs.
   - Settings view (`/settings`) — Local mode and SSH mode.
   - Onboarding card if present.
   - Diagnostics dialog if present.
   - Session search dialog (⌘G).
   - Command menu (⌘K or equivalent).
   - At least one context menu (right-click on a session in the sidebar).
   - At least one dropdown menu (the agent's "..." menu).

For each view, take a screenshot before and after the phase's changes. Compare side-by-side. Anything that visibly differs needs investigation before moving on.

### Per-feature (phase 3) and per-rule batch (phase 4)

The same visual diff approach, scoped to the feature being moved/converted. Use the dev surface with HMR — there's no need to rebuild the desktop bundle for this work unless you're at the end of the phase and want a final sanity check (in which case follow AGENTS.md packaged-app verification instructions, but only at the end of phase 4, not during it).

### Not in scope for verification

- Packaged desktop app verification is **not required during phases 1-4**. This is a UI-only refactor that doesn't touch desktop chrome, runtime, persistence, or transport. AGENTS.md explicitly allows shadcn-class UI work to verify against the Vite dev surface only. The same rationale applies here.
- A final packaged desktop verification at the end of phase 4 (or just before merging the last PR) is reasonable but not required.

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Token resolution breaks after extracting `:root` | Low | High | Tailwind v4 picks up `@theme` from any imported CSS. Verify with one canonical screen before continuing. |
| CSS rule order change introduces specificity regression | Medium | Medium | Preserve relative rule order when moving. Keep `@import` order matching original `App.css` rule order. Investigate any visual diff before chalking it up to "probably nothing." |
| Cross-feature class accidentally moved into a single feature file | Medium | Medium | The phase-3 verification visits all features after each move. A regression in feature B caused by moving its rule into feature A's file will surface on next view. |
| Tailwind utility doesn't perfectly match the original CSS (e.g. `gap-2` is `0.5rem` but rule used `8px`) | Low | Low | The tokens system uses standard scales — `gap-2` IS `8px` in the project's Tailwind config. Spot-check during phase 4. Use arbitrary-value Tailwind (`gap-[7px]`) only when no standard token matches and the value is intentional. |
| TSX `className` string composition breaks during inlining | Medium | Low | Test every modified file's view. `cn(...)` compositions are forgiving; static strings are easier still. |
| Reviewer/merge conflicts during a long-running refactor | High | Low | Ship phase-by-phase and feature-by-feature. Each PR is small enough to merge cleanly. |
| Visual regression from "trivial" rule that wasn't actually trivial | Medium | Medium | Strict definition of "trivial" in this plan. Default to keeping rules as CSS when uncertain. Visual verification per batch in phase 4. |
| New CSS gets added during the refactor that should have been Tailwind | High during transition | Low | Phase 5's guardrail catches this post-merge. During the refactor itself, reviewers should flag new utility-only classes. |
| The 489-rule remaining-CSS pool turns out to have its own internal cruft | Possible | Low | Out of scope for this plan. A follow-up review pass after phase 4 can identify any further cleanup; track it as separate work. |

## Estimated Effort

Single Claude Code session driving the work end-to-end with the user verifying visually between phases. The whole refactor is mechanical: classification, cut/paste, regex/AST transforms, screenshot diffs. There's no design work and no business-logic risk.

| Phase | Estimate | Notes |
|---|---|---|
| 1 — Extract tokens | 5 min | Cut/paste + one screenshot diff. |
| 2 — Base + app-shell | 10 min | Same shape, slightly more classification. |
| 3 — Per-feature split | 20-30 min | 9 features in parallel-ish: classify by selector prefix, cut/paste per feature file, add imports. Verification batched. |
| 4 — Trivial → utilities | 15-25 min | Script-driven classification of the 347 candidates, batched call-site rewrites, visual check per feature. |
| 5 — Guardrail | 5-10 min | Small stylelint plugin or node script + CI/pre-commit wire-up. |

Total: roughly **under an hour** of wall-clock with an attentive driver, possibly less if visual verification is delegated to a screenshot diff agent. The bottleneck is human-side review, not the edits themselves.

## Out of Scope and Follow-ups

The following are explicitly not part of this plan but might come up as work happens:

- **Light theme variant.** A `[data-theme="light"]` block that overrides the dark-mode token values. The token system enables this; the work is separate.
- **`ThemeProvider` wiring with `next-themes`.** Currently only used by Sonner toast; would need to wrap the app root and add a toggle. Separate work.
- **Further CSS cleanup within the 489 non-trivial rules.** Some of those may have internal cruft worth tidying (e.g. magic numbers that should reference tokens, unused selectors, dead rules). A pass after phase 4 ships could audit.
- **A CSS-modules or scoped-styles migration.** Out of scope. The global-classname convention stays.
- **A design-system documentation page.** Once tokens live in their own file with clear naming, a `/system` route or a static doc page showing every token, its value, and its semantic role would be nice. Not blocking.
- **Per-component CSS within shadcn primitives.** Already in good shape; do not refactor.
- **Storybook or similar visual regression tooling.** Would make this kind of refactor safer in the future. Out of scope here but worth considering as separate infrastructure.

## Definition of Done

The cleanup is complete when:

1. `desktop/src/App.css` is under 400 lines and consists primarily of `@import` statements plus any unmovable orphans.
2. `desktop/src/styles/tokens.css` contains the entire token system, with no other CSS adjacent to it.
3. Each feature directory in `desktop/src/features/` contains at most one `.css` file owned by that feature, imported by its root component.
4. The trivial-rule audit reports zero rules consisting only of utility-equivalent properties (or only rules on the allowlist with documented justifications).
5. Visual diff against pre-refactor screenshots shows no perceptible changes across the verification screen set.
6. The phase-5 lint/CI check is wired up and runs on every PR.
7. AGENTS.md or a similar contributor doc has a short paragraph explaining the convention: "if your new CSS rule is only layout/spacing/typography utilities, write it as Tailwind classes at the call site, not as a named CSS rule."
