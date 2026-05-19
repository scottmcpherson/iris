import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateCoreConnection,
  defaultRuntimeConfig,
  loadRuntimeConfig,
  managedLocalConnectionId,
  resolveCoreApiUrl,
  saveRuntimeConfig,
  upsertCoreConnection,
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

  it("creates a managed-local profile for empty storage", () => {
    const config = loadRuntimeConfig();
    expect(config).toEqual(defaultRuntimeConfig);
    expect(config.connectionMode).toBe("managed-local");
    expect(config.activeConnectionId).toBe(managedLocalConnectionId);
    expect(resolveCoreApiUrl(config)).toBe("http://127.0.0.1:8765");
  });

  it("ignores old hermes.desktop.runtime values", () => {
    localStorage.setItem(
      "hermes.desktop.runtime",
      JSON.stringify({ connectionMode: "remote", coreApiUrl: "http://agent.example.com:8765" }),
    );

    expect(loadRuntimeConfig()).toEqual(defaultRuntimeConfig);
  });

  it("falls back to fresh managed-local config for invalid v2 modes", () => {
    localStorage.setItem(
      "iris.desktop.runtime.v2",
      JSON.stringify({
        connectionMode: "browser",
        activeConnectionId: "bad",
        coreConnections: [{ id: "bad", name: "Bad", mode: "browser", effectiveCoreApiUrl: "http://127.0.0.1:9999" }],
      }),
    );

    expect(loadRuntimeConfig()).toEqual(defaultRuntimeConfig);
  });

  it("strips /v1 from effective profile URLs", () => {
    const config = upsertCoreConnection(defaultRuntimeConfig, {
      id: "manual_dev",
      name: "Dev Core",
      mode: "manual-url",
      effectiveCoreApiUrl: "http://127.0.0.1:8766/v1",
      manual: { url: "http://127.0.0.1:8766/v1", requiresToken: true },
    }, { activate: true });

    expect(resolveCoreApiUrl(config)).toBe("http://127.0.0.1:8766");
  });

  it("persists v2 runtime settings without credential material", () => {
    const config = upsertCoreConnection(defaultRuntimeConfig, {
      id: "tailscale_mac_mini",
      name: "Mac mini",
      mode: "tailscale",
      effectiveCoreApiUrl: "http://mac-mini.tailnet.ts.net:8765",
      tailscale: { host: "mac-mini.tailnet.ts.net", port: 8765, requiresToken: true },
    }, { activate: true });

    saveRuntimeConfig({
      ...config,
      provider: "openai",
      model: "gpt-5.5",
    } as typeof config);

    const stored = JSON.parse(localStorage.getItem("iris.desktop.runtime.v2") || "{}");
    expect(stored.connectionMode).toBe("tailscale");
    expect(stored.activeConnectionId).toBe("tailscale_mac_mini");
    expect(stored.coreConnections[1]).toMatchObject({
      id: "tailscale_mac_mini",
      effectiveCoreApiUrl: "http://mac-mini.tailnet.ts.net:8765",
    });
    expect(JSON.stringify(stored)).not.toContain("secret");
    expect(stored.remoteToken).toBeUndefined();
  });

  it("activates saved profiles by id", () => {
    const config = upsertCoreConnection(defaultRuntimeConfig, {
      id: "manual_dev",
      name: "Dev Core",
      mode: "manual-url",
      effectiveCoreApiUrl: "http://127.0.0.1:8777",
      manual: { url: "http://127.0.0.1:8777", requiresToken: false },
    });

    const active = activateCoreConnection(config, "manual_dev");

    expect(active.connectionMode).toBe("manual-url");
    expect(resolveCoreApiUrl(active)).toBe("http://127.0.0.1:8777");
  });
});
