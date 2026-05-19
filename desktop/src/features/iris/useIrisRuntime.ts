import { useEffect, useMemo, useState } from "react";
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

export function useIrisRuntime() {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [memory, setMemory] = useState<HermesMemory | null>(null);
  const [skills, setSkills] = useState<HermesSkill[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("default");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<HermesRuntimeConfig>(() => loadRuntimeConfig());

  async function refreshIris(profileName = selectedProfile, config = runtimeConfig) {
    setIsRefreshing(true);
    try {
      const nextStatus = await getIrisStatus(config, profileName);
      if (!nextStatus.ok) throw new Error(nextStatus.error || "Iris status failed.");
      const profile = profileName || nextStatus.activeProfile?.name || "default";
      setStatus(nextStatus);
      setSelectedProfile(profile);

      const [nextMemory, nextSkills] = await Promise.all([
        getIrisMemory(profile, config),
        getIrisSkills(profile, config),
      ]);
      if (nextMemory.ok) setMemory(nextMemory);
      if (nextSkills.ok) setSkills(nextSkills.skills);
      else setSkills([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reach the Tauri bridge.";
      setStatus({
        ok: false,
        connected: false,
        root: "",
        hermesPath: null,
        hermesPathSource: null,
        hermesPathCandidates: [],
        version: null,
        checkedAt: Math.floor(Date.now() / 1000),
        connectionMode: config.connectionMode,
        activeConnectionId: config.activeConnectionId,
        activeConnectionName: activeCoreConnection(config).name,
        coreApiUrl: resolveCoreApiUrl(config),
        activeApiUrl: "",
        error: message,
        activeProfile: offlineProfile,
        profiles: [offlineProfile],
      });
      setSelectedProfile("default");
      setSkills([]);
    } finally {
      setIsRefreshing(false);
    }
  }

  function selectProfile(profile: string) {
    setSelectedProfile(profile);
    void refreshIris(profile);
  }

  function updateRuntimeConfig(nextConfig: HermesRuntimeConfig) {
    setRuntimeConfig(nextConfig);
    saveRuntimeConfig(nextConfig);
    void refreshIris(selectedProfile, nextConfig);
  }

  async function runProfileAction(action: ProfileAction, name: string, sourceProfile = selectedProfile) {
    const target = name.trim();
    const source = sourceProfile || selectedProfile || "default";
    if (!target && !["delete", "switch"].includes(action)) return "Enter an agent name first.";
    const current = selectedProfile || "default";
    const result =
      action === "create"
        ? await createIrisAgent(target, runtimeConfig)
        : action === "clone"
          ? await cloneIrisAgent(source, target, runtimeConfig)
          : action === "rename"
            ? await renameIrisAgent(source, target, runtimeConfig)
            : action === "delete"
              ? await deleteIrisAgent(source, runtimeConfig)
              : await switchIrisAgent(target || current, runtimeConfig);

    if (!result.ok) return result.error || "Agent operation failed.";
    const nextProfile = action === "delete"
      ? source === current
        ? result.profile || "default"
        : current
      : result.profile || target || current;
    setSelectedProfile(nextProfile);
    await refreshIris(nextProfile);
    return `Profile ${action} completed.`;
  }

  async function saveMemoryFile(file: "memory" | "user", content: string, expectedUpdatedAt?: number | null) {
    const result = await saveIrisMemoryFile({
      profile: selectedProfile,
      file,
      content,
      expectedUpdatedAt,
      runtime: runtimeConfig,
    });
    if (!result.ok) return result.error || "Memory save failed.";
    setMemory(result.memory);
    await refreshIris(selectedProfile);
    return "Memory saved.";
  }

  async function resetMemoryFile(file: "memory" | "user" | "all", confirm: string) {
    const result = await resetIrisMemoryFile({
      profile: selectedProfile,
      file,
      confirm,
      runtime: runtimeConfig,
    });
    if (!result.ok) return result.error || "Memory reset failed.";
    setMemory(result.memory);
    await refreshIris(selectedProfile);
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
