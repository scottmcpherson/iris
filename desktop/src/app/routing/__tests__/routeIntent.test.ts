import { describe, expect, it } from "vitest";
import {
  isAgentDetailSection,
  parseIrisDeepLink,
  routeIntentToPath,
  routeIntentToUrl,
  routePathToIntent,
  viewForRouteIntent,
} from "../routeIntent";

describe("route intents", () => {
  it("maps durable app routes to view names", () => {
    expect(viewForRouteIntent({ type: "new-chat" })).toBe("chat");
    expect(viewForRouteIntent({ type: "chat", sessionId: "session_123" })).toBe("chat");
    expect(viewForRouteIntent({ type: "agents" })).toBe("agents");
    expect(viewForRouteIntent({ type: "automations" })).toBe("jobs");
    expect(viewForRouteIntent({ type: "settings" })).toBe("settings");
  });

  it("serializes chat and project chat route intents", () => {
    expect(routeIntentToUrl({ type: "new-chat", profile: "research" })).toBe("/chat/new?profile=research");
    expect(routeIntentToUrl({ type: "chat", sessionId: "session_abc", profile: "default" })).toBe(
      "/chat/session_abc?profile=default",
    );
    expect(
      routeIntentToUrl({
        type: "chat",
        projectId: "project_123",
        sessionId: "session_abc",
        profile: "research",
      }),
    ).toBe("/projects/project_123/chat/session_abc?profile=research");
  });

  it("parses route paths into intents", () => {
    expect(routePathToIntent("/chat/new", { profile: "research" })).toEqual({
      type: "new-chat",
      profile: "research",
    });
    expect(routePathToIntent("/projects/project_123/chat/session_abc", new URLSearchParams("profile=research"))).toEqual({
      type: "chat",
      projectId: "project_123",
      sessionId: "session_abc",
      profile: "research",
    });
    expect(routePathToIntent("/automations", new URLSearchParams("project=project_123"))).toEqual({
      type: "automations",
      projectId: "project_123",
    });
  });

  it("validates agent detail sections and normalizes unknown sections", () => {
    expect(isAgentDetailSection("memory")).toBe(true);
    expect(isAgentDetailSection("unknown")).toBe(false);
    expect(routePathToIntent("/agents/default/memory")).toEqual({
      type: "agents",
      profile: "default",
      section: "memory",
    });
    expect(routePathToIntent("/agents/default/nope")).toEqual({
      type: "agents",
      profile: "default",
      section: "overview",
    });
  });

  it("rejects unknown internal routes", () => {
    expect(routePathToIntent("/unknown")).toBeNull();
    expect(routePathToIntent("/chat")).toBeNull();
    expect(routePathToIntent("/projects/project_123")).toBeNull();
  });

  it("keeps navigation targets split into path and search", () => {
    expect(routeIntentToPath({ type: "automations", projectId: "project_123" })).toEqual({
      to: "/automations",
      search: { project: "project_123" },
    });
  });
});

describe("deep-link parsing", () => {
  it("parses custom scheme desktop links", () => {
    expect(parseIrisDeepLink("iris://chat/session_abc?profile=default")).toEqual({
      type: "chat",
      sessionId: "session_abc",
      profile: "default",
    });
    expect(parseIrisDeepLink("iris://projects/project_123/chat/new?profile=research")).toEqual({
      type: "new-chat",
      projectId: "project_123",
      profile: "research",
    });
    expect(parseIrisDeepLink("iris://agents/default/memory")).toEqual({
      type: "agents",
      profile: "default",
      section: "memory",
    });
    expect(parseIrisDeepLink("iris://settings")).toEqual({ type: "settings" });
  });

  it("parses mobile-ready universal link shapes", () => {
    expect(parseIrisDeepLink("https://iris.app/open/chat/session_abc?profile=default")).toEqual({
      type: "chat",
      sessionId: "session_abc",
      profile: "default",
    });
    expect(parseIrisDeepLink("https://iris.app/open/projects/project_123/chat/session_abc")).toEqual({
      type: "chat",
      projectId: "project_123",
      sessionId: "session_abc",
    });
  });

  it("rejects unsupported schemes and hosts", () => {
    expect(parseIrisDeepLink("https://example.com/open/settings")).toBeNull();
    expect(parseIrisDeepLink("file:///settings")).toBeNull();
    expect(parseIrisDeepLink("not a url")).toBeNull();
  });
});
