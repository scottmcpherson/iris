import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  activateCoreConnection,
  connectionIdFromParts,
  defaultCorePort,
  managedLocalConnectionId,
  removeCoreConnection,
  upsertCoreConnection,
} from "../../app/runtimeConfig";
import { coreRequest } from "../../lib/coreTransport";
import type { HermesRuntimeConfig, IrisCoreConnectionProfile } from "../../types/hermes";

export type TailscaleNode = {
  hostName: string;
  dnsName: string;
  os: string;
  tailscaleIps: string[];
  online: boolean;
};

export type TailscaleStatus = {
  installed: boolean;
  backendState: string;
  running: boolean;
  magicDnsSuffix: string;
  selfNode: TailscaleNode | null;
  peers: TailscaleNode[];
  error: string;
};

export type IrisProbeResult = { ok: boolean; version: string };

export type ProbeState = IrisProbeResult | "checking";

export type TailscaleConnectResult = {
  ok: boolean;
  profile?: IrisCoreConnectionProfile;
  error?: string;
};

type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type UseTailscaleConnectionManagerOptions = {
  runtimeConfig: HermesRuntimeConfig;
  onRuntimeChange: (config: HermesRuntimeConfig) => void;
  onRefresh?: () => void;
  toastResults?: boolean;
  invokeCommand?: InvokeCommand;
};

/** The reachable address for a tailnet node — MagicDNS name preferred, 100.x IP as fallback. */
export function nodeAddress(node: TailscaleNode): { magicDnsName?: string; tailscaleIp?: string } {
  const tailscaleIp = node.tailscaleIps.find((ip) => !ip.includes(":")) || node.tailscaleIps[0];
  return { magicDnsName: node.dnsName || undefined, tailscaleIp: tailscaleIp || undefined };
}

export function nodeKey(node: TailscaleNode) {
  return node.dnsName || node.tailscaleIps[0] || node.hostName;
}

export function useTailscaleConnectionManager({
  runtimeConfig,
  onRuntimeChange,
  onRefresh,
  toastResults = true,
  invokeCommand = invoke,
}: UseTailscaleConnectionManagerOptions) {
  const [status, setStatus] = useState<TailscaleStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [probes, setProbes] = useState<Record<string, IrisProbeResult | "checking">>({});
  const [busyHost, setBusyHost] = useState("");
  const [lastError, setLastError] = useState("");

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    setLastError("");
    try {
      const next = await invokeCommand<TailscaleStatus>("tailscale_status");
      setStatus(next);
      setProbes({});
      return next;
    } catch (error) {
      const fallback: TailscaleStatus = {
        installed: false,
        backendState: "",
        running: false,
        magicDnsSuffix: "",
        selfNode: null,
        peers: [],
        error: error instanceof Error ? error.message : "Could not read Tailscale status.",
      };
      setStatus(fallback);
      return fallback;
    } finally {
      setStatusLoading(false);
    }
  }, [invokeCommand]);

  const probeHost = useCallback(
    async (node: TailscaleNode, port = defaultCorePort) => {
      const { magicDnsName, tailscaleIp } = nodeAddress(node);
      const host = magicDnsName || tailscaleIp;
      if (!host) return;
      setProbes((prev) => ({ ...prev, [nodeKey(node)]: "checking" }));
      try {
        const result = await invokeCommand<IrisProbeResult>("tailscale_probe_iris", { host, port });
        setProbes((prev) => ({ ...prev, [nodeKey(node)]: result }));
        return result;
      } catch {
        setProbes((prev) => ({ ...prev, [nodeKey(node)]: { ok: false, version: "" } }));
      }
    },
    [invokeCommand],
  );

  const connectToHost = useCallback(
    async (args: {
      hostLabel: string;
      magicDnsName?: string;
      tailscaleIp?: string;
      corePort?: number;
      code: string;
    }): Promise<TailscaleConnectResult> => {
      const host = args.magicDnsName || args.tailscaleIp;
      const corePort = args.corePort || defaultCorePort;
      const key = host || args.hostLabel;
      setBusyHost(key);
      setLastError("");
      try {
        if (!host) {
          return fail("This device has no reachable Tailscale address.");
        }
        if (!normalizePairingCode(args.code)) {
          return fail("Enter the pairing code shown on the host.");
        }
        const hostUrl = `http://${bracketHost(host)}:${corePort}`;
        const token = createDeviceToken();
        const tokenHash = await deviceTokenHash(token);

        // /v1/mobile/pair is unauthenticated; route it through the target host directly.
        const pairResult = await coreRequest<{ device?: { id?: string } }>(
          pairingRuntime(hostUrl),
          "POST",
          "/mobile/pair",
          {
            code: args.code,
            deviceName: deviceName(),
            deviceTokenHash: tokenHash,
            metadata: { source: "iris-desktop" },
          },
          { timeoutMs: 8000 },
        );
        if (!pairResult.ok) {
          return fail(pairResult.error || "Pairing failed. Check the code and try again.");
        }

        // Verify the issued token works against the authenticated health endpoint.
        const health = await coreRequest<{ version?: string }>(
          pairingRuntime(hostUrl, token),
          "GET",
          "/health",
          undefined,
          { timeoutMs: 8000 },
        );
        if (!health.ok) {
          return fail(health.error || "Paired, but the host's Iris Core did not respond.");
        }

        const profile = tailscaleProfile({ ...args, host, corePort, deviceToken: token });
        onRuntimeChange(upsertCoreConnection(runtimeConfig, profile, { activate: true }));
        if (toastResults) toast.success(`Connected to ${profile.name} over Tailscale.`);
        return { ok: true, profile };
      } catch (error) {
        return fail(error instanceof Error ? error.message : "Could not connect over Tailscale.");
      } finally {
        setBusyHost("");
      }
    },
    [onRuntimeChange, runtimeConfig, toastResults],
  );

  const disconnect = useCallback(
    (connectionId: string) => {
      const next = removeCoreConnection(
        activateCoreConnection(runtimeConfig, managedLocalConnectionId),
        connectionId,
      );
      onRuntimeChange(next);
      onRefresh?.();
      if (toastResults) toast.success("Disconnected from the Tailscale host.");
    },
    [onRefresh, onRuntimeChange, runtimeConfig, toastResults],
  );

  function fail(error: string): TailscaleConnectResult {
    setLastError(error);
    if (toastResults) toast.error(error);
    return { ok: false, error };
  }

  return {
    status,
    statusLoading,
    probes,
    busyHost,
    lastError,
    refreshStatus,
    probeHost,
    connectToHost,
    disconnect,
  };
}

function tailscaleProfile(args: {
  hostLabel: string;
  host: string;
  magicDnsName?: string;
  tailscaleIp?: string;
  corePort: number;
  deviceToken: string;
}): IrisCoreConnectionProfile {
  const id = connectionIdFromParts("tailscale", [args.host, args.corePort]);
  const bracketed = bracketHost(args.host);
  return {
    id,
    name: args.hostLabel || args.host || "Tailscale host",
    mode: "tailscale",
    effectiveCoreApiUrl: `http://${bracketed}:${args.corePort}`,
    tailscale: {
      hostId: id,
      hostLabel: args.hostLabel || args.host,
      magicDnsName: args.magicDnsName,
      tailscaleIp: args.tailscaleIp,
      corePort: args.corePort,
      deviceToken: args.deviceToken,
    },
  };
}

/** Minimal runtime config used to address one host directly during pairing/verification. */
function pairingRuntime(url: string, deviceToken?: string): HermesRuntimeConfig {
  return {
    connectionMode: "tailscale",
    activeConnectionId: "tailscale_pairing",
    coreConnections: [
      {
        id: "tailscale_pairing",
        name: "Pairing",
        mode: "tailscale",
        effectiveCoreApiUrl: url,
        tailscale: { hostId: "tailscale_pairing", hostLabel: "Pairing", corePort: 0, deviceToken },
      },
    ],
    provider: "",
    model: "",
  };
}

function bracketHost(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function deviceName() {
  return "Iris Desktop";
}

export function normalizePairingCode(code: string) {
  return code.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function createDeviceToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `iris_mobile_${bytesToHex(bytes)}`;
}

async function deviceTokenHash(token: string) {
  const data = new TextEncoder().encode(`iris-core-device-token:v1:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `v1:${bytesToHex(new Uint8Array(digest))}`;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
