import { describe, expect, it } from "vitest";
import config from "../../../src-tauri/tauri.conf.json";

describe("Tauri desktop configuration", () => {
  it("allows Core-hosted attachment previews to render as images", () => {
    const csp = config.app.security.csp;

    expect(csp).toContain("img-src");
    expect(csp).toContain("http://127.0.0.1:*");
    expect(csp).toContain("http://localhost:*");
  });
});
