import { describe, expect, it } from "vitest";
import { projectKeys, sessionKeys } from "../index";

describe("shared query keys", () => {
  it("keeps project list keys stable", () => {
    expect(projectKeys.list("core-a")).toEqual(["projects", "core-a", "list"]);
  });

  it("keeps session detail keys stable", () => {
    expect(sessionKeys.detail("core-a", "session_1")).toEqual(["sessions", "core-a", "detail", "session_1"]);
  });
});
