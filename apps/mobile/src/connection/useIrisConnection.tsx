import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getHealth, type IrisCoreClient } from "@iris/core-client";
import { createMobileCoreClient } from "../lib/coreClient";
import { isDirectCoreConnectionProfile, isSshConnectionProfile, type SavedConnectionProfile } from "./pairingPayload";
import {
  clearConnectionProfile,
  type ConnectionAuth,
  loadSavedConnectionAuth,
  loadSavedConnectionProfile,
  saveConnectionAuth,
  saveConnectionProfile,
} from "./secureConnectionStore";
import {
  connectSshTunnel,
  readSshHostKeyFingerprint,
  SshAuthRequiredError,
  SshHostKeyUnverifiedError,
  SshTunnelUnavailableError,
  type SshTunnelSession,
} from "./sshTunnel";

export type MobileConnectionState =
  | { status: "unpaired" }
  | { status: "connecting"; profile: SavedConnectionProfile }
  | { status: "connected"; profile: SavedConnectionProfile; localCoreUrl: string; hostKeyFingerprint: string }
  | { status: "disconnected"; profile: SavedConnectionProfile; error?: string }
  | {
      status: "blocked";
      profile: SavedConnectionProfile;
      reason: "host-key-changed" | "host-key-unverified" | "auth-required" | "ssh-unavailable";
    };

type IrisConnectionContextValue = {
  state: MobileConnectionState;
  client: IrisCoreClient | null;
  clientKey: string;
  pair: (profile: SavedConnectionProfile, auth: ConnectionAuth) => Promise<void>;
  connect: (profile?: SavedConnectionProfile, auth?: ConnectionAuth) => Promise<void>;
  readHostKey: (profile: SavedConnectionProfile) => Promise<string>;
  disconnect: () => Promise<void>;
  forget: () => Promise<void>;
};

const IrisConnectionContext = createContext<IrisConnectionContextValue | null>(null);

export function IrisConnectionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MobileConnectionState>({ status: "unpaired" });
  const [tunnel, setTunnel] = useState<SshTunnelSession | null>(null);
  const [directToken, setDirectToken] = useState("");

  const client = useMemo(() => {
    if (state.status !== "connected") return null;
    if (isDirectCoreConnectionProfile(state.profile)) {
      return directToken ? createMobileCoreClient(state.localCoreUrl, globalThis.fetch.bind(globalThis), directToken) : null;
    }
    return tunnel ? createMobileCoreClient(state.localCoreUrl, tunnel.fetch) : null;
  }, [directToken, state, tunnel]);
  const clientKey = state.status === "connected" ? state.localCoreUrl : "unpaired";

  const readHostKey = useCallback(async (profile: SavedConnectionProfile) => {
    const result = await readSshHostKeyFingerprint(profile);
    return result.hostKeyFingerprint;
  }, []);

  const connect = useCallback(async (overrideProfile?: SavedConnectionProfile, overrideAuth?: ConnectionAuth) => {
    const profile = overrideProfile || ("profile" in state ? state.profile : null);
    if (!profile) {
      setState({ status: "unpaired" });
      return;
    }
    const auth = overrideAuth || await loadSavedConnectionAuth();
    if (!auth) {
      setState({ status: "blocked", profile, reason: "auth-required" });
      return;
    }
    setState({ status: "connecting", profile });
    try {
      if (isDirectCoreConnectionProfile(profile)) {
        if (auth.kind !== "core-token") {
          setState({ status: "blocked", profile, reason: "auth-required" });
          return;
        }
        const nextClient = createMobileCoreClient(profile.coreUrl, globalThis.fetch.bind(globalThis), auth.token);
        const health = await getHealth(nextClient);
        if (!health.ok) {
          setState({ status: "disconnected", profile, error: health.error || "Iris Core health check failed." });
          return;
        }
        await saveConnectionProfile(profile);
        await saveConnectionAuth(auth);
        setTunnel(null);
        setDirectToken(auth.token);
        setState({
          status: "connected",
          profile,
          localCoreUrl: profile.coreUrl,
          hostKeyFingerprint: "",
        });
        return;
      }
      if (!isSshConnectionProfile(profile) || auth.kind === "core-token") {
        setState({ status: "blocked", profile, reason: "ssh-unavailable" });
        return;
      }
      const nextTunnel = await connectSshTunnel(profile, auth);
      setDirectToken("");
      const nextClient = createMobileCoreClient(nextTunnel.localCoreUrl, nextTunnel.fetch);
      const health = await getHealth(nextClient);
      if (!health.ok) {
        await nextTunnel.disconnect();
        setState({ status: "disconnected", profile, error: health.error || "Iris Core health check failed." });
        return;
      }
      if (profile.hostKeyFingerprint && profile.hostKeyFingerprint !== nextTunnel.hostKeyFingerprint) {
        await nextTunnel.disconnect();
        setState({ status: "blocked", profile, reason: "host-key-changed" });
        return;
      }
      const savedProfile = { ...profile, hostKeyFingerprint: nextTunnel.hostKeyFingerprint };
      await saveConnectionProfile(savedProfile);
      await saveConnectionAuth(auth);
      setTunnel(nextTunnel);
      setState({
        status: "connected",
        profile: savedProfile,
        localCoreUrl: nextTunnel.localCoreUrl,
        hostKeyFingerprint: nextTunnel.hostKeyFingerprint,
      });
    } catch (error) {
      if (error instanceof SshTunnelUnavailableError) {
        setState({ status: "blocked", profile, reason: "ssh-unavailable" });
        return;
      }
      if (error instanceof SshAuthRequiredError) {
        setState({ status: "blocked", profile, reason: "auth-required" });
        return;
      }
      if (error instanceof SshHostKeyUnverifiedError) {
        setState({ status: "blocked", profile, reason: "host-key-unverified" });
        return;
      }
      setState({
        status: "disconnected",
        profile,
        error: error instanceof Error ? error.message : "Could not connect to Iris over SSH.",
      });
    }
  }, [state]);

  const pair = useCallback(async (profile: SavedConnectionProfile, auth: ConnectionAuth) => {
    await saveConnectionProfile(profile);
    await saveConnectionAuth(auth);
    await connect(profile, auth);
  }, [connect]);

  const disconnect = useCallback(async () => {
    await tunnel?.disconnect();
    setTunnel(null);
    setDirectToken("");
    if ("profile" in state) {
      setState({ status: "disconnected", profile: state.profile });
    } else {
      setState({ status: "unpaired" });
    }
  }, [state, tunnel]);

  const forget = useCallback(async () => {
    await tunnel?.disconnect();
    setTunnel(null);
    setDirectToken("");
    await clearConnectionProfile();
    setState({ status: "unpaired" });
  }, [tunnel]);

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
    <IrisConnectionContext.Provider value={{ state, client, clientKey, pair, connect, readHostKey, disconnect, forget }}>
      {children}
    </IrisConnectionContext.Provider>
  );
}

export function useIrisConnection() {
  const value = useContext(IrisConnectionContext);
  if (!value) throw new Error("useIrisConnection must be used inside IrisConnectionProvider.");
  return value;
}
