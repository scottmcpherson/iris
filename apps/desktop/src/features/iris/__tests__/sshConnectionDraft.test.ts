import { describe, expect, it } from "vitest";
import { defaultSshPort } from "../../../app/runtimeConfig";
import {
  parsePort,
  parseSshHostname,
  sshProfileFromDraft,
  sshTargetLabel,
  sshTunnelConfigFromDraft,
  type SshDraft,
} from "../sshConnectionDraft";

describe("sshConnectionDraft", () => {
  it("parses SSH endpoints with optional users", () => {
    expect(parseSshHostname("agent@example.local")).toEqual({ user: "agent", host: "example.local" });
    expect(parseSshHostname("example.local")).toEqual({ user: "", host: "example.local" });
    expect(parseSshHostname("agent@nested@example.local")).toEqual({ user: "agent@nested", host: "example.local" });
    expect(sshTargetLabel("agent", "example.local")).toBe("agent@example.local");
  });

  it("falls back to valid ports only", () => {
    expect(parsePort("2200", defaultSshPort)).toBe(2200);
    expect(parsePort("0", defaultSshPort)).toBe(defaultSshPort);
    expect(parsePort("70000", defaultSshPort)).toBe(defaultSshPort);
  });

  it("builds OS-neutral SSH tunnel configs and profiles", () => {
    const draft: SshDraft = {
      id: "",
      name: "",
      hostname: "agent@example.local",
      port: "",
      authMode: "identity",
      identityFile: "~/.ssh/id_ed25519",
    };

    const tunnelConfig = sshTunnelConfigFromDraft(draft);
    const profile = sshProfileFromDraft(draft, {
      localPort: 51234,
      effectiveCoreApiUrl: "http://127.0.0.1:51234",
    });

    expect(tunnelConfig).toMatchObject({
      user: "agent",
      host: "example.local",
      port: defaultSshPort,
      identityFile: "~/.ssh/id_ed25519",
      autoStartRemoteCore: false,
    });
    expect(profile).toMatchObject({
      name: "example.local",
      mode: "ssh",
      effectiveCoreApiUrl: "http://127.0.0.1:51234",
      ssh: {
        user: "agent",
        host: "example.local",
        localForwardPort: 51234,
        autoStartRemoteCore: false,
      },
    });
  });
});
