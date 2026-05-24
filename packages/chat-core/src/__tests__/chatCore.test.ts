import { describe, expect, it } from "vitest";
import {
  appendOptimisticSend,
  mergeCompletedDelivery,
  mergeErrorDelivery,
  mergeStreamDelivery,
  parseCoreEvent,
  replaceOptimisticSend,
  type DeliveryMessage,
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

  it("finalizes completed deliveries", () => {
    const optimistic = appendOptimisticSend([], "Hi", "request_1");
    const completed = mergeCompletedDelivery(optimistic.messages, delivery({ id: "event_done", content: "Done" }));
    expect(completed[1]).toMatchObject({ content: "Done", streaming: false });
  });

  it("appends error deliveries to active assistant messages", () => {
    const optimistic = appendOptimisticSend([], "Hi", "request_1");
    const failed = mergeErrorDelivery(optimistic.messages, delivery({ content: "", metadata: { clientRequestId: "request_1", error: "No route" } }));
    expect(failed[1].content).toBe("Assistant stream failed: No route");
    expect(failed[1].streaming).toBe(false);
  });
});
