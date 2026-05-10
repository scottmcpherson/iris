# Projects Implementation Plan

## Goal

Add Projects as the first-class organizational layer for Iris sessions without turning Hermes profiles into projects. A project is an Iris-owned workspace/context container. Hermes remains the runtime source of truth for agent profiles, sessions, messages, skills, memory, models, commands, and jobs.

Product terminology uses "sessions" for visible work threads. Existing code, endpoint paths, and persistence fields may still use `conversation` or `chat` for compatibility.

Projects should make the sidebar feel more natural:

- Projects appear above Agents.
- Projects and their sessions look and behave exactly like Agents and their sessions.
- A project can be renamed from the sidebar context menu.
- Creating a project uses the same modal style as creating an agent.
- Creating a project captures a name, default agent, and project system prompt.
- The system prompt editor reuses the same editor surface used for skill content.

## Product Model

Projects answer "what am I working on?" Agents answer "who is doing the work?" Hermes profiles map to agents, not projects.

```text
Iris Project
  id
  name
  defaultAgentId
  systemPrompt
  createdAt
  updatedAt
  archivedAt

Iris Project Session Link
  projectId
  conversationId
  agentId
  runtimeId
  runtimeProfile
  externalSessionId
  externalChatId
  createdAt
  updatedAt

Hermes Profile
  runtime agent/personality/tools/memory

Hermes Session
  runtime thread and messages
```

Do not create a Hermes profile for each project. For Hermes execution, Iris should choose the selected or default agent, create/link an Iris Core session, include project metadata and prompt in the send metadata, and let the Hermes adapter run the turn through the agent's runtime profile.

## Current Code Shape

### Desktop Sidebar

The sidebar tree lives in `desktop/src/layout/AppShell.tsx`.

Important existing behavior to mirror:

- Agent section header is `.profile-tree-header` with a `Plus` create button and refresh action.
- Agent rows are `.profile-node`, `.profile-node-row`, and `.profile-node-button`.
- Clicking an agent row expands/collapses its session branch.
- Agent sessions render through `renderConversationRow(...)`.
- Session rows support active state, running state, pin/unpin, right-click rename, and time labels.
- Collapsed agent state is persisted through `storageKeys.collapsedSessionProfiles`.
- Pinned sessions are persisted through `storageKeys.pinnedConversations`.
- Sidebar session search indexes sessions from all profiles.

Projects should reuse the same visual classes or extract a shared tree component so project rows and agent rows stay identical over time.

### Agent Create UI

There are two create-agent modal implementations:

- Sidebar modal in `desktop/src/layout/AppShell.tsx` via `ProfileDialog` and `renderProfileDialog()`.
- Agents page modal in `desktop/src/features/agents/AgentList.tsx`.

For Projects, start with the sidebar modal path because the requirement is sidebar-first. The project create modal should use the same `.profile-action-modal` shell and button classes so it visually matches agent creation.

### Skill Editor

The skill editor lives in `desktop/src/features/skills/SkillsView.tsx` and uses:

- `.skill-editor-shell`
- `.skill-editor-fields`
- `.syntax-strip`
- `.skill-code-editor`
- a line-number `<pre>`
- a `<textarea spellCheck={false}>`

Do not duplicate this markup directly into project creation long term. Extract a reusable editor component first, then use it in both `SkillsView` and the project create/edit modal.

Suggested component:

```text
desktop/src/shared/CodeEditor.tsx
desktop/src/shared/codeEditor.ts
```

Initial props:

```ts
type CodeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  spellCheck?: boolean;
  metadata?: Array<{ label: string; value: string }>;
  className?: string;
};
```

Keep existing CSS class names so `SkillsView` does not visually change.

### Iris Core

Iris Core currently stores only Core-owned coordination data in `iris-core/src/hermes_management_server/core_store.py`. The current schema intentionally drops old duplicate runtime-owned tables such as `agents`, `conversations`, `conversation_runtime_links`, `message_events`, `conversation_messages`, and `automations`.

Projects are safe to store in Core because they are not duplicated Hermes runtime records. They are an Iris-owned overlay and should live in Core SQLite.

Current conversation endpoints in `iris-core/src/hermes_management_server/main.py` are agent-scoped:

- `GET /v1/conversations?agentId=...`
- `POST /v1/conversations`
- `GET /v1/conversations/{conversation_id}`
- `PATCH /v1/conversations/{conversation_id}`
- `GET /v1/conversations/{conversation_id}/messages`
- `POST /v1/conversations/{conversation_id}/messages`

Current desktop Core client lives in `desktop/src/lib/agentuiCore.ts`, with compatibility routing through `desktop/src/lib/irisRuntime.ts`.

## Backend Design

### Schema

Increment `CORE_SCHEMA_VERSION` in `iris-core/src/hermes_management_server/core_store.py`.

Add tables:

```sql
create table if not exists projects (
  id text primary key,
  name text not null,
  slug text not null unique,
  default_agent_id text not null,
  system_prompt text not null,
  created_at integer not null,
  updated_at integer not null,
  archived_at integer,
  metadata_json text not null
);

create table if not exists project_conversations (
  project_id text not null,
  conversation_id text not null,
  agent_id text not null,
  runtime_id text not null,
  runtime_profile text not null,
  external_session_id text,
  external_chat_id text,
  created_at integer not null,
  updated_at integer not null,
  metadata_json text not null,
  primary key (project_id, conversation_id),
  foreign key (project_id) references projects(id) on delete cascade
);

create index if not exists idx_project_conversations_project_updated
  on project_conversations(project_id, updated_at desc);

create index if not exists idx_project_conversations_conversation
  on project_conversations(conversation_id);
```

Do not add tables that copy messages or runtime conversation content.

### Store Methods

Add CoreStore methods:

- `create_project(name, default_agent_id, system_prompt, metadata=None)`
- `list_projects(include_archived=False)`
- `get_project(project_id)`
- `update_project(project_id, name=None, default_agent_id=None, system_prompt=None, metadata=None)`
- `archive_project(project_id)` or `delete_project(project_id)`
- `link_project_conversation(project_id, conversation)`
- `unlink_project_conversation(project_id, conversation_id)`
- `list_project_conversation_links(project_id)`
- `project_for_conversation(conversation_id)`

Prefer soft archive for projects in v1. Hard delete can come later after there is clearer UX for what happens to linked conversations.

### Models

Add Pydantic models in `iris-core/src/hermes_management_server/models.py`:

```py
class ProjectCreateRequest(BaseModel):
    name: str
    defaultAgentId: str
    systemPrompt: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)

class ProjectUpdateRequest(BaseModel):
    name: str | None = None
    defaultAgentId: str | None = None
    systemPrompt: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

class ProjectConversationLinkRequest(BaseModel):
    conversationId: str
```

Response shape should use camelCase to match existing Core API responses.

### Endpoints

Add project endpoints to `iris-core/src/hermes_management_server/main.py`:

- `GET /v1/projects`
- `POST /v1/projects`
- `GET /v1/projects/{project_id}`
- `PATCH /v1/projects/{project_id}`
- `DELETE /v1/projects/{project_id}` or `POST /v1/projects/{project_id}/archive`
- `GET /v1/projects/{project_id}/conversations`
- `POST /v1/projects/{project_id}/conversations`
- `DELETE /v1/projects/{project_id}/conversations/{conversation_id}`

`GET /v1/projects/{project_id}/conversations` should resolve linked Core/Hermes conversations through the runtime adapter. Return the same `AgentUICoreConversation` shape that the desktop already consumes, with project metadata added only under `metadata.project`.

Extend `POST /v1/conversations` to optionally accept `projectId`. When present:

1. Validate the project exists.
2. Use the request agent if provided, otherwise the project's `defaultAgentId`.
3. Create the same draft conversation as today.
4. Link it through `project_conversations`.
5. Include `projectId` in conversation metadata.

Extend `POST /v1/conversations/{conversation_id}/messages` so project context can be sent without changing Hermes itself:

1. Resolve the conversation.
2. Look up linked project by `conversation_id` or `request.metadata.projectId`.
3. Merge project context into runtime metadata:
   - `projectId`
   - `projectName`
   - `projectSystemPrompt`
4. The Hermes adapter sends this metadata through `adapter.send_message(...)`.

Do not mutate Hermes `SOUL.md` for project prompts.

### Runtime Adapter Boundary

No new Hermes runtime adapter method is required for v1 if the project prompt is passed as metadata. The Hermes-side Iris platform adapter must then interpret that metadata and add the project system prompt to the turn.

Expected platform metadata keys:

```json
{
  "projectId": "project_...",
  "projectName": "AgentUI",
  "projectSystemPrompt": "Repo-specific working instructions..."
}
```

If the Hermes-side adapter cannot currently consume these keys, add that as a second implementation phase in `iris-platform/adapter.py`. Keep the first Core/Desktop project storage work independent.

## Desktop Design

### Types And Client

Add project types to `desktop/src/lib/agentuiCore.ts`:

```ts
export type IrisProject = {
  id: string;
  name: string;
  slug: string;
  defaultAgentId: string;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  metadata?: Record<string, unknown>;
};
```

Add client functions:

- `getIrisProjects(runtime)`
- `createIrisProject(payload, runtime)`
- `updateIrisProject(projectId, payload, runtime)`
- `archiveIrisProject(projectId, runtime)`
- `getIrisProjectConversations(projectId, runtime)`
- `linkIrisProjectConversation(projectId, conversationId, runtime)`

Add a desktop hook:

```text
desktop/src/features/projects/useIrisProjects.ts
```

The hook should own:

- project list loading
- selected project id
- project conversations by project id
- collapsed project state
- create/rename/update actions
- refresh project conversations

Use Core as the source of truth for project metadata. Use Hermes/Core conversation endpoints as the source of truth for conversation content.

### Sidebar Layout

In `desktop/src/layout/AppShell.tsx`, render Projects before Agents:

```text
Pinned
Projects
  Project A
    sessions...
  Project B
    sessions...
Sessions
  Unprojected session A
  Unprojected session B
Agents
  Agent A
    sessions...
```

Project tree behavior must match agent tree behavior:

- Same row height, icon treatment, hover, active states, disclosure behavior, session row layout, empty/loading/error states, and right-side timestamps.
- Clicking a project expands/collapses it.
- The project row itself should not become the active session highlight; active highlight remains on selected sessions.
- A project row has a plus/new-session action that starts a new session in that project using the project's default agent.
- Right-clicking the project row opens a context menu with Rename in v1.
- Ellipsis can also expose Rename to match agents.

Sessions created with `No project` should appear below the Projects section and above Agents. This section should use the same session row styling, but it should not be nested in a folder. Use `Sessions` in the visible UI.

Do not fork session row visuals. Either keep using `renderConversationRow(...)` or extract it into a shared sidebar tree helper.

Suggested local storage keys:

```ts
collapsedProjects: "iris.desktop.sidebar.collapsedProjects"
selectedProjectId: "iris.desktop.selectedProjectId"
```

Keep existing `hermes.desktop.sidebar.collapsedSessions` compatibility key for agents unless doing a separate storage migration.

### Project Create Modal

The create modal should visually match agent creation while adding fields:

- Project name
- Default agent select
- System prompt editor

Default values:

- Name: `new-project`, `new-project-2`, etc.
- Default agent: currently selected agent/profile if resolvable, otherwise first agent.
- System prompt: empty string.

The default agent field should be a `<select>` of current Iris agents. Store `defaultAgentId`, not runtime profile name. Render labels as profile/display names.

The system prompt editor should use the extracted skill editor component. For create modal sizing, use a shorter editor height than the full Skills view but preserve line numbers and monospace editing.

### Project Rename

Right-click project row -> Rename.

Use the same modal shell as project create, but for v1 only show the project name field. Do not expose default agent/system prompt in a rename-only context menu action. Later, a project detail/settings screen can edit all project settings.

### Session Flow

Modify session state so a session can be scoped by project as well as profile:

Current dominant key:

```text
conversationsByProfile[profile]
```

Add project-scoped state rather than replacing agent-scoped state:

```text
conversationsByProject[projectId]
selectedProjectId
unprojectedConversations
```

New session creation must allow both project and agent selection. The UI should support choosing a project in the same way the composer already supports choosing an agent/profile, with an explicit `No project` option.

Suggested model:

```text
New session target
  projectId: string | null
  profileName: string
```

When `projectId` is `null`, the session is an unprojected agent session:

1. Use the selected agent/profile.
2. Do not pass `projectId` to `createAgentUICoreConversation(...)`.
3. Do not send project metadata with `sendAgentUICoreMessage(...)`.
4. Render the session in the flat `Sessions` section below Projects, not inside a project folder.
5. Continue to allow the same session to appear under the selected Agent branch if the agent session tree is expanded.

When starting a new project session:

1. Select active view `chat`.
2. Select the project.
3. Select the project's default agent/profile.
4. Call `startNewConversation({ projectId, profileName })`.
5. When first sending, `createAgentUICoreConversation(...)` includes `projectId`.
6. `sendAgentUICoreMessage(...)` includes `metadata.projectId` for existing linked conversations.

Do not break existing agent-only sessions. Agent tree remains a valid way to start and browse sessions outside a project, but the top-level flat `Sessions` section is the primary home for unprojected sessions in the sidebar.

### Session Search And Pinned Sessions

Update sidebar search to include project sessions.

Search result labels should distinguish source:

```text
Session title
Project name / Agent name
```

Pinned sessions need a stable key that can distinguish project and agent contexts:

```ts
projectConversationPinKey(projectId, conversationId)
agentConversationPinKey(profileName, conversationId)
```

Do not silently reuse the existing `profile:conversationId` key for project pins because the same runtime conversation may appear under an agent and a project.

## System Prompt Semantics

Project system prompt is not a profile prompt. It should be applied only when chatting within that project.

V1 behavior:

- The prompt is stored in Iris Core.
- It is passed on each project-scoped message as metadata.
- The Hermes-side Iris platform adapter injects it into the runtime turn.
- Existing Hermes sessions should not require rewriting.

Important open implementation decision:

If Hermes cannot accept per-turn project system instructions cleanly through the Iris platform adapter, implement the UI/Core/project mapping first and temporarily include the system prompt as a hidden preface in message text from the adapter layer, not from the desktop UI. Desktop should never show or concatenate the project prompt into the user's visible message.

## Files To Change

Backend:

- `iris-core/src/hermes_management_server/core_store.py`
- `iris-core/src/hermes_management_server/models.py`
- `iris-core/src/hermes_management_server/main.py`
- `iris-core/tests/test_core_store.py`
- `iris-core/tests/test_api.py`

Desktop:

- `desktop/src/lib/agentuiCore.ts`
- `desktop/src/lib/irisRuntime.ts`
- `desktop/src/app/types.ts`
- `desktop/src/app/storage.ts`
- `desktop/src/App.tsx`
- `desktop/src/layout/AppShell.tsx`
- `desktop/src/layout/__tests__/AppShell.test.ts`
- `desktop/src/features/chat/useIrisChat.ts`
- `desktop/src/features/chat/__tests__/useIrisChat.test.ts`
- `desktop/src/features/skills/SkillsView.tsx`
- `desktop/src/shared/CodeEditor.tsx`
- `desktop/src/App.css`

Potential Hermes-side platform phase:

- `iris-platform/adapter.py`

## Implementation Sequence

### Phase 1: Extract Shared Editor

1. Extract the skill code editor markup from `SkillsView` into `desktop/src/shared/CodeEditor.tsx`.
2. Keep class names compatible with existing CSS.
3. Update `SkillsView` to use `CodeEditor`.
4. Add or update a small render test if existing test structure supports it.

Verification:

- `npm --workspace desktop run test`
- Skills view still shows line numbers, metadata strip, and editable content.

### Phase 2: Core Project Storage And API

1. Add project tables and migration.
2. Add CoreStore project CRUD and linking methods.
3. Add Pydantic request models.
4. Add project endpoints.
5. Extend conversation creation to accept `projectId`.
6. Add tests for CRUD, rename, archive/delete, and conversation linking.

Verification:

- `cd iris-core && uv run pytest`
- Confirm `CoreStore.tables()` includes project tables but still does not include dropped duplicate runtime-owned transcript tables.

### Phase 3: Desktop Project Client And Hook

1. Add project types and API client functions.
2. Add `useIrisProjects`.
3. Load projects at app startup.
4. Add notifications for project create/update failures.
5. Keep agent-only session behavior unchanged.

Verification:

- `npm --workspace desktop run test`
- Existing session tests pass unchanged.

### Phase 4: Sidebar Projects Tree

1. Add Projects section above Agents.
2. Mirror the agent tree behavior and styling.
3. Add create project button.
4. Add project right-click menu with Rename.
5. Add a flat unprojected `Sessions` section below Projects and above Agents.
6. Add project session loading, empty, loading, and error states.
7. Update search and pinned behavior for project and unprojected sessions.

Verification:

- Sidebar project rows visually match agent rows.
- Project sessions visually match agent sessions.
- Unprojected sessions render as flat session rows below Projects and above Agents.
- Agent rows still expand/collapse exactly as before.
- Session active state remains on sessions, not project/agent parent rows.

### Phase 5: Project Session Routing

1. Add nullable `projectId` to session start/send flow.
2. Add a project selector to new session creation with an explicit `No project` option.
3. On project session creation, use project default agent unless the user selected another agent.
4. Link created Core session to project only when `projectId` is present.
5. Include project metadata on sends only when `projectId` is present.
6. Preserve existing non-project agent chat flows.

Verification:

- New session under a project appears under that project.
- New session with `No project` appears in the flat `Sessions` section.
- Same session can still resolve messages through the existing Core/Hermes detail endpoint.
- Non-project agent sessions still appear under Agents.

### Phase 6: Project Prompt Runtime Injection

1. Confirm whether `iris-platform/adapter.py` can inject metadata-provided project prompts.
2. If not, add adapter support for `projectSystemPrompt`.
3. Keep desktop/Core payload shape stable.
4. Add a smoke test or logged verification showing the prompt reaches the adapter.

Verification:

- A project-specific instruction affects project sessions only.
- The selected Hermes profile's `SOUL.md` is not modified.
- Agent-only sessions do not receive project prompt metadata.

## Tests To Add

Backend:

- Project CRUD in `iris-core/tests/test_core_store.py`.
- Project endpoints in `iris-core/tests/test_api.py`.
- Session creation with `projectId` links the session.
- Project session listing resolves linked runtime sessions.
- Project rename does not alter linked Hermes conversation records.

Desktop:

- `AppShell` renders Projects above Agents.
- `AppShell` renders flat unprojected Sessions below Projects and above Agents.
- Project row click toggles collapse.
- Right-click project opens Rename.
- Create project modal includes name, default agent, and system prompt editor.
- Starting a project session uses the default agent.
- Existing agent session tree behavior is unchanged.

Session:

- `createAgentUICoreConversation` receives `projectId` for project sessions.
- `createAgentUICoreConversation` omits `projectId` when `No project` is selected.
- `sendAgentUICoreMessage` sends `metadata.projectId` on linked project conversations.
- `sendAgentUICoreMessage` omits project metadata for unprojected sessions.
- Switching between project and agent views does not leak stale selected conversation ids.

## Final Verification

Because this is a visible UI feature, final implementation verification must follow `AGENTS.md`:

1. Quick iteration may use Vite/browser checks.
2. Before final verification, run:

```bash
npm run build:mac:app
```

3. Launch the newly built app bundle.
4. Test with Computer Use against `com.nousresearch.hermes-agent.desktop`.
5. Do not rely on the raw `npm run tauri dev` binary for final Computer Use verification.

Manual checklist:

- Projects section is above Agents.
- Flat unprojected Sessions section is below Projects and above Agents.
- Project and Agent rows are visually identical.
- Project sessions and Agent sessions are visually identical.
- Unprojected session rows match session styling but are not nested in a folder.
- Project right-click Rename works.
- Project create modal matches agent modal style.
- New session creation can choose a project, an agent, and `No project`.
- Default agent selection works.
- System prompt editor matches skill editor behavior.
- Project session sends through the default agent.
- Project system prompt applies only in project sessions.
- Refresh preserves project mappings and does not duplicate sessions.

## Non-Goals For V1

- No project-to-Hermes-profile mapping.
- No project-specific Hermes workspace creation.
- No project files panel.
- No project apps/install system.
- No channels/subspaces.
- No multi-user collaboration.
- No transcript/message duplication in Core.
- No editing Hermes `SOUL.md` from project settings.

## Risks

- The sidebar can become too dense if Projects and Agents both expand many conversation branches. Consider default-collapsing Agents once Projects exist.
- Project conversation links must survive app restart. Do not keep the mapping only in desktop state.
- The same runtime conversation appearing under both a project and an agent can confuse pin/search behavior if keys are not scoped.
- System prompt injection must happen below the desktop UI so hidden prompt text does not appear in visible chat history.
- Existing dirty migration assumptions around Core source-of-truth cleanup should be preserved: project metadata is Core-owned, runtime transcripts are not.
