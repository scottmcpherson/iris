export type IrisSshAuth =
  | { kind: "password"; password: string }
  | { kind: "key"; publicKey?: string; privateKey: string; passphrase?: string };

export type IrisSshConnectPayload = {
  host: string;
  port: number;
  username: string;
  expectedHostKeyFingerprint: string;
  auth: IrisSshAuth;
};

export type IrisSshSessionResult = {
  sessionId: string;
  hostKeyFingerprint: string;
};

export type IrisSshExecutePayload = {
  sessionId: string;
  command: string;
  timeoutMs?: number;
};

export type IrisSshExecuteResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};
