import { describe, expect, it } from "vitest";
import { agentKeys, modelKeys, projectKeys, sessionKeys, slashCommandKeys } from "../index";

describe("shared query keys", () => {
  it("keeps project list keys stable", () => {
    expect(projectKeys.list("core-a")).toEqual(["projects", "core-a", "list"]);
  });

  it("keeps session detail keys stable", () => {
    expect(sessionKeys.detail("core-a", "session_1")).toEqual(["sessions", "core-a", "detail", "session_1"]);
  });

  it("keeps composer support keys stable", () => {
    expect(agentKeys.list("core-a")).toEqual(["agents", "core-a", "list"]);
    expect(modelKeys.catalog("core-a", "agent_1")).toEqual(["models", "core-a", "catalog", "agent_1"]);
    expect(slashCommandKeys.catalog("core-a", "agent_1")).toEqual(["slashCommands", "core-a", "catalog", "agent_1"]);
  });
});
