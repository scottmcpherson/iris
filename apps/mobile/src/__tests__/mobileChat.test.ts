import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@iris/chat-core";
import type { IrisCoreEvent } from "@iris/core-client";
import { mergeMobileChatEvent, mobileChatEventInfo, mobileSendMetadata } from "../chat/mobileChat";

function assistantEvent(overrides: Partial<IrisCoreEvent> = {}): IrisCoreEvent {
  return {
    cursor: 2,
    id: "event_1",
    sessionId: "session_1",
    agentId: "agent_1",
    runtimeId: "runtime_1",
    type: "message.assistant.completed",
    role: "assistant",
    content: "Done",
    parentEventId: "request_1",
    externalMessageId: "assistant_1",
    createdAt: 1,
    metadata: { clientRequestId: "request_1" },
    ...overrides,
  };
}

describe("mobile chat helpers", () => {
  it("merges completion events and reports request completion", () => {
    const messages: ChatMessage[] = [
      { id: "request_1", role: "user", content: "Hi", clientRequestId: "request_1" },
      { id: "request_1-assistant", role: "assistant", content: "", streaming: true, clientRequestId: "request_1" },
    ];

    const result = mergeMobileChatEvent(messages, assistantEvent());

    expect(result.requestFinished).toBe(true);
    expect(result.messages[1]).toMatchObject({ content: "Done", streaming: false });
  });

  it("treats assistant error events as terminal error messages", () => {
    const messages: ChatMessage[] = [
      { id: "request_1", role: "user", content: "Hi", clientRequestId: "request_1" },
      { id: "request_1-assistant", role: "assistant", content: "", streaming: true, clientRequestId: "request_1" },
    ];

    const result = mergeMobileChatEvent(
      messages,
      assistantEvent({
        type: "message.assistant.error",
        content: "",
        metadata: { clientRequestId: "request_1", error: "No route" },
      }),
    );

    expect(result.requestFinished).toBe(true);
    expect(result.messages[1]).toMatchObject({
      content: "Assistant stream failed: No route",
      streaming: false,
    });
  });

  it("uses streamMessageId for final assistant stream events", () => {
    const messages: ChatMessage[] = [
      { id: "request_1", role: "user", content: "Hi", clientRequestId: "request_1" },
      { id: "request_1-assistant", role: "assistant", content: "", streaming: true, clientRequestId: "request_1" },
    ];

    const result = mergeMobileChatEvent(
      messages,
      assistantEvent({
        id: "event_stream_final",
        externalMessageId: "stream_1:edit:2",
        content: "Done",
        metadata: {
          clientRequestId: "request_1",
          streamMessageId: "stream_1",
          streaming: false,
          finalize: true,
        },
      }),
    );

    expect(result.requestFinished).toBe(true);
    expect(result.deliveryId).toBe("stream_1:edit:2");
    expect(result.messages[1]).toMatchObject({
      id: "stream_1",
      streamMessageId: "stream_1",
      content: "Done",
      streaming: false,
    });
  });

  it("does not duplicate visible text when a live stream event replays cumulative content", () => {
    const messages: ChatMessage[] = [
      { id: "request_1", role: "user", content: "Hi", clientRequestId: "request_1" },
      {
        id: "stream_1",
        role: "assistant",
        content: "This mobile answer starts",
        streaming: true,
        streamMessageId: "stream_1",
        clientRequestId: "request_1",
      },
    ];

    const result = mergeMobileChatEvent(
      messages,
      assistantEvent({
        id: "event_stream_2",
        externalMessageId: "stream_1:edit:2",
        content: "This mobile answer starts and continues once.",
        metadata: {
          clientRequestId: "request_1",
          streamMessageId: "stream_1",
          streaming: true,
          finalize: false,
          chunkOperation: "append",
        },
        type: "message.assistant.delta",
      }),
    );

    expect(result.messages[1]).toMatchObject({
      content: "This mobile answer starts and continues once.",
      streaming: true,
    });
  });

  it("exposes stable delivery info for deduping before merge", () => {
    expect(mobileChatEventInfo(assistantEvent({
      externalMessageId: "stream_1:edit:1",
      metadata: { clientRequestId: "request_1", streamMessageId: "stream_1" },
      type: "message.assistant.delta",
    }))).toMatchObject({
      clientRequestId: "request_1",
      deliveryId: "stream_1:edit:1",
      requestFinished: false,
      streamMessageId: "stream_1",
    });
  });

  it("adds model switch metadata only when the selected model differs", () => {
    expect(mobileSendMetadata({
      clientRequestId: "request_1",
      source: "iris-mobile",
      selectedModel: { provider: "openrouter", model: "gpt-5.5" },
      currentModel: { provider: "openrouter", model: "gpt-5.4" },
    })).toMatchObject({
      clientRequestId: "request_1",
      source: "iris-mobile",
      modelSwitch: { provider: "openrouter", model: "gpt-5.5" },
    });

    expect(mobileSendMetadata({
      clientRequestId: "request_1",
      source: "iris-mobile",
      selectedModel: { provider: "openrouter", model: "gpt-5.5" },
      currentModel: { provider: "openrouter", model: "gpt-5.5" },
    })).not.toHaveProperty("modelSwitch");
  });
});
