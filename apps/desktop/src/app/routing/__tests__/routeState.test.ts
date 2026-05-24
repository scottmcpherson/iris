import { describe, expect, it } from "vitest";
import { shouldResetSelectionForNewChatRoute } from "../routeState";

describe("route-driven chat selection state", () => {
  it("clears the current selection only when navigation reaches the new-chat route", () => {
    expect(
      shouldResetSelectionForNewChatRoute({
        routeChanged: true,
        selectedSessionId: "session_123",
      }),
    ).toBe(true);
    expect(
      shouldResetSelectionForNewChatRoute({
        routeChanged: false,
        selectedSessionId: "optimistic-message-1",
      }),
    ).toBe(false);
    expect(
      shouldResetSelectionForNewChatRoute({
        routeChanged: true,
        selectedSessionId: null,
      }),
    ).toBe(false);
  });
});
