import { describe, expect, it } from "vitest";
import {
  conversationProjectId,
  isProjectConversation,
  mergeProjectConversationsForSidebar,
} from "../projectConversations";
import type { HermesConversation } from "../../types/hermes";

function conversation(overrides: Partial<HermesConversation> = {}): HermesConversation {
  return {
    id: "conv_1",
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

describe("project conversation classification", () => {
  it("treats local project metadata as projected before project lists refresh", () => {
    const item = conversation({ metadata: { projectId: "project_1" } });

    expect(conversationProjectId(item)).toBe("project_1");
    expect(isProjectConversation(item, new Set())).toBe(true);
  });

  it("treats project-list membership as projected even without metadata", () => {
    const item = conversation();

    expect(isProjectConversation(item, new Set(["conv_1"]))).toBe(true);
  });

  it("adds local project chats to the project sidebar before project lists refresh", () => {
    const activeProjectChat = conversation({
      id: "optimistic-1",
      title: "Streaming project chat",
      lastActiveAt: 10,
      metadata: { projectId: "project_1" },
    });

    const merged = mergeProjectConversationsForSidebar(
      ["project_1"],
      {
        project_1: [
          conversation({ id: "conv_old", chatId: "old-chat", title: "Older chat", lastActiveAt: 1 }),
        ],
      },
      [activeProjectChat],
    );

    expect(merged.project_1.map((item) => item.id)).toEqual(["optimistic-1", "conv_old"]);
  });

  it("uses the local project chat row when it matches an endpoint row", () => {
    const endpointChat = conversation({
      id: "conv_1",
      title: "Endpoint title",
      metadata: {},
    });
    const localChat = conversation({
      id: "conv_1",
      title: "Local streaming title",
      metadata: { projectId: "project_1" },
    });

    const merged = mergeProjectConversationsForSidebar(
      ["project_1"],
      { project_1: [endpointChat] },
      [localChat],
    );

    expect(merged.project_1).toEqual([localChat]);
  });
});
