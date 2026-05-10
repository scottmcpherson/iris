import type { AgentUICoreEvent } from "../../lib/agentuiCore";
import type { HermesInboxMessage } from "../../types/hermes";
import { booleanMetadata } from "./chatHistory";

export function parseCoreEvent(data: string): AgentUICoreEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const event = parsed as Partial<AgentUICoreEvent>;
    if (typeof event.cursor !== "number" || typeof event.type !== "string") return null;
    return event as AgentUICoreEvent;
  } catch {
    return null;
  }
}

export function runtimeChatId(runtime: Record<string, unknown> | undefined) {
  const value = runtime?.chatId;
  return typeof value === "string" ? value : "";
}

export function streamDeliveryFinalized(metadata: Record<string, unknown>) {
  return booleanMetadata(metadata, "finalize") === true || booleanMetadata(metadata, "streaming") === false;
}

export function dedupeInboxDeliveries(deliveries: HermesInboxMessage[]) {
  const byId = new Map<string, HermesInboxMessage>();
  for (const delivery of deliveries) {
    byId.set(delivery.id, delivery);
  }
  return Array.from(byId.values()).sort((left, right) => left.cursor - right.cursor);
}
