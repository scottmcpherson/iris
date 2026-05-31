import type { HermesInboxMessage } from "../../types/hermes";
import { booleanMetadata } from "./chatHistory";

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

export function shouldApplyDeliveryReadState(
  delivery: Pick<HermesInboxMessage, "createdAt">,
  consumerStartedAt: number,
) {
  return !delivery.createdAt || delivery.createdAt >= consumerStartedAt;
}
