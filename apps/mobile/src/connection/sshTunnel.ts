import type { SavedConnectionProfile } from "./pairingPayload";
import {
  nativeReadHostKeyFingerprint,
  nativeSshConnect,
  nativeSshDisconnect,
  nativeSshExecute,
} from "./nativeSshBridge";

export type SshAuthMethod =
  | { kind: "password"; password: string }
  | { kind: "key"; publicKey?: string; privateKey: string; passphrase?: string };

export type SshTunnelSession = {
  localCoreUrl: string;
  hostKeyFingerprint: string;
  fetch: typeof fetch;
  disconnect(): Promise<void>;
};

export type SshTunnelAdapter = {
  connect(options: {
    profile: SavedConnectionProfile;
    auth?: SshAuthMethod;
  }): Promise<SshTunnelSession>;
};

export class SshTunnelUnavailableError extends Error {
  constructor() {
    super("A native SSH bridge is required before mobile can connect to Iris Core.");
    this.name = "SshTunnelUnavailableError";
  }
}

const nativeRequestForwardingAdapter: SshTunnelAdapter = {
  async connect() {
    throw new SshTunnelUnavailableError();
  },
};

let activeAdapter: SshTunnelAdapter = {
  async connect({ profile, auth }) {
    if (!auth) {
      throw new SshAuthRequiredError();
    }
    if (!profile.hostKeyFingerprint) {
      throw new SshHostKeyUnverifiedError();
    }
    const result = await nativeSshConnect({
      host: profile.sshHost,
      port: profile.sshPort,
      username: profile.username,
      expectedHostKeyFingerprint: profile.hostKeyFingerprint,
      auth,
    });
    const sessionId = result.sessionId;
    return {
      localCoreUrl: "http://iris-mobile-ssh/v1",
      hostKeyFingerprint: result.hostKeyFingerprint,
      fetch: createRequestForwardingFetch(sessionId, profile),
      async disconnect() {
        await nativeSshDisconnect(sessionId);
      },
    };
  },
};

void nativeRequestForwardingAdapter;

export function configureSshTunnelAdapter(adapter: SshTunnelAdapter) {
  activeAdapter = adapter;
}

export function connectSshTunnel(profile: SavedConnectionProfile, auth?: SshAuthMethod) {
  return activeAdapter.connect({ profile, auth });
}

export class SshAuthRequiredError extends Error {
  constructor() {
    super("SSH credentials are required.");
    this.name = "SshAuthRequiredError";
  }
}

export class SshHostKeyUnverifiedError extends Error {
  constructor() {
    super("The SSH host key must be verified before connecting.");
    this.name = "SshHostKeyUnverifiedError";
  }
}

export function readSshHostKeyFingerprint(profile: SavedConnectionProfile) {
  return nativeReadHostKeyFingerprint({
    host: profile.sshHost,
    port: profile.sshPort,
    username: profile.username || "iris",
  });
}

function createRequestForwardingFetch(sessionId: string, profile: SavedConnectionProfile): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init.method || (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")).toUpperCase();
    const headers = new Headers(typeof input !== "string" && !(input instanceof URL) ? input.headers : undefined);
    if (init.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    const body = await requestBodyText(init.body);
    const command = buildCurlCommand({
      method,
      remoteUrl: `http://${profile.remoteCoreHost}:${profile.remoteCorePort}${url.pathname}${url.search}`,
      headers,
      body,
    });
    const result = await nativeSshExecute({ sessionId, command, timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `SSH Core request failed with exit code ${result.exitCode}.`);
    }
    const parsed = parseCurlResponse(result.stdout);
    return new Response(parsed.body, {
      status: parsed.status,
      headers: parsed.headers,
    });
  };
}

async function requestBodyText(body: BodyInit | null | undefined) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.text();
  throw new Error("This SSH transport only supports string request bodies.");
}

function buildCurlCommand({
  method,
  remoteUrl,
  headers,
  body,
}: {
  method: string;
  remoteUrl: string;
  headers: Headers;
  body?: string;
}) {
  const args = ["curl", "--http1.1", "-sS", "-i", "--connect-timeout", "10", "--max-time", "25", "-X", method];
  headers.forEach((value, key) => {
    args.push("-H", `${key}: ${value}`);
  });
  if (body !== undefined) {
    args.push("--data-binary", "@-");
  }
  args.push(remoteUrl);
  const command = args.map(shellQuote).join(" ");
  return body === undefined ? command : `printf %s ${shellQuote(body)} | ${command}`;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseCurlResponse(raw: string) {
  const delimiter = raw.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const index = raw.indexOf(delimiter);
  if (index < 0) {
    throw new Error("Iris Core returned an invalid HTTP response over SSH.");
  }
  const headerText = raw.slice(0, index);
  const body = raw.slice(index + delimiter.length);
  const lines = headerText.split(/\r?\n/);
  const status = Number(lines[0]?.match(/\s(\d{3})(?:\s|$)/)?.[1] || 0);
  if (!status) {
    throw new Error("Iris Core response did not include an HTTP status.");
  }
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }
  return { status, headers, body };
}
