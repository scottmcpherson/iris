import { describe, expect, it } from "vitest";
import {
  activeRequestCompletedByHistory,
  appendOptimisticSend,
  formatPromptWithAttachments,
  mergeCompletedDelivery,
  mergeMessageLists,
  mergeErrorDelivery,
  mergeStreamDelivery,
  modelSwitchSelectionForSend,
  moveSlashCommandIndex,
  parseCoreEvent,
  replaceOptimisticSend,
  sessionTitleFromPrompt,
  slashCommandInsertion,
  slashTokenAtCursor,
  toChatMessages,
  type DeliveryMessage,
  type CoreChatMessage,
} from "../index";

function delivery(overrides: Partial<DeliveryMessage> = {}): DeliveryMessage {
  return {
    cursor: 1,
    id: "event_1",
    source: "iris-core-events",
    platform: "iris",
    profile: "default",
    chatId: "session_1",
    content: "Hello",
    metadata: { clientRequestId: "request_1" },
    createdAt: 1,
    acknowledgedAt: null,
    ...overrides,
  };
}

describe("chat core", () => {
  it("parses valid core events and ignores invalid data", () => {
    expect(parseCoreEvent("{")).toBeNull();
    expect(parseCoreEvent(JSON.stringify({ cursor: 1, type: "message.assistant.completed" }))).toMatchObject({
      cursor: 1,
      type: "message.assistant.completed",
    });
  });

  it("replaces optimistic user ids after Core accepts a send", () => {
    const optimistic = appendOptimisticSend([], "Hi", "request_1");
    const replaced = replaceOptimisticSend(optimistic.messages, { messageId: "message_1" }, "request_1");
    expect(replaced[0]).toMatchObject({ id: "message_1", role: "user", clientRequestId: "request_1" });
  });

  it("merges stream chunks into the optimistic assistant message", () => {
    const optimistic = appendOptimisticSend([], "Hi", "request_1");
    const next = mergeStreamDelivery(optimistic.messages, delivery({ content: "Hel" }), "stream_1", false);
    const completed = mergeStreamDelivery(next, delivery({ content: "lo" }), "stream_1", true);
    expect(completed[1]).toMatchObject({
      role: "assistant",
      content: "Hello",
      streaming: false,
      clientRequestId: "request_1",
    });
  });

  it("merges live tool metadata into streamed assistant messages", () => {
    const optimistic = appendOptimisticSend([], "Read the page", "request_1");
    const withTool = mergeStreamDelivery(
      optimistic.messages,
      delivery({
        id: "event_tool",
        content: "",
        metadata: {
          clientRequestId: "request_1",
          toolCalls: [
            {
              id: "call_1",
              function: {
                name: "browser",
                arguments: JSON.stringify({ url: "https://example.com" }),
              },
            },
          ],
        },
      }),
      "stream_1",
      false,
    );

    expect(withTool[1]).toMatchObject({
      content: "",
      streaming: true,
      streamEvents: [
        {
          callId: "call_1",
          toolName: "browser",
          status: "running",
        },
      ],
    });

    const completed = mergeStreamDelivery(
      withTool,
      delivery({ id: "event_done", content: "Done" }),
      "stream_1",
      true,
    );

    expect(completed[1]).toMatchObject({
      content: "Done",
      streaming: false,
      streamEvents: [
        {
          callId: "call_1",
          status: "completed",
        },
      ],
    });
  });

  it("finalizes completed deliveries", () => {
    const optimistic = appendOptimisticSend([], "Hi", "request_1");
    const completed = mergeCompletedDelivery(optimistic.messages, delivery({ id: "event_done", content: "Done" }));
    expect(completed[1]).toMatchObject({ content: "Done", streaming: false });
  });

  it("ignores replayed completed deliveries that are already in the transcript", () => {
    const existing = [
      { id: "request_1", role: "user" as const, content: "Hi", clientRequestId: "request_1" },
      { id: "event_done", role: "assistant" as const, content: "Done", streaming: false },
    ];

    expect(mergeCompletedDelivery(existing, delivery({ id: "event_done", content: "Done" }))).toEqual(existing);
  });

  it("replaces active stream content for final replace deliveries", () => {
    const optimistic = appendOptimisticSend([], "Hi", "request_1");
    const next = mergeStreamDelivery(
      optimistic.messages,
      delivery({ content: "partial" }),
      "stream_1",
      false,
    );
    const completed = mergeCompletedDelivery(
      next,
      delivery({
        id: "stream_1:edit:final",
        content: "final answer",
        metadata: { clientRequestId: "request_1", chunkOperation: "replace" },
      }),
    );

    expect(completed[1]).toMatchObject({ content: "final answer", streaming: false });
  });

  it("normalizes historical tool calls onto assistant messages", () => {
    const messages: CoreChatMessage[] = [
      {
        id: "user_1",
        role: "user",
        content: "Run pwd",
        metadata: { clientRequestId: "request_1" },
      },
      {
        id: "assistant_call",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            function: {
              name: "terminal",
              arguments: JSON.stringify({ command: "pwd" }),
            },
          },
        ],
      },
      {
        id: "tool_1",
        role: "tool",
        content: JSON.stringify({ command: "pwd", output: "/tmp", exit_code: 0 }),
        toolName: "terminal",
        toolCallId: "call_1",
      },
      {
        id: "assistant_1",
        role: "assistant",
        content: "You are in /tmp.",
      },
    ];

    const normalized = toChatMessages(messages);

    expect(normalized).toHaveLength(2);
    expect(normalized[1]).toMatchObject({
      id: "assistant_1",
      role: "assistant",
      content: "You are in /tmp.",
      clientRequestId: "request_1",
      streamEvents: [
        {
          callId: "call_1",
          toolName: "terminal",
          status: "completed",
          output: JSON.stringify({ command: "pwd", output: "/tmp", exit_code: 0 }),
        },
      ],
    });
  });

  it("recognizes when canonical history has completed the active request", () => {
    const messages: CoreChatMessage[] = [
      {
        id: "message_1",
        role: "user",
        content: "Hi",
        metadata: { clientMessageId: "request_1" },
      },
      {
        id: "assistant_1",
        role: "assistant",
        content: "Done",
        status: "completed",
        metadata: { replyTo: "request_1", streaming: false, finalize: true },
      },
    ];

    expect(activeRequestCompletedByHistory(messages, "request_1")).toBe(true);
  });

  it("does not reconcile an active request from streaming-only history", () => {
    const messages: CoreChatMessage[] = [
      {
        id: "request_1",
        role: "user",
        content: "Hi",
        metadata: { clientRequestId: "request_1" },
      },
      {
        id: "assistant_1",
        role: "assistant",
        content: "Partial",
        status: "streaming",
        metadata: { replyTo: "request_1", streaming: true, finalize: false },
      },
    ];

    expect(activeRequestCompletedByHistory(messages, "request_1")).toBe(false);
  });

  it("merges history and local messages by client request id", () => {
    const local = appendOptimisticSend([], "Hi", "request_1").messages;
    const history = [
      { id: "message_1", role: "user" as const, content: "Hi", clientRequestId: "request_1" },
    ];

    expect(mergeMessageLists(local, history).map((message) => message.id)).toEqual([
      "message_1",
      "request_1-assistant",
    ]);
  });

  it("appends error deliveries to active assistant messages", () => {
    const optimistic = appendOptimisticSend([], "Hi", "request_1");
    const failed = mergeErrorDelivery(optimistic.messages, delivery({ content: "", metadata: { clientRequestId: "request_1", error: "No route" } }));
    expect(failed[1].content).toBe("Assistant stream failed: No route");
    expect(failed[1].streaming).toBe(false);
  });

  it("builds new-session titles from prompts", () => {
    expect(sessionTitleFromPrompt("  Build the mobile new chat flow\nwith details")).toBe("Build the mobile new chat flow");
    expect(sessionTitleFromPrompt("")).toBe("New session");
  });

  it("adds attachment summaries to send prompts and optimistic messages", () => {
    const attachment = {
      id: "att_1",
      name: "notes.txt",
      kind: "code" as const,
      mimeType: "text/plain",
      size: 2048,
    };

    expect(formatPromptWithAttachments("Review this", [attachment])).toContain("Attached files:\n1. notes.txt");
    expect(appendOptimisticSend([], "", "request_1", [attachment]).messages[0].attachments).toEqual([attachment]);
  });

  it("handles slash command insertion", () => {
    const token = slashTokenAtCursor("/me", 3);
    expect(token).toEqual({ from: 0, to: 3, query: "me" });
    expect(slashCommandInsertion("/me", token!, {
      id: "memory",
      name: "memory",
      text: "/memory",
      label: "Memory",
      description: "",
      category: "Commands",
      source: "hermes",
      aliases: [],
      argsHint: "",
      subcommands: [],
      requiresArgument: true,
    })).toEqual({ value: "/memory ", cursor: 8 });
    expect(moveSlashCommandIndex(0, -1, 3)).toBe(2);
  });

  it("detects model switches", () => {
    expect(modelSwitchSelectionForSend(
      { provider: "openrouter", model: "gpt-5.5" },
      { provider: "openrouter", model: "gpt-5.4" },
    )).toEqual({ provider: "openrouter", model: "gpt-5.5" });
    expect(modelSwitchSelectionForSend(
      { provider: "openrouter", model: "gpt-5.5" },
      { provider: "openrouter", model: "gpt-5.5" },
    )).toBeNull();
  });
});
