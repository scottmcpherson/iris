import { describe, expect, it } from "vitest";
import { normalizeProfileName, profileNameError } from "../profileNames";

describe("profileNames", () => {
  it("normalizes mixed-case names before Core submission", () => {
    expect(normalizeProfileName(" Research_Team ")).toBe("research_team");
  });

  it("rejects invalid and reserved Hermes profile names", () => {
    expect(profileNameError("Research.Team")).toContain("lowercase");
    expect(profileNameError("sudo")).toContain("reserved");
    expect(profileNameError("default")).toContain("built-in");
    expect(profileNameError("default", { allowDefault: true })).toBe("");
  });
});
