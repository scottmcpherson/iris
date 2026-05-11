import { describe, expect, it } from "vitest";
import {
  sessionProjectId,
  isProjectSession,
  mergeProjectSessionsForSidebar,
  mergeProjectSessionReadStatesForSidebar,
  projectSessionMembership,
} from "../projectSessions";
import type { HermesSession } from "../../types/hermes";

function session(overrides: Partial<HermesSession> = {}): HermesSession {
  return {
    id: "session_1",
    source: "agentui-core",
    model: "",
    title: "Project chat",
    preview: "",
    chatId: "core-chat-1",
    origin: {},
    startedAt: 1,
    endedAt: null,
    lastActiveAt: 1,
    messageCount: 1,
    ...overrides,
  };
}

describe("project session classification", () => {
  it("treats local project metadata as projected before project lists refresh", () => {
    const item = session({ metadata: { projectId: "project_1" } });

    expect(sessionProjectId(item)).toBe("project_1");
    expect(isProjectSession(item, new Set())).toBe(true);
  });

  it("treats project-list membership as projected even without metadata", () => {
    const item = session();

    expect(isProjectSession(item, new Set(["session_1"]))).toBe(true);
  });

  it("adds local project chats to the project sidebar before project lists refresh", () => {
    const activeProjectChat = session({
      id: "optimistic-1",
      title: "Streaming project chat",
      lastActiveAt: 10,
      metadata: { projectId: "project_1" },
    });

    const merged = mergeProjectSessionsForSidebar(
      ["project_1"],
      {
        project_1: [
          session({ id: "session_old", chatId: "old-chat", title: "Older chat", lastActiveAt: 1 }),
        ],
      },
      [activeProjectChat],
    );

    expect(merged.project_1.map((item) => item.id)).toEqual(["optimistic-1", "session_old"]);
  });

  it("uses the local project chat row when it matches an endpoint row", () => {
    const endpointChat = session({
      id: "session_1",
      title: "Endpoint title",
      metadata: {},
    });
    const localChat = session({
      id: "session_1",
      title: "Local streaming title",
      metadata: { projectId: "project_1" },
    });

    const merged = mergeProjectSessionsForSidebar(
      ["project_1"],
      { project_1: [endpointChat] },
      [localChat],
    );

    expect(merged.project_1).toEqual([localChat]);
  });

  it("updates the normal project row in place when the runtime session id arrives later", () => {
    const endpointChat = session({
      id: "session_1",
      title: "Endpoint title",
      origin: { externalSessionId: "hermes-session-1" },
      metadata: { projectId: "project_1" },
    });
    const localChat = session({
      id: "session_1",
      title: "Local streaming title",
      metadata: { projectId: "project_1" },
    });

    const merged = mergeProjectSessionsForSidebar(
      ["project_1"],
      { project_1: [endpointChat] },
      [localChat],
    );

    expect(merged.project_1).toHaveLength(1);
    expect(merged.project_1[0]?.id).toBe("session_1");
    expect(merged.project_1[0]?.origin?.externalSessionId).toBe("hermes-session-1");
  });

  it("renders the runtime-generated title once both lanes refresh after a session.updated event", () => {
    const projectChat = session({
      id: "session_1",
      title: "Moon story request",
      chatId: "core-chat-1",
      metadata: { projectId: "project_1" },
      lastActiveAt: 20,
    });
    const localChat = session({
      id: "session_1",
      title: "Moon story request",
      chatId: "core-chat-1",
      metadata: { projectId: "project_1" },
      lastActiveAt: 20,
    });

    const merged = mergeProjectSessionsForSidebar(
      ["project_1"],
      { project_1: [projectChat] },
      [localChat],
      { preserveProjectSessionIds: new Set(["session_1"]) },
    );

    expect(merged.project_1).toHaveLength(1);
    expect(merged.project_1[0]?.title).toBe("Moon story request");
    expect(merged.project_1[0]?.id).toBe("session_1");
  });

  it("updates a project row from a refreshed runtime row matched by chat id", () => {
    const staleProjectRow = session({
      id: "session_draft",
      title: "use some skills as a test",
      chatId: "core-chat-1",
      metadata: { projectId: "project_1" },
      lastActiveAt: 10,
    });
    const refreshedRuntimeRow = session({
      id: "session_real",
      title: "Skills Test Results",
      chatId: "core-chat-1",
      metadata: { source: "sqlite" },
      lastActiveAt: 20,
    });

    const merged = mergeProjectSessionsForSidebar(
      ["project_1"],
      { project_1: [staleProjectRow] },
      [refreshedRuntimeRow],
    );

    expect(merged.project_1).toEqual([
      {
        ...refreshedRuntimeRow,
        metadata: { source: "sqlite", projectId: "project_1" },
      },
    ]);
  });

  it("keeps the active project row id while borrowing the refreshed runtime title", () => {
    const activeProjectRow = session({
      id: "session_draft",
      title: "use some skills as a test",
      chatId: "core-chat-1",
      metadata: { projectId: "project_1" },
      lastActiveAt: 10,
    });
    const refreshedRuntimeRow = session({
      id: "session_real",
      title: "Skills Test Results",
      chatId: "core-chat-1",
      metadata: { source: "iris" },
      lastActiveAt: 20,
    });

    const merged = mergeProjectSessionsForSidebar(
      ["project_1"],
      { project_1: [activeProjectRow] },
      [refreshedRuntimeRow],
      { preserveProjectSessionIds: new Set(["session_draft"]) },
    );

    expect(merged.project_1[0]).toMatchObject({
      id: "session_draft",
      title: "Skills Test Results",
      chatId: "core-chat-1",
      metadata: { source: "iris", projectId: "project_1" },
    });
  });

  it("keeps the active project row id when the refreshed runtime row already has project metadata", () => {
    const activeProjectRow = session({
      id: "session_draft",
      title: "use some skills as a test",
      chatId: "core-chat-1",
      metadata: { projectId: "project_1" },
      lastActiveAt: 10,
    });
    const refreshedRuntimeRow = session({
      id: "session_real",
      title: "Skills Test Results",
      chatId: "core-chat-1",
      metadata: { source: "iris", projectId: "project_1" },
      lastActiveAt: 20,
    });

    const merged = mergeProjectSessionsForSidebar(
      ["project_1"],
      { project_1: [activeProjectRow] },
      [refreshedRuntimeRow],
      { preserveProjectSessionIds: new Set(["session_draft"]) },
    );

    expect(merged.project_1).toHaveLength(1);
    expect(merged.project_1[0]).toMatchObject({
      id: "session_draft",
      title: "Skills Test Results",
      chatId: "core-chat-1",
      metadata: { source: "iris", projectId: "project_1" },
    });
  });

  it("treats refreshed runtime rows as projected when their chat id is claimed by a project", () => {
    const projectRow = session({
      id: "session_draft",
      chatId: "core-chat-1",
      metadata: { projectId: "project_1" },
    });
    const refreshedRuntimeRow = session({
      id: "session_real",
      chatId: "core-chat-1",
      metadata: { source: "sqlite" },
    });
    const membership = projectSessionMembership({ project_1: [projectRow] });

    expect(isProjectSession(refreshedRuntimeRow, membership.ids, membership.chatIds)).toBe(true);
  });

  it("carries a read project draft state onto the matching refreshed runtime row", () => {
    const projectRow = session({
      id: "session_draft",
      chatId: "core-chat-1",
      metadata: { projectId: "project_1" },
      readState: {
        sessionId: "session_draft",
        state: "read",
        createdAt: 10,
        updatedAt: 20,
        metadata: { eventCursor: 81, reason: "active-delivery" },
      },
    });
    const refreshedRuntimeRow = session({
      id: "session_real",
      chatId: "core-chat-1",
      metadata: { source: "iris" },
      readState: {
        sessionId: "session_real",
        state: "unread",
        createdAt: 11,
        updatedAt: 21,
        metadata: { eventCursor: 81, reason: "background-delivery" },
      },
    });

    const merged = mergeProjectSessionsForSidebar(
      ["project_1"],
      { project_1: [projectRow] },
      [refreshedRuntimeRow],
    );
    const readStates = mergeProjectSessionReadStatesForSidebar(
      { session_real: "unread" },
      merged,
    );

    expect(merged.project_1[0].readState).toEqual({
      sessionId: "session_real",
      state: "read",
      createdAt: 10,
      updatedAt: 20,
      metadata: { eventCursor: 81, reason: "active-delivery" },
    });
    expect(readStates.session_real).toBe("read");
  });

  it("keeps a newer unread runtime state when it happened after the read project draft", () => {
    const projectRow = session({
      id: "session_draft",
      chatId: "core-chat-1",
      metadata: { projectId: "project_1" },
      readState: {
        sessionId: "session_draft",
        state: "read",
        createdAt: 10,
        updatedAt: 20,
        metadata: { eventCursor: 81, reason: "active-delivery" },
      },
    });
    const refreshedRuntimeRow = session({
      id: "session_real",
      chatId: "core-chat-1",
      metadata: { source: "iris" },
      readState: {
        sessionId: "session_real",
        state: "unread",
        createdAt: 11,
        updatedAt: 25,
        metadata: { eventCursor: 82, reason: "background-delivery" },
      },
    });

    const merged = mergeProjectSessionsForSidebar(
      ["project_1"],
      { project_1: [projectRow] },
      [refreshedRuntimeRow],
    );

    expect(merged.project_1[0].readState?.state).toBe("unread");
    expect(merged.project_1[0].readState?.sessionId).toBe("session_real");
  });

  it("does not let default read states overwrite live unread state", () => {
    const merged = {
      project_1: [
        session({
          id: "session_real",
          readState: {
            sessionId: "session_real",
            state: "read",
            createdAt: null,
            updatedAt: null,
            metadata: {},
          },
        }),
      ],
    };

    expect(mergeProjectSessionReadStatesForSidebar({ session_real: "unread" }, merged)).toEqual({
      session_real: "unread",
    });
  });
});
