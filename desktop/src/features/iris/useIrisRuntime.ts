import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  activeCoreConnection,
  loadRuntimeConfig,
  resolveCoreApiUrl,
  saveRuntimeConfig,
} from "../../app/runtimeConfig";
import type { ProfileAction } from "../../app/types";
import { offlineProfile } from "../../app/offlineProfile";
import {
  cloneIrisAgent,
  createIrisAgent,
  deleteIrisAgent,
  getIrisMemory,
  getIrisSkills,
  getIrisStatus,
  renameIrisAgent,
  resetIrisMemoryFile,
  saveIrisMemoryFile,
  switchIrisAgent,
} from "../../lib/irisRuntime";
import type { HermesMemory, HermesRuntimeConfig, HermesSkill, HermesStatus } from "../../types/hermes";
import { ensureActiveSshTunnel } from "./sshRuntime";

export function useIrisRuntime() {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [memory, setMemory] = useState<HermesMemory | null>(null);
  const [skills, setSkills] = useState<HermesSkill[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("default");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<HermesRuntimeConfig>(() => loadRuntimeConfig());
  const selectedProfileRef = useRef(selectedProfile);
  const runtimeConfigRef = useRef(runtimeConfig);

  function setCurrentProfile(profile: string) {
    selectedProfileRef.current = profile;
    setSelectedProfile(profile);
  }

  function setCurrentRuntimeConfig(config: HermesRuntimeConfig) {
    runtimeConfigRef.current = config;
    setRuntimeConfig(config);
  }

  async function refreshIris(profileName = selectedProfileRef.current, config = runtimeConfigRef.current) {
    setIsRefreshing(true);
    let activeConfig = config;
    try {
      activeConfig = await ensureActiveSshTunnel(config);
      if (activeConfig !== config) {
        setCurrentRuntimeConfig(activeConfig);
        saveRuntimeConfig(activeConfig);
      }

      const nextStatus = await getIrisStatus(activeConfig, profileName);
      if (!nextStatus.ok) throw new Error(nextStatus.error || "Iris status failed.");
      const profile = profileName || nextStatus.activeProfile?.name || "default";
      setStatus(nextStatus);
      setCurrentProfile(profile);

      const [nextMemory, nextSkills] = await Promise.all([
        getIrisMemory(profile, activeConfig),
        getIrisSkills(profile, activeConfig),
      ]);
      if (nextMemory.ok) setMemory(nextMemory);
      if (nextSkills.ok) setSkills(nextSkills.skills);
      else setSkills([]);
      return nextStatus;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reach the Tauri bridge.";
      const offlineStatus: HermesStatus = {
        ok: false,
        connected: false,
        root: "",
        hermesPath: null,
        hermesPathSource: null,
        hermesPathCandidates: [],
        version: null,
        checkedAt: Math.floor(Date.now() / 1000),
        connectionMode: activeConfig.connectionMode,
        activeConnectionId: activeConfig.activeConnectionId,
        activeConnectionName: activeCoreConnection(activeConfig).name,
        coreApiUrl: resolveCoreApiUrl(activeConfig),
        activeApiUrl: "",
        error: message,
        activeProfile: offlineProfile,
        profiles: [offlineProfile],
      };
      setStatus(offlineStatus);
      setCurrentProfile("default");
      setSkills([]);
      return offlineStatus;
    } finally {
      setIsRefreshing(false);
    }
  }

  function selectProfile(profile: string) {
    setCurrentProfile(profile);
    void refreshIris(profile);
  }

  function updateRuntimeConfig(nextConfig: HermesRuntimeConfig) {
    setCurrentRuntimeConfig(nextConfig);
    saveRuntimeConfig(nextConfig);
    void refreshIris(selectedProfileRef.current, nextConfig);
  }

  async function runProfileAction(action: ProfileAction, name: string, sourceProfile = selectedProfileRef.current) {
    const target = name.trim();
    const source = sourceProfile || selectedProfileRef.current || "default";
    if (!target && !["delete", "switch"].includes(action)) return "Enter an agent name first.";
    const current = selectedProfileRef.current || "default";
    const config = runtimeConfigRef.current;
    const result =
      action === "create"
        ? await createIrisAgent(target, config)
        : action === "clone"
          ? await cloneIrisAgent(source, target, config)
          : action === "rename"
            ? await renameIrisAgent(source, target, config)
            : action === "delete"
              ? await deleteIrisAgent(source, config)
              : await switchIrisAgent(target || current, config);

    if (!result.ok) return result.error || "Agent operation failed.";
    const nextProfile = action === "delete"
      ? source === current
        ? result.profile || "default"
        : current
      : result.profile || target || current;
    setCurrentProfile(nextProfile);
    await refreshIris(nextProfile);
    return `Profile ${action} completed.`;
  }

  async function saveMemoryFile(file: "memory" | "user", content: string, expectedUpdatedAt?: number | null) {
    const result = await saveIrisMemoryFile({
      profile: selectedProfileRef.current,
      file,
      content,
      expectedUpdatedAt,
      runtime: runtimeConfigRef.current,
    });
    if (!result.ok) return result.error || "Memory save failed.";
    setMemory(result.memory);
    await refreshIris(selectedProfileRef.current);
    return "Memory saved.";
  }

  async function resetMemoryFile(file: "memory" | "user" | "all", confirm: string) {
    const result = await resetIrisMemoryFile({
      profile: selectedProfileRef.current,
      file,
      confirm,
      runtime: runtimeConfigRef.current,
    });
    if (!result.ok) return result.error || "Memory reset failed.";
    setMemory(result.memory);
    await refreshIris(selectedProfileRef.current);
    return "Memory reset completed.";
  }

  useEffect(() => {
    void refreshIris();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let disposeListener: (() => void) | null = null;
    const unlisten = listen("iris://core-ready", () => {
      void refreshIris();
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      disposeListener = dispose;
    });
    return () => {
      disposed = true;
      disposeListener?.();
      void unlisten;
    };
  }, []);

  const activeProfile = useMemo(
    () =>
      status?.profiles.find((profile) => profile.name === selectedProfile) ??
      status?.activeProfile ??
      offlineProfile,
    [selectedProfile, status],
  );

  return {
    activeProfile,
    connected: Boolean(status?.connected),
    isRefreshing,
    memory,
    refreshIris,
    resetMemoryFile,
    runProfileAction,
    runtimeConfig,
    saveMemoryFile,
    selectedProfile,
    selectProfile,
    skills,
    status,
    updateRuntimeConfig,
  };
}
