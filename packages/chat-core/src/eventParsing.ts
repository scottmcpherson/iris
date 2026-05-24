import type { DeliveryMessage, IrisCoreEvent } from "./types";
import { booleanMetadata } from "./history";

export function parseCoreEvent(data: string): IrisCoreEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const event = parsed as Partial<IrisCoreEvent>;
    if (typeof event.cursor !== "number" || typeof event.type !== "string") return null;
    return event as IrisCoreEvent;
  } catch {
    return null;
  }
}

export function coreEventToDeliveryMessage(event: IrisCoreEvent, fallbackProfile = "default"): DeliveryMessage {
  const metadata = event.metadata || {};
  return {
    cursor: event.cursor,
    id: event.externalMessageId || event.id,
    source: String(metadata.source || "iris-core-events"),
    platform: "iris",
    profile: String(metadata.profile || fallbackProfile),
    chatId: String(metadata.chatId || event.sessionId),
    content: event.content,
    metadata: {
      ...metadata,
      eventType: event.type,
      replyTo: metadata.replyTo || event.parentEventId || undefined,
    },
    createdAt: event.createdAt,
    acknowledgedAt: null,
  };
}

export function streamDeliveryFinalized(metadata: Record<string, unknown>) {
  return booleanMetadata(metadata, "finalize") === true || booleanMetadata(metadata, "streaming") === false;
}

export function dedupeInboxDeliveries(deliveries: DeliveryMessage[]) {
  const byId = new Map<string, DeliveryMessage>();
  for (const delivery of deliveries) {
    byId.set(delivery.id, delivery);
  }
  return Array.from(byId.values()).sort((left, right) => left.cursor - right.cursor);
}
