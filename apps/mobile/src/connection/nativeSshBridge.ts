import IrisSshModule from "../../modules/iris-ssh/src/IrisSshModule";
import type {
  IrisSshConnectPayload,
  IrisSshExecutePayload,
  IrisSshExecuteResult,
  IrisSshSessionResult,
} from "../../modules/iris-ssh/src/IrisSsh.types";

export type HostKeyFingerprintResult = {
  hostKeyFingerprint: string;
};

export async function nativeReadHostKeyFingerprint(payload: {
  host: string;
  port: number;
  username: string;
}) {
  return parseJson<HostKeyFingerprintResult>(
    await IrisSshModule.readHostKeyFingerprintJson(JSON.stringify(payload)),
  );
}

export async function nativeSshConnect(payload: IrisSshConnectPayload) {
  return parseJson<IrisSshSessionResult>(await IrisSshModule.connectJson(JSON.stringify(payload)));
}

export async function nativeSshExecute(payload: IrisSshExecutePayload) {
  return parseJson<IrisSshExecuteResult>(await IrisSshModule.executeJson(JSON.stringify(payload)));
}

export async function nativeSshDisconnect(sessionId: string) {
  await IrisSshModule.disconnectJson(JSON.stringify({ sessionId }));
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
