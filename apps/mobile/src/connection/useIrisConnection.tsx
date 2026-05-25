import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getHealth, type IrisCoreClient } from "@iris/core-client";
import { createMobileCoreClient } from "../lib/coreClient";
import type { SavedConnectionProfile } from "./pairingPayload";
import {
  clearConnectionProfile,
  type ConnectionAuth,
  loadSavedConnectionAuth,
  loadSavedConnectionProfile,
  saveConnectionAuth,
  saveConnectionProfile,
} from "./secureConnectionStore";

const UNREACHABLE_HOST_ERROR =
  "Couldn't reach the host. Make sure Tailscale is connected on this phone and the host is online.";

export type MobileConnectionState =
  | { status: "unpaired" }
  | { status: "connecting"; profile: SavedConnectionProfile }
  | { status: "connected"; profile: SavedConnectionProfile; localCoreUrl: string }
  | { status: "disconnected"; profile: SavedConnectionProfile; error?: string }
  | {
      status: "blocked";
      profile: SavedConnectionProfile;
      reason: "auth-required" | "core-unreachable";
    };

type IrisConnectionContextValue = {
  state: MobileConnectionState;
  client: IrisCoreClient | null;
  clientKey: string;
  pair: (profile: SavedConnectionProfile, auth: ConnectionAuth) => Promise<void>;
  connect: (profile?: SavedConnectionProfile, auth?: ConnectionAuth) => Promise<void>;
  disconnect: () => Promise<void>;
  forget: () => Promise<void>;
};

const IrisConnectionContext = createContext<IrisConnectionContextValue | null>(null);

export function IrisConnectionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MobileConnectionState>({ status: "unpaired" });
  const [directToken, setDirectToken] = useState("");

  const client = useMemo(() => {
    if (state.status !== "connected") return null;
    return directToken ? createMobileCoreClient(state.localCoreUrl, globalThis.fetch.bind(globalThis), directToken) : null;
  }, [directToken, state]);
  const clientKey = state.status === "connected" ? state.localCoreUrl : "unpaired";

  const connect = useCallback(async (overrideProfile?: SavedConnectionProfile, overrideAuth?: ConnectionAuth) => {
    const profile = overrideProfile || ("profile" in state ? state.profile : null);
    if (!profile) {
      setState({ status: "unpaired" });
      return;
    }
    const auth = overrideAuth || await loadSavedConnectionAuth();
    if (!auth || auth.kind !== "core-token") {
      setState({ status: "blocked", profile, reason: "auth-required" });
      return;
    }
    setState({ status: "connecting", profile });
    try {
      const nextClient = createMobileCoreClient(profile.coreUrl, globalThis.fetch.bind(globalThis), auth.token);
      const health = await getHealth(nextClient);
      if (!health.ok) {
        setState({ status: "disconnected", profile, error: health.error || UNREACHABLE_HOST_ERROR });
        return;
      }
      await saveConnectionProfile(profile);
      await saveConnectionAuth(auth);
      setDirectToken(auth.token);
      setState({
        status: "connected",
        profile,
        localCoreUrl: profile.coreUrl,
      });
    } catch (error) {
      setState({
        status: "disconnected",
        profile,
        error: error instanceof Error && error.message ? error.message : UNREACHABLE_HOST_ERROR,
      });
    }
  }, [state]);

  const pair = useCallback(async (profile: SavedConnectionProfile, auth: ConnectionAuth) => {
    await saveConnectionProfile(profile);
    await saveConnectionAuth(auth);
    await connect(profile, auth);
  }, [connect]);

  const disconnect = useCallback(async () => {
    setDirectToken("");
    if ("profile" in state) {
      setState({ status: "disconnected", profile: state.profile });
    } else {
      setState({ status: "unpaired" });
    }
  }, [state]);

  const forget = useCallback(async () => {
    setDirectToken("");
    await clearConnectionProfile();
    setState({ status: "unpaired" });
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadSavedConnectionProfile().then((profile) => {
      if (cancelled) return;
      if (profile) {
        setState({ status: "disconnected", profile });
        void connect(profile);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <IrisConnectionContext.Provider value={{ state, client, clientKey, pair, connect, disconnect, forget }}>
      {children}
    </IrisConnectionContext.Provider>
  );
}

export function useIrisConnection() {
  const value = useContext(IrisConnectionContext);
  if (!value) throw new Error("useIrisConnection must be used inside IrisConnectionProvider.");
  return value;
}
