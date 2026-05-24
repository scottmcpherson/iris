import { describe, expect, it } from "vitest";
import { irisNativeTheme } from "../index";

describe("Iris theme", () => {
  it("exposes native screen and text colors", () => {
    expect(irisNativeTheme.colors.screen).toBe(irisNativeTheme.colors.background);
    expect(irisNativeTheme.colors.text).toBe(irisNativeTheme.colors.foreground);
  });
});
