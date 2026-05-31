import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../../app/types";
import type { HermesInboxMessage } from "../../../types/hermes";
import {
  activeSessionReplacements,
  activeRequestCompletedByHistory,
  isTransientSessionLoadError,
  mergeSessionChatIdMap,
  modelSwitchSelectionForSend,
  preserveLocalScheduledDeliveries,
  preserveLocalSessionProjectMetadata,
  preserveActiveSessionTitles,
  resolveDeliveryClientRequestId,
  scheduleDedupedTimer,
  sessionMetadataShouldPropagate,
  shouldApplySessionDetailSelection,
  shouldPreserveLocalMessagesOnEmptyHistory,
  shouldPreserveProfileSessionSelection,
  shouldRetryUnmappedDelivery,
  shouldSendModelSwitch,
  shouldSkipSessionDetailLoad,
  upsertSessionMetadataForProfile,
} from "../useIrisChat";
import type { HermesSession } from "../../../types/hermes";
import {
  coalescePostStreamAttachments,
  deliveryCompletesActiveStream,
  mergeCompletedDelivery,
  mergeMessageLists,
  mergeStreamDelivery,
  reconcileMessages,
} from "../chatStreamMerging";
import {
  isHiddenDeliveryMetadata,
  stripModelSwitchNote,
  toAppMessages,
} from "../chatHistory";
import { ASSISTANT_THINKING_TEXT } from "../assistantStatus";
import { shouldApplyDeliveryReadState } from "../chatCoreEvents";
import { mergeUploadedAttachment } from "../chatAttachments";
import { irisCoreEventToDeliveryMessage } from "../../../lib/irisCoreMappings";

function inboxMessage(
  overrides: Partial<HermesInboxMessage> & { id: string; content: string },
): HermesInboxMessage {
  return {
    cursor: 1,
    source: "hermes-gateway-stream",
    platform: "iris",
    profile: "default",
    chatId: "desktop-1",
    metadata: {},
    createdAt: 1,
    acknowledgedAt: null,
    ...overrides,
  };
}

describe("Iris chat inbox merging", () => {
  const generatedImageAttachment = {
    id: "att_image_1",
    kind: "image" as const,
    mimeType: "image/png",
    name: "test_image.png",
    previewUrl: "/v1/attachments/att_image_1/preview",
    downloadUrl: "/v1/attachments/att_image_1/content",
    size: 42,
  };

  it("keeps the chat-id map stable when a session refresh has no new mappings", () => {
    const current = { "session-1": "chat-1" };

    expect(
      mergeSessionChatIdMap(current, [
        { id: "session-1", chatId: "chat-1" },
        { id: "session-2", chatId: "" },
      ]),
    ).toBe(current);
  });

  it("preserves project metadata while agent session refresh catches up", () => {
    const endpoint = [
      {
        id: "session_1",
        source: "iris-core",
        model: "",
        title: "Project chat",
        preview: "",
        chatId: "core-chat-1",
        origin: {},
        startedAt: 1,
        endedAt: null,
        lastActiveAt: 2,
        messageCount: 1,
      },
    ];
    const current = [
      {
        ...endpoint[0],
        id: "optimistic-1",
        source: "optimistic",
        metadata: { projectId: "project_1" },
      },
    ];

    expect(preserveLocalSessionProjectMetadata(endpoint, current)[0].metadata?.projectId).toBe("project_1");
  });

  it("retries unmapped inbox deliveries generously but still caps them", () => {
    expect(shouldRetryUnmappedDelivery(0)).toBe(true);
    expect(shouldRetryUnmappedDelivery(7)).toBe(true);
    expect(shouldRetryUnmappedDelivery(8)).toBe(false);
  });

  it("uses active replyTo metadata when completed deliveries omit clientRequestId", () => {
    expect(resolveDeliveryClientRequestId("", "client-message-1", true)).toBe("client-message-1");
    expect(resolveDeliveryClientRequestId("", "client-message-1", false)).toBe("");
    expect(resolveDeliveryClientRequestId("client-message-2", "client-message-1", true)).toBe("client-message-2");
  });

  it("does not let replayed historical deliveries rewrite read state on restart", () => {
    expect(shouldApplyDeliveryReadState({ createdAt: 10 }, 20)).toBe(false);
    expect(shouldApplyDeliveryReadState({ createdAt: 20 }, 20)).toBe(true);
    expect(shouldApplyDeliveryReadState({ createdAt: 21 }, 20)).toBe(true);
  });

  it("treats model-switch command replies as hidden even when Hermes drops hidden metadata", () => {
    expect(isHiddenDeliveryMetadata({ replyTo: "client-message-1-model" })).toBe(true);
    expect(isHiddenDeliveryMetadata({ kind: "model-switch" })).toBe(true);
    expect(isHiddenDeliveryMetadata({ replyTo: "client-message-1" })).toBe(false);
  });

  it("omits hidden model-switch replies when loading session history", () => {
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

  it("maps assistant metadata attachments from session history", () => {
    const messages = toAppMessages([
      {
        id: "assistant-1",
        sessionId: "session-1",
        role: "assistant",
        content: "Done\n\nMEDIA:/tmp/test_image.png",
        toolName: "",
        timestamp: 1,
        metadata: {
          generatedFiles: [{ path: "/tmp/test_image.png" }],
          attachments: [generatedImageAttachment],
        },
      },
      {
        id: "assistant-2",
        sessionId: "session-1",
        role: "assistant",
        content: "Audio ready",
        toolName: "",
        timestamp: 2,
        metadata: {
          attachments: [
            {
              id: "att_audio_1",
              kind: "audio",
              mimeType: "audio/mpeg",
              name: "voice.mp3",
              downloadUrl: "/v1/attachments/att_audio_1/content",
              size: 100,
            },
          ],
        },
      },
    ]);

    expect(messages[0]).toMatchObject({
      id: "assistant-1",
      role: "assistant",
      content: "Done",
      attachments: [generatedImageAttachment],
    });
    expect(messages[1].attachments?.[0].kind).toBe("audio");
  });

  it("renders attachment-only user history as an attachment card without manifest text", () => {
    const audioAttachment = {
      id: "att_audio_1",
      kind: "audio" as const,
      mimeType: "video/webm",
      name: "dictation.webm",
      downloadUrl: "/v1/attachments/att_audio_1/content",
      size: 36_000,
    };

    const messages = toAppMessages([
      {
        id: "user-1",
        sessionId: "session-1",
        role: "user",
        content: [
          "Use the attached files as context.",
          "",
          "Attached files:",
          "1. dictation.webm (video/webm, 36 KB)",
          "   Runtime path: /Users/scott/.iris/attachments/blobs/hash",
        ].join("\n"),
        toolName: "",
        timestamp: 1,
        metadata: {
          attachments: [audioAttachment],
        },
      },
    ]);

    expect(messages[0]).toMatchObject({
      id: "user-1",
      role: "user",
      content: "",
      attachments: [audioAttachment],
    });
  });

  it("keeps user prompt text while hiding the rendered attachment summary", () => {
    const attachment = {
      id: "att_image_1",
      kind: "image" as const,
      mimeType: "image/png",
      name: "image.png",
      downloadUrl: "/v1/attachments/att_image_1/content",
      size: 12_000,
    };

    const messages = toAppMessages([
      {
        id: "user-1",
        sessionId: "session-1",
        role: "user",
        content: "Look at this\n\nAttached files:\n1. image.png (image/png, 12 KB)",
        toolName: "",
        timestamp: 1,
        metadata: {
          attachments: [attachment],
        },
      },
    ]);

    expect(messages[0]).toMatchObject({
      content: "Look at this",
      attachments: [attachment],
    });
  });

  it("keeps local and persisted rows without clientRequestId rather than merging by content", () => {
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

    expect(merged.map((message) => message.id)).toEqual([
      localUserId,
      localAssistantId,
      "1090",
      "1091",
      "current-user",
    ]);
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
      { id: "user-1", role: "user", content: "Write a long answer", clientRequestId: "user-1" },
      { id: "assistant-1", role: "assistant", content: ASSISTANT_THINKING_TEXT, streaming: true, clientRequestId: "user-1" },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({ id: "stream-1", content: "Starting" }),
      "stream-1",
      false,
      "user-1",
    );

    expect(merged).toEqual([
      existing[0],
      {
        id: "stream-1",
        role: "assistant",
        content: "Starting",
        streaming: true,
        streamMessageId: "stream-1",
        clientRequestId: "user-1",
      },
    ]);
  });

  it("renders an assembled snapshot as a full replace without delta-stitching", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a long answer", clientRequestId: "user-1" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Hello",
        streaming: true,
        streamMessageId: "stream-1",
        clientRequestId: "user-1",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({
        id: "stream-1:edit:2",
        content: "Hello, world!",
        metadata: { streamMessageId: "stream-1", assembled: true, chunkOperation: "replace", streaming: true },
      }),
      "stream-1",
      false,
      "user-1",
    );

    expect(merged[1]).toMatchObject({ id: "stream-1", content: "Hello, world!", streaming: true });
  });

  it("renders an assembled snapshot verbatim even when it diverges from the prior content", () => {
    // A reordered/garbled prior render cannot corrupt the result: the snapshot is
    // authoritative, so no overlap/append heuristic is applied.
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "test", clientRequestId: "user-1" },
      {
        id: "stream-1",
        role: "assistant",
        content: "garbled XYZ partial",
        streaming: true,
        streamMessageId: "stream-1",
        clientRequestId: "user-1",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({
        id: "stream-1:edit:final",
        content: "The complete, correct answer.",
        metadata: { streamMessageId: "stream-1", assembled: true, chunkOperation: "replace", streaming: false, finalize: true },
      }),
      "stream-1",
      true,
      "user-1",
    );

    expect(merged[1]).toMatchObject({
      id: "stream-1",
      content: "The complete, correct answer.",
      streaming: false,
    });
  });

  it("replaces finalized stream content when the final chunk repeats the streamed prefix", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "test", clientRequestId: "user-1" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Test",
        streaming: true,
        streamMessageId: "stream-1",
        clientRequestId: "user-1",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({
        id: "stream-1:final",
        content: "Test received.",
        metadata: {
          streamMessageId: "stream-1",
          chunkOperation: "append",
          streaming: false,
          finalize: true,
        },
      }),
      "stream-1",
      true,
      "user-1",
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      id: "stream-1",
      role: "assistant",
      content: "Test received.",
      streaming: false,
      streamMessageId: "stream-1",
      clientRequestId: "user-1",
    });
  });

  it("appends finalized stream tail chunks when the final chunk is only a delta", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "hello", clientRequestId: "user-1" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Hello, w",
        streaming: true,
        streamMessageId: "stream-1",
        clientRequestId: "user-1",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({
        id: "stream-1:final",
        content: "orld!",
        metadata: {
          streamMessageId: "stream-1",
          chunkOperation: "append",
          streaming: false,
          finalize: true,
        },
      }),
      "stream-1",
      true,
      "user-1",
    );

    expect(merged[1]).toMatchObject({
      content: "Hello, world!",
      streaming: false,
    });
  });

  it("replaces live stream content when an append chunk replays the cumulative prefix", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "test", clientRequestId: "user-1" },
      {
        id: "stream-1",
        role: "assistant",
        content: "This desktop answer starts",
        streaming: true,
        streamMessageId: "stream-1",
        clientRequestId: "user-1",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({
        id: "stream-1:edit:2",
        content: "This desktop answer starts and continues once.",
        metadata: {
          streamMessageId: "stream-1",
          chunkOperation: "append",
          streaming: true,
          finalize: false,
        },
      }),
      "stream-1",
      false,
      "user-1",
    );

    expect(merged[1]).toMatchObject({
      content: "This desktop answer starts and continues once.",
      streaming: true,
    });
  });

  it("normalizes live tool metadata into stream tool events", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Run a command", clientRequestId: "user-1" },
      { id: "assistant-1", role: "assistant", content: ASSISTANT_THINKING_TEXT, streaming: true, clientRequestId: "user-1" },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({
        id: "stream-1:tool:1",
        content: "",
        metadata: {
          toolCalls: [
            {
              id: "call-1",
              call_id: "call-1",
              type: "function",
              function: {
                name: "terminal",
                arguments: '{"command":"sleep 5 && echo \\"hello\\""}',
              },
            },
          ],
        },
      }),
      "stream-1",
      false,
      "user-1",
    );

    expect(merged[1]).toMatchObject({
      id: "stream-1",
      role: "assistant",
      content: "",
      streaming: true,
      streamMessageId: "stream-1",
      streamEvents: [
        {
          id: "call-1",
          callId: "call-1",
          toolName: "terminal",
          label: 'terminal: sleep 5 && echo "hello"',
          status: "running",
          arguments: '{"command":"sleep 5 && echo \\"hello\\""}',
        },
      ],
    });
  });

  it("does not infer live tool events from assistant text without metadata", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Run a command", clientRequestId: "user-1" },
      { id: "assistant-1", role: "assistant", content: ASSISTANT_THINKING_TEXT, streaming: true, clientRequestId: "user-1" },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({ id: "stream-1:tool:1", content: '💻 terminal: "sleep 5 && echo \\"hello\\""' }),
      "stream-1",
      false,
      "user-1",
    );

    expect(merged[1]).toMatchObject({
      id: "stream-1",
      role: "assistant",
      content: '💻 terminal: "sleep 5 && echo \\"hello\\""',
      streaming: true,
      streamMessageId: "stream-1",
    });
    expect(merged[1].streamEvents).toBeUndefined();
  });

  it("keeps live metadata tool events when the stream completes with assistant content", () => {
    const streamed = mergeStreamDelivery(
      [
        { id: "user-1", role: "user", content: "Run a command", clientRequestId: "user-1" },
        { id: "assistant-1", role: "assistant", content: ASSISTANT_THINKING_TEXT, streaming: true, clientRequestId: "user-1" },
      ],
      inboxMessage({
        id: "stream-1:tool:1",
        content: "",
        metadata: {
          toolCalls: [
            {
              id: "call-1",
              call_id: "call-1",
              type: "function",
              function: {
                name: "terminal",
                arguments: '{"command":"sleep 5 && echo \\"hello\\""}',
              },
            },
          ],
        },
      }),
      "stream-1",
      false,
      "user-1",
    );

    const completed = mergeStreamDelivery(
      streamed,
      inboxMessage({ id: "stream-1:edit:1", content: "Ahoy — command completed:\n\nhello" }),
      "stream-1",
      true,
      "user-1",
    );

    expect(completed[1]).toMatchObject({
      id: "stream-1",
      content: "Ahoy — command completed:\n\nhello",
      streaming: false,
      streamEvents: [
        {
          toolName: "terminal",
          label: 'terminal: sleep 5 && echo "hello"',
          status: "completed",
        },
      ],
    });
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
        clientRequestId: "user-1",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({ id: "stream-1:edit:1", content: " to answer." }),
      "stream-1",
      true,
      "user-1",
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      id: "stream-1",
      content: "Starting to answer.",
      streaming: false,
      streamMessageId: "stream-1",
    });
  });

  it("maps Core delivery events by external message id so finalized edits replace the provisional bubble", () => {
    const completedDelivery = irisCoreEventToDeliveryMessage(
      {
        cursor: 1,
        id: "evt_delivery_iris-delivery-1",
        sessionId: "session-1",
        agentId: "agent-1",
        runtimeId: "runtime-1",
        type: "message.assistant.completed",
        role: "assistant",
        content: "Hi!",
        parentEventId: "",
        externalMessageId: "iris-delivery-1",
        createdAt: 1,
        metadata: {
          chatId: "core-chat-1",
          profile: "default",
          source: "hermes-gateway",
          clientRequestId: "user-1",
        },
      },
      "default",
    );
    const finalStreamEdit = irisCoreEventToDeliveryMessage(
      {
        cursor: 2,
        id: "evt_delivery_iris-delivery-1:edit:2",
        sessionId: "session-1",
        agentId: "agent-1",
        runtimeId: "runtime-1",
        type: "message.assistant.completed",
        role: "assistant",
        content: "Hi!",
        parentEventId: "",
        externalMessageId: "iris-delivery-1:edit:2",
        createdAt: 2,
        metadata: {
          chatId: "core-chat-1",
          profile: "default",
          source: "hermes-gateway-stream",
          streamMessageId: "iris-delivery-1",
          streaming: false,
          finalize: true,
          clientRequestId: "user-1",
        },
      },
      "default",
    );

    const provisional = mergeCompletedDelivery(
      [{ id: "user-1", role: "user", content: "Hi" }],
      completedDelivery,
      "",
      "user-1",
    );
    const finalized = mergeStreamDelivery(
      provisional,
      finalStreamEdit,
      "iris-delivery-1",
      true,
      "user-1",
    );

    expect(provisional[1]).toMatchObject({
      id: "iris-delivery-1",
      role: "assistant",
      content: "Hi!",
      streaming: false,
    });
    expect(finalized).toHaveLength(2);
    expect(finalized[1]).toMatchObject({
      id: "iris-delivery-1",
      role: "assistant",
      content: "Hi!",
      streaming: false,
      streamMessageId: "iris-delivery-1",
    });
  });

  it("adds attachment metadata from stream deliveries", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Create an image", clientRequestId: "user-1" },
      {
        id: "stream-1",
        role: "assistant",
        content: "",
        streaming: true,
        streamMessageId: "stream-1",
        clientRequestId: "user-1",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({
        id: "stream-1:edit:1",
        content: "Done\n\nMEDIA:/tmp/test_image.png",
        metadata: {
          streamMessageId: "stream-1",
          generatedFiles: [{ path: "/tmp/test_image.png" }],
          attachments: [generatedImageAttachment],
        },
      }),
      "stream-1",
      true,
      "user-1",
    );

    expect(merged[1]).toMatchObject({
      content: "Done",
      streaming: false,
      attachments: [generatedImageAttachment],
    });
  });

  it("renders an uncorrelated assembled snapshot by streamMessageId instead of dropping it", () => {
    // A1/D5: a snapshot whose clientRequestId could not be resolved still carries a
    // streamMessageId, so it renders (full replace) keyed by that — a late reply is
    // never lost.
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a long answer" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Paragraph one.",
        streaming: true,
        streamMessageId: "stream-1",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({
        id: "stream-1:edit:2",
        content: "Paragraph one.\n\nParagraph two.",
        metadata: { streamMessageId: "stream-1", assembled: true, chunkOperation: "replace", uncorrelated: true },
      }),
      "stream-1",
      false,
    );

    expect(merged[1]).toMatchObject({
      id: "stream-1",
      content: "Paragraph one.\n\nParagraph two.",
      streaming: true,
      streamMessageId: "stream-1",
    });
  });

  it("matches later edits against the visible message id when an older Core build generated the first id", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a long answer" },
      {
        id: "core-row-1",
        role: "assistant",
        content: "Starting",
        streaming: true,
        streamMessageId: "adapter-planned-id",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({ id: "core-row-2", content: " to answer." }),
      "core-row-1",
      false,
      "user-1",
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      id: "core-row-1",
      content: "Starting to answer.",
      streaming: true,
      streamMessageId: "core-row-1",
    });
  });

  it("keeps non-stream deliveries on the completed-message path", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Ping" },
      { id: "assistant-1", role: "assistant", content: ASSISTANT_THINKING_TEXT, streaming: true, clientRequestId: "user-1" },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({ id: "final-1", source: "hermes-gateway", content: "Pong" }),
      "user-1",
      "user-1",
    );

    expect(merged).toEqual([
      existing[0],
      {
        id: "final-1",
        role: "assistant",
        content: "Pong",
        streaming: false,
        clientRequestId: "user-1",
      },
    ]);
  });

  it("replaces the active streaming assistant when a final delivery has no reply metadata", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Create an image" },
      {
        id: "assistant-1",
        role: "assistant",
        content: ASSISTANT_THINKING_TEXT,
        streaming: true,
        clientRequestId: "user-1",
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
      "user-1",
    );

    expect(merged).toEqual([
      existing[0],
      {
        ...existing[1],
        id: "final-1",
        content: "Image: /tmp/hermes/test_image.png",
        streaming: false,
        clientRequestId: "user-1",
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

    expect(merged).toEqual(existing);
  });

  it("merges a post-stream attachment card into the completed streamed assistant", () => {
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
      inboxMessage({
        id: "media-1",
        source: "hermes-gateway",
        content: "🖼️ Image: /tmp/hermes/test_image.png",
        metadata: {
          generatedFiles: [{ path: "/tmp/hermes/test_image.png" }],
          attachments: [generatedImageAttachment],
        },
      }),
      "",
    );

    expect(merged).toEqual(existing);
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

    expect(deliveryCompletesActiveStream(existing, delivery)).toBe(false);
    expect(merged).toEqual(existing);
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

  it("does not repair replayed completed duplicates by content", () => {
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

    expect(merged).toEqual(existing);
  });

  it("does not merge fallback tails by content overlap", () => {
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

    expect(merged).toEqual(existing);
  });

  it("shows a final stream plus file delivery provisionally until canonical history reloads", () => {
    const streamed = mergeStreamDelivery(
      [
        { id: "user-1", role: "user", content: "create a test image for me", clientRequestId: "user-1" },
        { id: "assistant-1", role: "assistant", content: ASSISTANT_THINKING_TEXT, streaming: true, clientRequestId: "user-1" },
      ],
      inboxMessage({
        id: "stream-1:edit:1",
        source: "hermes-gateway-stream",
        content: "I created a simple test image for you:\n\nNote: fallback SVG locally.",
      }),
      "stream-1",
      true,
      "user-1",
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
      "I created a simple test image for you:\n\nNote: fallback SVG locally.",
    );
    expect(canonical[1].content).toBe(
      "I created a simple test image for you:\n\nMEDIA:/tmp/test_image.svg\n\nNote: fallback SVG locally.",
    );
  });

  it("preserves scheduled delivery bubbles when canonical history reloads without them", () => {
    const canonical = toAppMessages([
      {
        id: "user-1",
        sessionId: "session-1",
        role: "user",
        content: "remind me in 1 minute to walk the dog",
        toolName: "",
        timestamp: 1,
      },
      {
        id: "assistant-1",
        sessionId: "session-1",
        role: "assistant",
        content: "Scheduled.",
        toolName: "",
        timestamp: 2,
      },
    ]);
    const local: Message[] = [
      ...canonical,
      {
        id: "iris-delivery-1",
        role: "assistant",
        source: "hermes-cron",
        content: "Cronjob Response: walk the dog",
      },
    ];

    expect(preserveLocalScheduledDeliveries(canonical, local)).toEqual(local);
  });

  it("keeps an older scheduled delivery above a newer user turn after history reloads", () => {
    const firstUser: Message = {
      id: "user-1",
      role: "user",
      content: "remind me in 1 minute to walk the dog",
    };
    const firstScheduled: Message = {
      id: "assistant-1",
      role: "assistant",
      content: "Done — I'll remind you in 1 minute to walk the dog.",
    };
    const firstCron: Message = {
      id: "iris-delivery-1",
      role: "assistant",
      source: "hermes-cron",
      content: "Cronjob Response: Walk the dog reminder",
    };
    const secondUser: Message = {
      id: "user-2",
      role: "user",
      content: "remind me in 1 minute to stretch",
    };
    const secondScheduled: Message = {
      id: "assistant-2",
      role: "assistant",
      content: "Done — I'll remind you in 1 minute to stretch.",
    };

    const canonical = [firstUser, firstScheduled, secondUser, secondScheduled];
    const local = [firstUser, firstScheduled, firstCron, secondUser, secondScheduled];

    expect(preserveLocalScheduledDeliveries(canonical, local)).toEqual(local);
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
      "user-1",
    );

    expect(merged).toEqual([
      existing[0],
      {
        id: "stream-1",
        role: "assistant",
        content: "Here’s your test image:\n\n🖼️ Image: /tmp/hermes/test_image.png",
        streaming: false,
        streamMessageId: "stream-1",
        clientRequestId: "user-1",
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

describe("clientRequestId dedup", () => {
  it("matches the optimistic assistant placeholder by clientRequestId before streamMessageId is known", () => {
    const existing: Message[] = [
      { id: "uuid-user", role: "user", content: "hi", clientRequestId: "uuid-user" },
      {
        id: "uuid-asst",
        role: "assistant",
        content: ASSISTANT_THINKING_TEXT,
        streaming: true,
        clientRequestId: "uuid-user",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({ id: "stream-1", content: "Hello", metadata: { replyTo: "uuid-user" } }),
      "stream-1",
      false,
      "uuid-user",
    );

    expect(merged).toEqual([
      existing[0],
      {
        id: "stream-1",
        role: "assistant",
        content: "Hello",
        streaming: true,
        streamMessageId: "stream-1",
        clientRequestId: "uuid-user",
      },
    ]);
  });

  it("appends completed delivery deltas by clientRequestId", () => {
    const existing: Message[] = [
      { id: "uuid-user", role: "user", content: "hi", clientRequestId: "uuid-user" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Hello, w",
        streaming: true,
        streamMessageId: "stream-1",
        clientRequestId: "uuid-user",
      },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({
        id: "delivery-99",
        content: "orld!",
        metadata: { replyTo: "uuid-user" },
      }),
      "uuid-user",
      "uuid-user",
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      role: "assistant",
      content: "Hello, world!",
      streaming: false,
      clientRequestId: "uuid-user",
    });
  });

  it("replaces active stream content when completed delivery repeats the streamed prefix", () => {
    const existing: Message[] = [
      { id: "uuid-user", role: "user", content: "test", clientRequestId: "uuid-user" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Test",
        streaming: true,
        streamMessageId: "stream-1",
        clientRequestId: "uuid-user",
      },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({
        id: "delivery-99",
        content: "Test received.",
        metadata: { replyTo: "uuid-user" },
      }),
      "uuid-user",
      "uuid-user",
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      role: "assistant",
      content: "Test received.",
      streaming: false,
      clientRequestId: "uuid-user",
    });
  });

  it("replaces active stream content for non-monotonic replace chunks", () => {
    const existing: Message[] = [
      { id: "uuid-user", role: "user", content: "hi", clientRequestId: "uuid-user" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Hello world",
        streaming: true,
        streamMessageId: "stream-1",
        clientRequestId: "uuid-user",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({
        id: "stream-1:edit:2",
        content: "Goodbye",
        metadata: { streamMessageId: "stream-1", clientRequestId: "uuid-user", chunkOperation: "replace" },
      }),
      "stream-1",
      false,
      "uuid-user",
    );

    expect(merged[1]).toMatchObject({
      content: "Goodbye",
      streaming: true,
      clientRequestId: "uuid-user",
    });
  });

  it("replaces active stream content for final replace deliveries", () => {
    const existing: Message[] = [
      { id: "uuid-user", role: "user", content: "hi", clientRequestId: "uuid-user" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Hello world",
        streaming: true,
        streamMessageId: "stream-1",
        clientRequestId: "uuid-user",
      },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({
        id: "stream-1:edit:3",
        content: "Goodbye",
        metadata: { clientRequestId: "uuid-user", chunkOperation: "replace" },
      }),
      "uuid-user",
      "uuid-user",
    );

    expect(merged[1]).toMatchObject({
      content: "Goodbye",
      streaming: false,
      clientRequestId: "uuid-user",
    });
  });

  it("prefers clientRequestId over content equivalence when merging history into local", () => {
    const local: Message[] = [
      { id: "uuid-user", role: "user", content: "hi there", clientRequestId: "uuid-user" },
      {
        id: "stream-1",
        role: "assistant",
        content: "ok",
        streamMessageId: "stream-1",
        clientRequestId: "uuid-user",
      },
    ];
    const history: Message[] = [
      { id: "12345", role: "user", content: "hi", clientRequestId: "uuid-user" },
      { id: "12346", role: "assistant", content: "ok!", clientRequestId: "uuid-user" },
    ];

    const merged = mergeMessageLists(local, history);

    expect(merged.map((message) => message.id)).toEqual(["12345", "12346"]);
  });

  it("infers assistant history clientRequestId from the preceding user turn", () => {
    const history = toAppMessages([
      {
        id: "history-user",
        sessionId: "session-1",
        role: "user",
        content: "test",
        status: "completed",
        toolName: "",
        timestamp: 1,
        metadata: { clientRequestId: "client-message-1" },
      },
      {
        id: "history-assistant",
        sessionId: "session-1",
        role: "assistant",
        content: "Test received.",
        status: "completed",
        toolName: "",
        timestamp: 2,
        metadata: { sessionId: "external-session", toolCalls: [] },
      },
    ]);

    expect(history[1]).toMatchObject({
      id: "history-assistant",
      role: "assistant",
      clientRequestId: "client-message-1",
    });
    expect(
      mergeMessageLists(
        [
          { id: "client-message-1", role: "user", content: "test", clientRequestId: "client-message-1" },
          {
            id: "optimistic-assistant",
            role: "assistant",
            content: ASSISTANT_THINKING_TEXT,
            streaming: true,
            clientRequestId: "client-message-1",
          },
        ],
        history,
      ).map((message) => message.id),
    ).toEqual(["history-user", "history-assistant"]);
  });

  it("does not merge history by content when clientRequestId is absent on both sides", () => {
    const local: Message[] = [
      { id: "uuid-user", role: "user", content: "same prompt" },
    ];
    const history: Message[] = [
      { id: "12345", role: "user", content: "same prompt" },
    ];

    const merged = mergeMessageLists(local, history);

    expect(merged.map((message) => message.id)).toEqual(["uuid-user", "12345"]);
  });

  it("renders an uncorrelated finalize for an unknown stream as a new assistant message", () => {
    // D5: a late reply we cannot correlate is rendered (keyed by streamMessageId)
    // rather than dropped, so it is never lost.
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "hi" },
      {
        id: "stream-a",
        role: "assistant",
        content: "partial answer",
        streaming: true,
        streamMessageId: "stream-a",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({
        id: "stream-z:edit:1",
        content: "final answer",
        metadata: { streamMessageId: "stream-z", assembled: true, chunkOperation: "replace", finalize: true },
      }),
      "stream-z",
      true,
    );

    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual(existing[0]);
    expect(merged[1]).toEqual(existing[1]);
    expect(merged[2]).toMatchObject({
      id: "stream-z",
      streamMessageId: "stream-z",
      content: "final answer",
      streaming: false,
    });
  });
});

describe("Iris chat profile selection", () => {
  it("preserves an explicit session selection while switching profiles", () => {
    expect(
      shouldPreserveProfileSessionSelection("default", "cron-default", {
        profile: "default",
        sessionId: "cron-default",
      }),
    ).toBe(true);
  });

  it("does not preserve stale selections from another profile", () => {
    expect(
      shouldPreserveProfileSessionSelection("health", "cron-default", {
        profile: "default",
        sessionId: "cron-default",
      }),
    ).toBe(false);
    expect(shouldPreserveProfileSessionSelection("default", null, null)).toBe(false);
  });
});

describe("Iris chat session loading", () => {
  it("treats timeout-like session list failures as transient", () => {
    expect(isTransientSessionLoadError("timed out")).toBe(true);
    expect(isTransientSessionLoadError("AbortError: The operation was aborted")).toBe(true);
    expect(isTransientSessionLoadError("Failed to fetch")).toBe(true);
    expect(isTransientSessionLoadError("Could not resolve Iris agent.")).toBe(false);
  });

  it("moves active request markers to a refreshed Hermes session with the same chat id", () => {
    const replacements = activeSessionReplacements(
      { "session-core-draft": "user-1" },
      [
        {
          id: "session-hermes",
          source: "hermes-management",
          title: "Hermes title",
          preview: "",
          chatId: "core-session-core-draft",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 2,
          messageCount: 1,
          model: "",
        },
      ],
      [],
      { "session-core-draft": "core-session-core-draft" },
    );

    expect(replacements).toHaveLength(1);
    expect(replacements[0].fromId).toBe("session-core-draft");
    expect(replacements[0].to.id).toBe("session-hermes");
  });

  it("does not need alias replacement when canonical history keeps the draft session id", () => {
    const replacements = activeSessionReplacements(
      { "session-core-draft": "user-1" },
      [
        {
          id: "session-core-draft",
          source: "hermes-management",
          title: "Hermes title",
          preview: "",
          chatId: "core-session-core-draft",
          origin: { externalSessionId: "hermes-session-1" },
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 2,
          messageCount: 1,
          model: "",
        },
      ],
      [],
      { "session-core-draft": "core-session-core-draft" },
    );

    expect(replacements).toEqual([]);
  });

  it("keeps an active prompt title when Hermes temporarily returns an untitled session", () => {
    const endpoint = preserveActiveSessionTitles(
      [
        {
          id: "session-hermes",
          source: "hermes-management",
          title: "Untitled session",
          preview: "",
          chatId: "core-session-core-draft",
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
          id: "session-core-draft",
          source: "iris-core",
          title: "Write a 4 paragraph streaming verification answer",
          preview: "",
          chatId: "core-session-core-draft",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 2,
          messageCount: 1,
          model: "",
        },
      ],
      { "session-core-draft": "user-1" },
      {},
      { "session-core-draft": "core-session-core-draft" },
    );

    expect(endpoint[0].title).toBe("Write a 4 paragraph streaming verification answer");
  });

  it("uses the real Hermes title once Hermes returns one", () => {
    const endpoint = preserveActiveSessionTitles(
      [
        {
          id: "session-hermes",
          source: "hermes-management",
          title: "Streaming Verification Answer",
          preview: "",
          chatId: "core-session-core-draft",
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
          id: "session-core-draft",
          source: "iris-core",
          title: "Write a 4 paragraph streaming verification answer",
          preview: "",
          chatId: "core-session-core-draft",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 2,
          messageCount: 1,
          model: "",
        },
      ],
      { "session-core-draft": "user-1" },
      {},
      { "session-core-draft": "core-session-core-draft" },
    );

    expect(endpoint[0].title).toBe("Streaming Verification Answer");
  });

  it("keeps the previous title when an existing session refreshes with a temporary placeholder", () => {
    const endpoint = preserveActiveSessionTitles(
      [
        {
          id: "session-existing",
          source: "iris-core",
          title: "Untitled session",
          preview: "",
          chatId: "chat-existing",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 5,
          messageCount: 4,
          model: "",
        },
      ],
      [
        {
          id: "session-existing",
          source: "iris-core",
          title: "Roadmap planning",
          preview: "",
          chatId: "chat-existing",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 2,
          messageCount: 3,
          model: "",
        },
      ],
      {},
      {},
      {},
    );

    expect(endpoint[0].title).toBe("Roadmap planning");
    expect(endpoint[0].lastActiveAt).toBe(5);
  });

  it("prefers an existing session title over the latest active prompt title", () => {
    const endpoint = preserveActiveSessionTitles(
      [
        {
          id: "session-existing",
          source: "iris-core",
          title: "Untitled session",
          preview: "",
          chatId: "chat-existing",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 5,
          messageCount: 4,
          model: "",
        },
      ],
      [
        {
          id: "session-existing",
          source: "iris-core",
          title: "Roadmap planning",
          preview: "",
          chatId: "chat-existing",
          origin: {},
          startedAt: 1,
          endedAt: null,
          lastActiveAt: 2,
          messageCount: 3,
          model: "",
        },
      ],
      { "session-existing": "user-1" },
      { "session-existing": "what about the budget" },
      { "session-existing": "chat-existing" },
    );

    expect(endpoint[0].title).toBe("Roadmap planning");
  });

  it("preserves a second active prompt title even after its local row has been replaced", () => {
    const endpoint = preserveActiveSessionTitles(
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
          title: "Untitled session",
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
      { "session-first": "user-1", "session-second": "user-2" },
      { "session-second": "Second prompt title" },
      { "session-first": "core-first", "session-second": "core-second" },
    );

    expect(endpoint[0].title).toBe("First Real Title");
    expect(endpoint[1].title).toBe("Second prompt title");
  });
});

describe("Iris chat model switching", () => {
  it("sends a model switch only when the selected model differs", () => {
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

  it("uses a selected model switch for existing-session sends too", () => {
    const selected = { provider: "openai-codex", model: "gpt-5.4-mini" };

    expect(
      modelSwitchSelectionForSend(selected, { provider: "openai-codex", model: "gpt-5.5" }),
    ).toEqual(selected);
  });

  it("does not force a switch when a session only knows the matching model id", () => {
    expect(
      shouldSendModelSwitch(
        { provider: "", model: "gpt-5.5" },
        { provider: "openai-codex", model: "gpt-5.5" },
      ),
    ).toBe(false);
  });

  it("strips Hermes model switch adapter notes from rendered user messages", () => {
    expect(
      stripModelSwitchNote(
        "[Note: model was just switched from gpt-5.5 to gpt-5.4-mini via OpenAI Codex. Adjust your self-identification accordingly.] Reply exactly: model picker smoke",
      ),
    ).toBe("Reply exactly: model picker smoke");
  });
});

describe("Iris chat session detail loading", () => {
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

  it("recognizes canonical history when Hermes rewrites the user message id but keeps the client id", () => {
    expect(
      activeRequestCompletedByHistory(
        [
          {
            id: "history-user-1",
            sessionId: "session-1",
            role: "user",
            content: "Hello",
            status: "completed",
            toolName: "",
            timestamp: 1,
            metadata: { idempotencyKey: "client-message-1" },
          },
          {
            id: "assistant-1",
            sessionId: "session-1",
            role: "assistant",
            content: "Done",
            status: "completed",
            toolName: "",
            timestamp: 2,
            metadata: { replyTo: "client-message-1", streaming: false, finalize: true },
          },
        ],
        "client-message-1",
      ),
    ).toBe(true);
  });

  it("recognizes adjacent completed assistant history when Hermes omits reply metadata", () => {
    expect(
      activeRequestCompletedByHistory(
        [
          {
            id: "history-user-1",
            sessionId: "session-1",
            role: "user",
            content: "Hello",
            status: "completed",
            toolName: "",
            timestamp: 1,
            metadata: { clientRequestId: "client-message-1" },
          },
          {
            id: "assistant-1",
            sessionId: "session-1",
            role: "assistant",
            content: "Done",
            status: "completed",
            toolName: "",
            timestamp: 2,
            metadata: { sessionId: "external-session", toolCalls: [] },
          },
        ],
        "client-message-1",
      ),
    ).toBe(true);
  });

  it("does not reconcile when the completed assistant does not reference the active request", () => {
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
    ).toBe(false);
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

  it("does not let a stale detail response retake selection after another session was clicked", () => {
    expect(
      shouldApplySessionDetailSelection(
        "session-b",
        "chat-b",
        "session-a",
        { id: "session-a", chatId: "chat-a" },
      ),
    ).toBe(false);
  });

  it("allows a current detail response to replace an alias with its loaded session id", () => {
    expect(
      shouldApplySessionDetailSelection(
        "session-alias",
        "chat-a",
        "session-alias",
        { id: "session-a", chatId: "chat-a" },
      ),
    ).toBe(true);
  });

  it("reloads completed real sessions even when live messages are already cached", () => {
    expect(shouldSkipSessionDetailLoad("session-1", {})).toBe(false);
  });

  it("keeps active and optimistic sessions on provisional state", () => {
    expect(shouldSkipSessionDetailLoad("session-1", { "session-1": "request-1" })).toBe(true);
    expect(shouldSkipSessionDetailLoad("optimistic-1", {})).toBe(true);
  });
});

function chatSession(overrides: Partial<HermesSession> = {}): HermesSession {
  return {
    id: "session_1",
    source: "iris-core",
    model: "",
    title: "Initial",
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

describe("session metadata propagation after detail refresh", () => {
  it("treats real titles as propagatable and placeholders as not", () => {
    expect(sessionMetadataShouldPropagate("Moon story request")).toBe(true);
    expect(sessionMetadataShouldPropagate("")).toBe(false);
    expect(sessionMetadataShouldPropagate(undefined)).toBe(false);
    expect(sessionMetadataShouldPropagate("Untitled session")).toBe(false);
    expect(sessionMetadataShouldPropagate("New session")).toBe(false);
  });

  it("upserts the loaded title and lastActiveAt onto the matching profile session", () => {
    const stale = chatSession({
      id: "session_real",
      title: "write a story about the moon",
      lastActiveAt: 10,
    });
    const fresh = chatSession({
      id: "session_real",
      title: "Moon story request",
      lastActiveAt: 22,
      preview: "The moon had a secret harbor.",
    });

    const next = upsertSessionMetadataForProfile(
      { default: [stale] },
      "default",
      fresh,
    );

    expect(next.default[0].title).toBe("Moon story request");
    expect(next.default[0].lastActiveAt).toBe(22);
    expect(next.default[0].preview).toBe("The moon had a secret harbor.");
    expect(next.default[0].id).toBe("session_real");
  });

  it("matches by chatId when ids differ across the optimistic-to-real swap", () => {
    const stale = chatSession({
      id: "optimistic-1",
      chatId: "core-chat-1",
      title: "write a story about the moon",
    });
    const fresh = chatSession({
      id: "session_real",
      chatId: "core-chat-1",
      title: "Moon story request",
    });

    const next = upsertSessionMetadataForProfile(
      { default: [stale] },
      "default",
      fresh,
    );

    expect(next.default[0].title).toBe("Moon story request");
    expect(next.default[0].id).toBe("optimistic-1");
  });

  it("is a no-op when no profile session matches", () => {
    const stale = chatSession({ id: "session_other", chatId: "core-chat-9" });
    const current = { default: [stale] };
    const fresh = chatSession({ id: "session_real", chatId: "core-chat-1" });

    const next = upsertSessionMetadataForProfile(current, "default", fresh);

    expect(next).toBe(current);
  });
});

describe("scheduleDedupedTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the callback once after the delay", async () => {
    const pending = new Set<string>();
    const run = vi.fn(() => Promise.resolve());

    const scheduled = scheduleDedupedTimer({
      key: "session_1",
      pending,
      delayMs: 3000,
      run,
    });

    expect(scheduled).toBe(true);
    expect(pending.has("session_1")).toBe(true);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(pending.has("session_1")).toBe(false);
  });

  it("dedupes back-to-back schedule calls for the same key", () => {
    const pending = new Set<string>();
    const run = vi.fn(() => Promise.resolve());

    const first = scheduleDedupedTimer({ key: "session_1", pending, delayMs: 3000, run });
    const second = scheduleDedupedTimer({ key: "session_1", pending, delayMs: 3000, run });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(pending.size).toBe(1);
  });

  it("clears the pending key even if the callback throws", async () => {
    const pending = new Set<string>();
    const run = vi.fn(() => {
      throw new Error("boom");
    });

    scheduleDedupedTimer({ key: "session_1", pending, delayMs: 3000, run });

    await vi.advanceTimersByTimeAsync(3000).catch(() => {});

    expect(pending.has("session_1")).toBe(false);
  });

  it("rejects empty keys", () => {
    const pending = new Set<string>();
    const run = vi.fn();

    const scheduled = scheduleDedupedTimer({ key: "", pending, delayMs: 3000, run });

    expect(scheduled).toBe(false);
    expect(pending.size).toBe(0);
  });
});

describe("reconcileMessages (history-authoritative, no reorder)", () => {
  it("keeps a repeated-message turn in place instead of appending its local copy at the end", () => {
    // Reproduces the long-chat reorder: the two "ok" user rows collided in the
    // overlay, so history can't recover their clientRequestId. The live copies still
    // carry it. The old mergeMessageLists appended them at the end (reorder + dup).
    const history: Message[] = [
      { id: "h-u1", role: "user", content: "first question", clientRequestId: "c1" },
      { id: "h-a1", role: "assistant", content: "first answer", clientRequestId: "c1" },
      { id: "h-u2", role: "user", content: "ok" }, // collision-dropped → no clientRequestId
      { id: "h-a2", role: "assistant", content: "second answer", clientRequestId: "c2" },
      { id: "h-u3", role: "user", content: "ok" }, // collision-dropped → no clientRequestId
      { id: "h-a3", role: "assistant", content: "third answer", clientRequestId: "c3" },
    ];
    const local: Message[] = [
      { id: "l-u1", role: "user", content: "first question", clientRequestId: "c1" },
      { id: "s-a1", role: "assistant", content: "first answer", streamMessageId: "s-a1", clientRequestId: "c1" },
      { id: "l-u2", role: "user", content: "ok", clientRequestId: "c2" },
      { id: "s-a2", role: "assistant", content: "second answer", streamMessageId: "s-a2", clientRequestId: "c2" },
      { id: "l-u3", role: "user", content: "ok", clientRequestId: "c3" },
      { id: "s-a3", role: "assistant", content: "third answer", streamMessageId: "s-a3", clientRequestId: "c3" },
    ];

    // Document the bug in the old merge: the unmatched "ok" copies pile up at the end.
    const oldMerge = mergeMessageLists(history, local);
    expect(oldMerge.map((m) => m.content)).toEqual([
      "first question", "first answer", "ok", "second answer", "ok", "third answer", "ok", "ok",
    ]);

    // The fix: order preserved, no duplicate "ok"s appended.
    const reconciled = reconcileMessages(local, history);
    expect(reconciled.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:first question",
      "assistant:first answer",
      "user:ok",
      "assistant:second answer",
      "user:ok",
      "assistant:third answer",
    ]);
    // Live identity preserved where matched (assistant kept its streamMessageId).
    expect(reconciled.find((m) => m.content === "first answer")?.streamMessageId).toBe("s-a1");
  });

  it("appends a genuinely-new local turn that history hasn't persisted yet", () => {
    const history: Message[] = [
      { id: "h-u1", role: "user", content: "q1", clientRequestId: "c1" },
      { id: "h-a1", role: "assistant", content: "a1", clientRequestId: "c1" },
    ];
    const local: Message[] = [
      { id: "h-u1", role: "user", content: "q1", clientRequestId: "c1" },
      { id: "h-a1", role: "assistant", content: "a1", clientRequestId: "c1" },
      { id: "l-u2", role: "user", content: "q2", clientRequestId: "c2" },
      { id: "s-a2", role: "assistant", content: ASSISTANT_THINKING_TEXT, streaming: true, streamMessageId: "s-a2", clientRequestId: "c2" },
    ];
    const reconciled = reconcileMessages(local, history);
    expect(reconciled.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:q1", "assistant:a1", "user:q2", `assistant:${ASSISTANT_THINKING_TEXT}`,
    ]);
  });

  it("keeps a genuinely-repeated message when history hasn't caught up (count-aware append)", () => {
    // History has one "ok"; locally the user just sent "ok" again (not yet persisted).
    const history: Message[] = [
      { id: "h-u1", role: "user", content: "ok" },
      { id: "h-a1", role: "assistant", content: "sure", clientRequestId: "c1" },
    ];
    const local: Message[] = [
      { id: "l-u1", role: "user", content: "ok", clientRequestId: "c1" },
      { id: "s-a1", role: "assistant", content: "sure", streamMessageId: "s-a1", clientRequestId: "c1" },
      { id: "l-u2", role: "user", content: "ok", clientRequestId: "c2" },
      { id: "s-a2", role: "assistant", content: "sure again", streamMessageId: "s-a2", clientRequestId: "c2" },
    ];
    const reconciled = reconcileMessages(local, history);
    // The first "ok"/"sure" reconcile to history; the second turn (history lacks it) appends.
    expect(reconciled.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:ok", "assistant:sure", "user:ok", "assistant:sure again",
    ]);
  });

  it("is a no-op on session open (empty local) — pure history order", () => {
    const history: Message[] = [
      { id: "h-u1", role: "user", content: "q" },
      { id: "h-a1", role: "assistant", content: "a" },
    ];
    expect(reconcileMessages([], history)).toEqual(history);
  });

  it("keeps event-only turns (slash-command/cron) in chronological place, not reversed after history", () => {
    // The /sethome turn and cron deliveries never enter Hermes history — only the
    // reminder turn does. The transcript must not be reordered to put the history
    // turn first and the older event-only turn at the end.
    const local: Message[] = [
      { id: "u-sethome", role: "user", content: "/sethome", clientRequestId: "c1" },
      { id: "a-sethome", role: "assistant", content: "Home channel set.", clientRequestId: "c1" },
      { id: "u-reminder", role: "user", content: "remind me in 1 minute", clientRequestId: "c2" },
      {
        id: "s-reminder",
        role: "assistant",
        content: "Done — reminding you.",
        streamMessageId: "s-reminder",
        clientRequestId: "c2",
      },
    ];
    // Hermes history holds ONLY the reminder turn (different ids; assistant row's
    // clientRequestId was not recovered).
    const history: Message[] = [
      { id: "h-u-reminder", role: "user", content: "remind me in 1 minute", clientRequestId: "c2" },
      { id: "h-a-reminder", role: "assistant", content: "Done — reminding you." },
    ];

    const reconciled = reconcileMessages(local, history);
    expect(reconciled.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:/sethome",
      "assistant:Home channel set.",
      "user:remind me in 1 minute",
      "assistant:Done — reminding you.",
    ]);

    // The old history-primary merge produced the reversed transcript (reminder first).
    const reversed = mergeMessageLists(history, local);
    expect(reversed[0].content).toBe("remind me in 1 minute");
  });
});
