import { describe, expect, it } from "vitest";
import config from "../../../src-tauri/tauri.conf.json";
import devConfig from "../../../src-tauri/tauri.dev.conf.json";

describe("Tauri desktop configuration", () => {
  it("allows Core-hosted attachment previews to render as images", () => {
    const csp = config.app.security.csp;

    expect(csp).toContain("img-src");
    expect(csp).toContain("http://127.0.0.1:*");
    expect(csp).toContain("http://localhost:*");
  });

  it("uses the root generated Tauri icon set for dev desktop runs", () => {
    expect(devConfig.productName).toBe("Iris Dev");
    expect(devConfig.bundle.icon).toContain("../../icons/tauri-icons/icon.icns");
    expect(config.bundle.icon).toContain("icons/icon.icns");
  });
});
