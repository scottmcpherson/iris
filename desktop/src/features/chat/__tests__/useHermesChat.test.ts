import { describe, expect, it } from "vitest";
import type { Message } from "../../../app/types";
import type { HermesInboxMessage } from "../../../types/hermes";
import {
  activeConversationReplacements,
  activeRequestCompletedByHistory,
  coalescePostStreamAttachments,
  deliveryCompletesActiveStream,
  isHiddenDeliveryMetadata,
  isTransientConversationLoadError,
  mergeCompletedDelivery,
  mergeConversationChatIdMap,
  mergeMessageLists,
  mergeUploadedAttachment,
  mergeStreamDelivery,
  preserveActiveConversationTitles,
  shouldApplyConversationDetailSelection,
  shouldPreserveLocalMessagesOnEmptyHistory,
  shouldPreserveProfileConversationSelection,
  shouldRetryUnmappedDelivery,
  shouldSendModelSwitch,
  shouldSkipConversationDetailLoad,
  stripModelSwitchNote,
  toAppMessages,
} from "../useHermesChat";

function inboxMessage(
  overrides: Partial<HermesInboxMessage> & { id: string; content: string },
): HermesInboxMessage {
  return {
    cursor: 1,
    source: "hermes-gateway-stream",
    platform: "agentui",
    profile: "default",
    chatId: "desktop-1",
    metadata: {},
    createdAt: 1,
    acknowledgedAt: null,
    ...overrides,
  };
}

describe("Hermes chat inbox merging", () => {
  it("keeps the chat-id map stable when a conversation refresh has no new mappings", () => {
    const current = { "conversation-1": "chat-1" };

    expect(
      mergeConversationChatIdMap(current, [
        { id: "conversation-1", chatId: "chat-1" },
        { id: "conversation-2", chatId: "" },
      ]),
    ).toBe(current);
  });

  it("caps retries for unmapped inbox deliveries so stale rows cannot refresh forever", () => {
    expect(shouldRetryUnmappedDelivery(0)).toBe(true);
    expect(shouldRetryUnmappedDelivery(1)).toBe(true);
    expect(shouldRetryUnmappedDelivery(2)).toBe(false);
  });

  it("treats model-switch command replies as hidden even when Hermes drops hidden metadata", () => {
    expect(isHiddenDeliveryMetadata({ replyTo: "client-message-1-model" })).toBe(true);
    expect(isHiddenDeliveryMetadata({ kind: "model-switch" })).toBe(true);
    expect(isHiddenDeliveryMetadata({ replyTo: "client-message-1" })).toBe(false);
  });

  it("omits hidden model-switch replies when loading conversation history", () => {
    const messages = toAppMessages([
      {
        id: "model-reply",
        sessionId: "session-1",
        role: "assistant",
        content: "Model switched to `gpt-5.4-mini`",
        toolName: "",
        timestamp: 1,
        metadata: { replyTo: "client-message-1-model" },
      },
      {
        id: "assistant-1",
        sessionId: "session-1",
        role: "assistant",
        content: "Real answer",
        toolName: "",
        timestamp: 2,
        metadata: {},
      },
    ]);

    expect(messages).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        content: "Real answer",
      },
    ]);
  });

  it("replaces local duplicate messages with persisted history rows when merging conversation aliases", () => {
    const attachment = {
      id: "local-attachment-1",
      kind: "image" as const,
      mimeType: "image/png",
      name: "statue.png",
      localPath: "/Users/scott/Desktop/statue.png",
      size: -1,
      lastModified: 1,
    };
    const localUserId = "73b86a84-e212-4068-9fe1-16c7b3455daf";
    const localAssistantId = "7179e940-202c-4329-a3c0-15bb34e3f963";

    const merged = mergeMessageLists(
      [
        {
          id: localUserId,
          role: "user",
          content: "reply with exactly: test ok",
          attachments: [attachment],
        },
        {
          id: localAssistantId,
          role: "assistant",
          content: "test ok",
          streaming: false,
        },
      ],
      [
        {
          id: "1090",
          role: "user",
          content: "reply with exactly: test ok",
          attachments: [attachment],
        },
        {
          id: "1091",
          role: "assistant",
          content: "test ok",
          streaming: false,
        },
        {
          id: "current-user",
          role: "user",
          content: "what is this?",
        },
      ],
    );

    expect(merged.map((message) => message.id)).toEqual(["1090", "1091", "current-user"]);
  });

  it("prefers uploaded Core previews over local draft previews after attachment upload", () => {
    const merged = mergeUploadedAttachment(
      {
        id: "draft-1",
        kind: "image",
        mimeType: "image/png",
        name: "photo.png",
        previewUrl: "asset://localhost/%2FUsers%2Fscott%2FDesktop%2Fphoto.png",
        localPath: "/Users/scott/Desktop/photo.png",
        size: 42,
      },
      {
        id: "att_123",
        kind: "image",
        mimeType: "image/png",
        name: "photo.png",
        previewUrl: "http://127.0.0.1:8765/v1/attachments/att_123/preview",
        downloadUrl: "http://127.0.0.1:8765/v1/attachments/att_123/content",
        size: 42,
      },
    );

    expect(merged.previewUrl).toBe("http://127.0.0.1:8765/v1/attachments/att_123/preview");
    expect(merged.localPath).toBe("/Users/scott/Desktop/photo.png");
  });

  it("keeps repeated persisted messages even when their rendered content matches", () => {
    const merged = mergeMessageLists(
      [{ id: "1090", role: "user", content: "same prompt" }],
      [{ id: "1092", role: "user", content: "same prompt" }],
    );

    expect(merged.map((message) => message.id)).toEqual(["1090", "1092"]);
  });

  it("replaces the optimistic assistant bubble with the first stream update", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a long answer" },
      { id: "assistant-1", role: "assistant", content: "Thinking...", streaming: true },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({ id: "stream-1", content: "Starting" }),
      "stream-1",
      false,
    );

    expect(merged).toEqual([
      existing[0],
      {
        id: "stream-1",
        role: "assistant",
        content: "Starting",
        streaming: true,
        streamMessageId: "stream-1",
      },
    ]);
  });

  it("updates an existing streamed assistant bubble instead of appending duplicates", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a long answer" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Starting",
        streaming: true,
        streamMessageId: "stream-1",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({ id: "stream-1:edit:1", content: "Starting to answer." }),
      "stream-1",
      true,
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      id: "stream-1",
      content: "Starting to answer.",
      streaming: false,
      streamMessageId: "stream-1",
    });
  });

  it("keeps the longer stream snapshot when a later edit replays a shorter prefix", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a long answer" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Paragraph one.\n\nParagraph two was already visible.",
        streaming: true,
        streamMessageId: "stream-1",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({ id: "stream-1:edit:2", content: "Paragraph one." }),
      "stream-1",
      false,
    );

    expect(merged[1]).toMatchObject({
      id: "stream-1",
      content: "Paragraph one.\n\nParagraph two was already visible.",
      streaming: true,
      streamMessageId: "stream-1",
    });
  });

  it("matches later edits against the visible message id when an older sidecar generated the first id", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a long answer" },
      {
        id: "sidecar-row-1",
        role: "assistant",
        content: "Starting",
        streaming: true,
        streamMessageId: "adapter-planned-id",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({ id: "sidecar-row-2", content: "Starting to answer." }),
      "sidecar-row-1",
      false,
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      id: "sidecar-row-1",
      content: "Starting to answer.",
      streaming: true,
      streamMessageId: "sidecar-row-1",
    });
  });

  it("keeps non-stream deliveries on the completed-message path", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Ping" },
      { id: "assistant-1", role: "assistant", content: "Thinking...", streaming: true },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({ id: "final-1", source: "hermes-gateway", content: "Pong" }),
      "user-1",
    );

    expect(merged).toEqual([
      existing[0],
      {
        id: "final-1",
        role: "assistant",
        content: "Pong",
        streaming: false,
      },
    ]);
  });

  it("replaces the active streaming assistant when a final delivery has no reply metadata", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Create an image" },
      {
        id: "assistant-1",
        role: "assistant",
        content: "Thinking...",
        streaming: true,
        streamEvents: [
          {
            id: "tool-1",
            callId: "tool-1",
            toolName: "image_generate",
            label: "image_generate",
            status: "completed",
          },
        ],
      },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({ id: "final-1", source: "hermes-gateway", content: "Image: /tmp/hermes/test_image.png" }),
      "",
    );

    expect(merged).toEqual([
      existing[0],
      {
        ...existing[1],
        id: "final-1",
        content: "Image: /tmp/hermes/test_image.png",
        streaming: false,
      },
    ]);
  });

  it("attaches a post-stream media delivery to the completed streamed assistant", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Create an image" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Here’s your test image:",
        streaming: false,
        streamMessageId: "stream-1",
      },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({ id: "media-1", source: "hermes-gateway", content: "🖼️ Image: /tmp/hermes/test_image.png" }),
      "",
    );

    expect(merged).toEqual([
      existing[0],
      {
        ...existing[1],
        content: "Here’s your test image:\n\n🖼️ Image: /tmp/hermes/test_image.png",
      },
    ]);
  });

  it("treats a fallback completed delivery as the end of the active stream", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a long story" },
      {
        id: "stream-1",
        role: "assistant",
        content: "The rain began just as Mira opened the door.",
        streaming: true,
        streamMessageId: "stream-1",
      },
    ];
    const delivery = inboxMessage({
      id: "fallback-1",
      source: "hermes-gateway",
      content: "Inside, the observatory smelled of dust and old brass.",
    });

    const merged = mergeCompletedDelivery(existing, delivery, "");

    expect(deliveryCompletesActiveStream(existing, delivery)).toBe(true);
    expect(merged).toEqual([
      existing[0],
      {
        ...existing[1],
        content: "The rain began just as Mira opened the door.\n\nInside, the observatory smelled of dust and old brass.",
        streaming: false,
      },
    ]);
  });

  it("ignores replayed completed text after a stream finalizes", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Hi" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Hi! What can I help you with today?",
        streaming: false,
        streamMessageId: "stream-1",
      },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({
        id: "final-duplicate-1",
        source: "hermes-gateway",
        content: "Hi! What can I help you with today?",
      }),
      "user-1",
    );

    expect(merged).toEqual(existing);
  });

  it("repairs a replayed completed duplicate with cleaner punctuation spacing", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a story" },
      {
        id: "stream-1",
        role: "assistant",
        content: "The sign read\n\n: KEEP STREAMING.",
        streaming: false,
        streamMessageId: "stream-1",
      },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({
        id: "final-duplicate-1",
        source: "hermes-gateway",
        content: "The sign read: KEEP STREAMING.",
      }),
      "user-1",
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      id: "stream-1",
      content: "The sign read: KEEP STREAMING.",
      streaming: false,
      streamMessageId: "stream-1",
    });
  });

  it("merges a fallback tail that overlaps the middle of the streamed text", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a story" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Verification starts now, she said, uploading the logs live. By morning, the blackout was no longer a rumor",
        streaming: true,
        streamMessageId: "stream-1",
      },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({
        id: "fallback-tail-1",
        source: "hermes-gateway",
        content: "she said, uploading the logs live. By morning, the blackout was no longer a rumor, and the proof survived.",
      }),
      "user-1",
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      id: "stream-1",
      content: "Verification starts now, she said, uploading the logs live. By morning, the blackout was no longer a rumor, and the proof survived.",
      streaming: false,
      streamMessageId: "stream-1",
    });
  });

  it("shows a final stream plus file delivery provisionally until canonical history reloads", () => {
    const streamed = mergeStreamDelivery(
      [
        { id: "user-1", role: "user", content: "create a test image for me" },
        { id: "assistant-1", role: "assistant", content: "Thinking...", streaming: true },
      ],
      inboxMessage({
        id: "stream-1:edit:1",
        source: "hermes-gateway-stream",
        content: "I created a simple test image for you:\n\nNote: fallback SVG locally.",
      }),
      "stream-1",
      true,
    );

    const provisional = mergeCompletedDelivery(
      streamed,
      inboxMessage({ id: "media-1", source: "hermes-gateway", content: "📎 File: /tmp/test_image.svg" }),
      "",
    );
    const canonical = toAppMessages([
      {
        id: "user-1",
        sessionId: "session-1",
        role: "user",
        content: "create a test image for me",
        toolName: "",
        timestamp: 1,
      },
      {
        id: "assistant-canonical",
        sessionId: "session-1",
        role: "assistant",
        content: [
          "I created a simple test image for you:",
          "",
          "MEDIA:/tmp/test_image.svg",
          "",
          "Note: fallback SVG locally.",
        ].join("\n"),
        toolName: "",
        timestamp: 2,
      },
    ]);

    expect(provisional[1].content).toBe(
      "I created a simple test image for you:\n\nNote: fallback SVG locally.\n\n📎 File: /tmp/test_image.svg",
    );
    expect(canonical[1].content).toBe(
      "I created a simple test image for you:\n\nMEDIA:/tmp/test_image.svg\n\nNote: fallback SVG locally.",
    );
  });

  it("coalesces a media delivery that is replayed before the final stream row", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Create an image" },
      { id: "media-1", role: "assistant", content: "🖼️ Image: /tmp/hermes/test_image.png" },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({
        id: "stream-1:edit:1",
        source: "hermes-gateway-stream",
        content: "Here’s your test image:",
      }),
      "stream-1",
      true,
    );

    expect(merged).toEqual([
      existing[0],
      {
        id: "stream-1",
        role: "assistant",
        content: "Here’s your test image:\n\n🖼️ Image: /tmp/hermes/test_image.png",
        streaming: false,
        streamMessageId: "stream-1",
      },
    ]);
  });

  it("does not move normal prose that only mentions attachment labels", () => {
    const messages: Message[] = [
      { id: "user-1", role: "user", content: "Explain labels" },
      { id: "note-1", role: "assistant", content: "The File: label appears in gateway output." },
      {
        id: "stream-1",
        role: "assistant",
        content: "Here is the explanation.",
        streaming: false,
        streamMessageId: "stream-1",
      },
    ];

    expect(coalescePostStreamAttachments(messages)).toEqual(messages);
  });
});

describe("Hermes chat profile selection", () => {
  it("preserves an explicit conversation selection while switching profiles", () => {
    expect(
      shouldPreserveProfileConversationSelection("default", "cron-default", {
        profile: "default",
        conversationId: "cron-default",
      }),
    ).toBe(true);
  });

  it("does not preserve stale selections from another profile", () => {
    expect(
      shouldPreserveProfileConversationSelection("health", "cron-default", {
        profile: "default",
        conversationId: "cron-default",
      }),
    ).toBe(false);
    expect(shouldPreserveProfileConversationSelection("default", null, null)).toBe(false);
  });
});

describe("Hermes chat conversation loading", () => {
  it("treats timeout-like conversation list failures as transient", () => {
    expect(isTransientConversationLoadError("timed out")).toBe(true);
    expect(isTransientConversationLoadError("AbortError: The operation was aborted")).toBe(true);
    expect(isTransientConversationLoadError("Failed to fetch")).toBe(true);
    expect(isTransientConversationLoadError("Could not resolve Iris agent.")).toBe(false);
  });

  it("moves active request markers to a refreshed Hermes conversation with the same chat id", () => {
    const replacements = activeConversationReplacements(
      { "conv-core-draft": "user-1" },
      [
        {
          id: "session-hermes",
          source: "hermes-management",
          title: "Hermes title",
          preview: "",
          chatId: "core-conv-core-draft",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 2,
          messageCount: 1,
          model: "",
        },
      ],
      [],
      { "conv-core-draft": "core-conv-core-draft" },
    );

    expect(replacements).toHaveLength(1);
    expect(replacements[0].fromId).toBe("conv-core-draft");
    expect(replacements[0].to.id).toBe("session-hermes");
  });

  it("keeps an active prompt title when Hermes temporarily returns an untitled conversation", () => {
    const endpoint = preserveActiveConversationTitles(
      [
        {
          id: "session-hermes",
          source: "hermes-management",
          title: "Untitled conversation",
          preview: "",
          chatId: "core-conv-core-draft",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 2,
          messageCount: 1,
          model: "",
        },
      ],
      [
        {
          id: "conv-core-draft",
          source: "agentui-core",
          title: "Write a 4 paragraph streaming verification answer",
          preview: "",
          chatId: "core-conv-core-draft",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 2,
          messageCount: 1,
          model: "",
        },
      ],
      { "conv-core-draft": "user-1" },
      {},
      { "conv-core-draft": "core-conv-core-draft" },
    );

    expect(endpoint[0].title).toBe("Write a 4 paragraph streaming verification answer");
  });

  it("uses the real Hermes title once Hermes returns one", () => {
    const endpoint = preserveActiveConversationTitles(
      [
        {
          id: "session-hermes",
          source: "hermes-management",
          title: "Streaming Verification Answer",
          preview: "",
          chatId: "core-conv-core-draft",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 2,
          messageCount: 1,
          model: "",
        },
      ],
      [
        {
          id: "conv-core-draft",
          source: "agentui-core",
          title: "Write a 4 paragraph streaming verification answer",
          preview: "",
          chatId: "core-conv-core-draft",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 2,
          messageCount: 1,
          model: "",
        },
      ],
      { "conv-core-draft": "user-1" },
      {},
      { "conv-core-draft": "core-conv-core-draft" },
    );

    expect(endpoint[0].title).toBe("Streaming Verification Answer");
  });

  it("preserves a second active prompt title even after its local row has been replaced", () => {
    const endpoint = preserveActiveConversationTitles(
      [
        {
          id: "session-first",
          source: "hermes-management",
          title: "First Real Title",
          preview: "",
          chatId: "core-first",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 4,
          messageCount: 1,
          model: "",
        },
        {
          id: "session-second",
          source: "hermes-management",
          title: "Untitled conversation",
          preview: "",
          chatId: "core-second",
          origin: {},
          startedAt: 2,
          endedAt: null,
          lastActiveAt: 5,
          messageCount: 1,
          model: "",
        },
      ],
      [
        {
          id: "session-first",
          source: "hermes-management",
          title: "First Real Title",
          preview: "",
          chatId: "core-first",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 4,
          messageCount: 1,
          model: "",
        },
      ],
      { "session-first": "user-1", "conv-second": "user-2" },
      { "conv-second": "Second prompt title" },
      { "session-first": "core-first", "conv-second": "core-second" },
    );

    expect(endpoint[0].title).toBe("First Real Title");
    expect(endpoint[1].title).toBe("Second prompt title");
  });
});

describe("Hermes chat model switching", () => {
  it("sends a model switch only when the selected first-message model differs", () => {
    expect(
      shouldSendModelSwitch(
        { provider: "openai-codex", model: "gpt-5.5" },
        { provider: "openai-codex", model: "gpt-5.4" },
      ),
    ).toBe(true);
    expect(
      shouldSendModelSwitch(
        { provider: "openai-codex", model: "gpt-5.5" },
        { provider: "openai-codex", model: "gpt-5.5" },
      ),
    ).toBe(false);
    expect(shouldSendModelSwitch(null, { provider: "openai-codex", model: "gpt-5.5" })).toBe(false);
  });

  it("strips Hermes model switch adapter notes from rendered user messages", () => {
    expect(
      stripModelSwitchNote(
        "[Note: model was just switched from gpt-5.5 to gpt-5.4-mini via OpenAI Codex. Adjust your self-identification accordingly.] Reply exactly: model picker smoke",
      ),
    ).toBe("Reply exactly: model picker smoke");
  });
});

describe("Hermes chat conversation detail loading", () => {
  it("does not let empty canonical history erase a local failed first request", () => {
    expect(
      shouldPreserveLocalMessagesOnEmptyHistory(
        [
          { id: "user-1", role: "user", content: "Use unauthenticated model" },
          { id: "assistant-1", role: "assistant", content: "Could not resolve credentials", streaming: false },
        ],
        [],
      ),
    ).toBe(true);
  });

  it("accepts canonical history once Hermes has persisted messages", () => {
    expect(
      shouldPreserveLocalMessagesOnEmptyHistory(
        [{ id: "user-1", role: "user", content: "Hello" }],
        [
          {
            id: "history-user-1",
            sessionId: "session-1",
            role: "user",
            content: "Hello",
            toolName: "",
            timestamp: 1,
          },
        ],
      ),
    ).toBe(false);
  });

  it("recognizes canonical history that completed the active request", () => {
    expect(
      activeRequestCompletedByHistory(
        [
          {
            id: "user-1",
            sessionId: "session-1",
            role: "user",
            content: "Hello",
            status: "completed",
            toolName: "",
            timestamp: 1,
          },
          {
            id: "assistant-1",
            sessionId: "session-1",
            role: "assistant",
            content: "Done",
            status: "completed",
            toolName: "",
            timestamp: 2,
            metadata: { replyTo: "user-1", streaming: false, finalize: true },
          },
        ],
        "user-1",
      ),
    ).toBe(true);
  });

  it("recognizes completed stream history after the active user even without reply metadata", () => {
    expect(
      activeRequestCompletedByHistory(
        [
          {
            id: "user-1",
            sessionId: "session-1",
            role: "user",
            content: "Reply exactly",
            status: "completed",
            toolName: "",
            timestamp: 1,
          },
          {
            id: "stream-1",
            sessionId: "session-1",
            role: "assistant",
            content: "Done",
            status: "completed",
            toolName: "",
            timestamp: 2,
            metadata: { streamMessageId: "stream-1", streaming: false, finalize: true },
          },
        ],
        "user-1",
      ),
    ).toBe(true);
  });

  it("does not reconcile an active request from streaming-only history", () => {
    expect(
      activeRequestCompletedByHistory(
        [
          {
            id: "assistant-1",
            sessionId: "session-1",
            role: "assistant",
            content: "Still going",
            status: "streaming",
            toolName: "",
            timestamp: 2,
            metadata: { replyTo: "user-1", streaming: true },
          },
        ],
        "user-1",
      ),
    ).toBe(false);
  });

  it("does not reconcile an active request from a partial stream history row after the active user", () => {
    expect(
      activeRequestCompletedByHistory(
        [
          {
            id: "user-1",
            sessionId: "session-1",
            role: "user",
            content: "Write a long answer",
            status: "completed",
            toolName: "",
            timestamp: 1,
          },
          {
            id: "stream-1",
            sessionId: "session-1",
            role: "assistant",
            content: "Still writing",
            status: "completed",
            toolName: "",
            timestamp: 2,
            metadata: { streamMessageId: "stream-1", streaming: true, finalize: false },
          },
        ],
        "user-1",
      ),
    ).toBe(false);
  });

  it("does not let a stale detail response retake selection after another conversation was clicked", () => {
    expect(
      shouldApplyConversationDetailSelection(
        "conversation-b",
        "chat-b",
        "conversation-a",
        { id: "conversation-a", chatId: "chat-a" },
      ),
    ).toBe(false);
  });

  it("allows a current detail response to replace an alias with its loaded conversation id", () => {
    expect(
      shouldApplyConversationDetailSelection(
        "conversation-alias",
        "chat-a",
        "conversation-alias",
        { id: "conversation-a", chatId: "chat-a" },
      ),
    ).toBe(true);
  });

  it("reloads completed real conversations even when live messages are already cached", () => {
    expect(shouldSkipConversationDetailLoad("session-1", {})).toBe(false);
  });

  it("keeps active and optimistic conversations on provisional state", () => {
    expect(shouldSkipConversationDetailLoad("session-1", { "session-1": "request-1" })).toBe(true);
    expect(shouldSkipConversationDetailLoad("optimistic-1", {})).toBe(true);
  });
});
