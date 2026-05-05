import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultRuntimeConfig,
  loadRuntimeConfig,
  resolveManagementApiUrl,
  resolveRuntimeApiUrl,
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

  it("migrates the old gateway runtime back to local API", () => {
    localStorage.setItem(
      "hermes.desktop.runtime",
      JSON.stringify({ connectionMode: "gateway", gatewayUrl: "http://127.0.0.1:8765" }),
    );

    expect(loadRuntimeConfig()).toMatchObject({
      connectionMode: "local",
      gatewayUrl: "http://127.0.0.1:8765",
    });
  });

  it("normalizes the management API URL default", () => {
    localStorage.setItem("hermes.desktop.runtime", JSON.stringify({ managementApiUrl: "" }));

    expect(loadRuntimeConfig().managementApiUrl).toBe("http://127.0.0.1:8765");
    expect(resolveManagementApiUrl(loadRuntimeConfig())).toBe("http://127.0.0.1:8765");
  });

  it("normalizes per-profile API routes", () => {
    localStorage.setItem(
      "hermes.desktop.runtime",
      JSON.stringify({
        profileApiUrls: {
          Health: " http://127.0.0.1:8643/v1 ",
          Empty: "",
          Broken: 42,
        },
        profileSidecarUrls: {
          Health: " http://127.0.0.1:8766/v1 ",
          Empty: "",
          Broken: 42,
        },
      }),
    );

    expect(loadRuntimeConfig().profileApiUrls).toEqual({
      Health: "http://127.0.0.1:8643",
    });
    expect(loadRuntimeConfig().profileSidecarUrls).toEqual({
      Health: "http://127.0.0.1:8766",
    });
    expect(resolveManagementApiUrl(loadRuntimeConfig(), "Health")).toBe("http://127.0.0.1:8766");
  });

  it("persists runtime settings without credential material", () => {
    saveRuntimeConfig({
      ...defaultRuntimeConfig,
      connectionMode: "remote",
      remoteUrl: "https://agent.example.com",
      managementApiUrl: "http://agent.example.com:8765",
      profileApiUrls: {
        default: "http://127.0.0.1:8642",
        Empty: "",
      },
      profileSidecarUrls: {
        default: "http://127.0.0.1:8765",
        Empty: "",
      },
    });

    const stored = JSON.parse(localStorage.getItem("hermes.desktop.runtime") || "{}");
    expect(stored).toMatchObject({
      connectionMode: "remote",
      remoteUrl: "https://agent.example.com",
      managementApiUrl: "http://agent.example.com:8765",
      profileApiUrls: { default: "http://127.0.0.1:8642" },
      profileSidecarUrls: { default: "http://127.0.0.1:8765" },
    });
    expect(stored.remoteToken).toBeUndefined();
  });

  it("resolves only the selected profile API URL", () => {
    expect(
      resolveRuntimeApiUrl(
        {
          ...defaultRuntimeConfig,
          connectionMode: "remote",
          remoteUrl: "https://agent.example.com/v1",
          gatewayUrl: "http://127.0.0.1:8642/v1",
          profileApiUrls: {
            Health: "http://127.0.0.1:8643",
          },
        },
        "Health",
      ),
    ).toBe("http://127.0.0.1:8643");

    expect(
      resolveRuntimeApiUrl(
        {
          ...defaultRuntimeConfig,
          connectionMode: "remote",
          remoteUrl: "https://agent.example.com/v1",
          gatewayUrl: "http://127.0.0.1:8642/v1",
        },
        "default",
      ),
    ).toBe("");
  });
});
