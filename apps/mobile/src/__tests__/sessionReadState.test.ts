import { afterEach, describe, expect, it, vi } from "vitest";
import type { IrisCoreSession } from "@iris/core-client";
import { mobileReadState, mobileSessionShowsUnread } from "../chat/sessionReadState";

function session(overrides: Partial<IrisCoreSession> = {}): IrisCoreSession {
  return {
    agentId: "agent_default",
    createdAt: 1,
    externalChatId: "",
    externalSessionId: "",
    id: "session_1",
    metadata: {},
    origin: {},
    runtimeId: "runtime_default",
    runtimeProfile: "default",
    summary: "",
    title: "Session",
    updatedAt: 1,
    ...overrides,
  };
}

describe("mobile session read state", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not show unread for the selected session", () => {
    const unreadSession = session({
      readState: {
        sessionId: "session_1",
        state: "unread",
        createdAt: 10,
        updatedAt: 20,
      },
    });

    expect(mobileSessionShowsUnread(unreadSession, false)).toBe(true);
    expect(mobileSessionShowsUnread(unreadSession, true)).toBe(false);
  });

  it("preserves existing read-state metadata when marking a mobile session read", () => {
    vi.setSystemTime(new Date("2026-05-25T12:00:00Z"));

    expect(mobileReadState(
      "session_1",
      {
        sessionId: "session_1",
        state: "unread",
        createdAt: 10,
        updatedAt: 20,
        metadata: { eventCursor: 7 },
      },
      { reason: "active-delivery" },
    )).toEqual({
      sessionId: "session_1",
      state: "read",
      createdAt: 10,
      updatedAt: 1779710400,
      metadata: {
        eventCursor: 7,
        reason: "active-delivery",
      },
    });
  });
});
