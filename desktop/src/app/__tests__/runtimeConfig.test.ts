import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultRuntimeConfig,
  loadRuntimeConfig,
  resolveCoreApiUrl,
  saveRuntimeConfig,
} from "../runtimeConfig";

function installStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
}

describe("runtimeConfig", () => {
  beforeEach(() => {
    installStorage();
  });

  it("falls back to local runtime defaults for empty storage", () => {
    expect(loadRuntimeConfig()).toEqual(defaultRuntimeConfig);
  });

  it("normalizes unsupported connection modes back to local", () => {
    localStorage.setItem(
      "hermes.desktop.runtime",
      JSON.stringify({ connectionMode: "browser", remoteUrl: "https://agent.example.com" }),
    );

    expect(loadRuntimeConfig()).toMatchObject({
      connectionMode: "local",
      remoteUrl: "https://agent.example.com",
    });
  });

  it("normalizes the Core API URL default", () => {
    localStorage.setItem("hermes.desktop.runtime", JSON.stringify({ coreApiUrl: "" }));

    expect(loadRuntimeConfig().coreApiUrl).toBe("http://127.0.0.1:8765");
    expect(resolveCoreApiUrl(loadRuntimeConfig())).toBe("http://127.0.0.1:8765");
  });

  it("migrates the old management route into the Core API URL", () => {
    localStorage.setItem(
      "hermes.desktop.runtime",
      JSON.stringify({ managementApiUrl: " http://127.0.0.1:8766/v1 " }),
    );

    expect(loadRuntimeConfig().coreApiUrl).toBe("http://127.0.0.1:8766");
  });

  it("migrates the first old profile sidecar route into the Core API URL", () => {
    const legacyProfileRoutesKey = ["profile", "Sidecar", "Urls"].join("");
    localStorage.setItem(
      "hermes.desktop.runtime",
      JSON.stringify({ [legacyProfileRoutesKey]: { Health: " http://127.0.0.1:8767/v1 " } }),
    );

    expect(loadRuntimeConfig().coreApiUrl).toBe("http://127.0.0.1:8767");
  });

  it("persists runtime settings without credential material or runtime routes", () => {
    saveRuntimeConfig({
      ...defaultRuntimeConfig,
      connectionMode: "remote",
      remoteUrl: "https://agent.example.com",
      coreApiUrl: "http://agent.example.com:8765/v1",
    });

    const stored = JSON.parse(localStorage.getItem("hermes.desktop.runtime") || "{}");
    expect(stored).toEqual({
      connectionMode: "remote",
      provider: "",
      model: "",
      remoteUrl: "https://agent.example.com",
      coreApiUrl: "http://agent.example.com:8765",
    });
    expect(stored.remoteToken).toBeUndefined();
  });
});
