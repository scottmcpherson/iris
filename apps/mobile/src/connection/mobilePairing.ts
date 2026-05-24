import * as Crypto from "expo-crypto";
import type { IrisMobilePairingPayloadV1 } from "./pairingPayload";

export type MobilePairingRedeemResult = {
  deviceId: string;
};

export function createDeviceToken() {
  const bytes = Crypto.getRandomBytes(32);
  return `iris_mobile_${bytesToHex(bytes)}`;
}

export async function deviceTokenHash(token: string) {
  return `v1:${await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `iris-core-device-token:v1:${token}`,
  )}`;
}

export async function redeemMobilePairing(payload: IrisMobilePairingPayloadV1, token: string, deviceName: string) {
  const response = await fetch(new URL("mobile/pair", `${payload.core.url.replace(/\/+$/u, "")}/`).toString(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: payload.pairing.code,
      deviceName,
      deviceTokenHash: await deviceTokenHash(token),
      metadata: {
        source: "iris-mobile",
      },
    }),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok || parsed.ok === false) {
    throw new Error(typeof parsed.error === "string" ? parsed.error : `Pairing failed with HTTP ${response.status}.`);
  }
  const device = parsed.device && typeof parsed.device === "object" ? parsed.device : {};
  return {
    deviceId: typeof device.id === "string" ? device.id : "",
  } satisfies MobilePairingRedeemResult;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
