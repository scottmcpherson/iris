import { useEffect, useMemo, useState } from "react";
import { loadRuntimeConfig, resolveRuntimeApiUrl, saveRuntimeConfig } from "../../app/runtimeConfig";
import type { ProfileAction } from "../../app/types";
import { offlineProfile } from "../../app/offlineProfile";
import {
  cloneHermesProfile,
  createHermesProfile,
  deleteHermesProfile,
  getHermesMemory,
  getHermesSkills,
  getHermesStatus,
  renameHermesProfile,
  resetHermesMemoryFile,
  saveHermesMemoryFile,
  switchHermesProfile,
} from "../../lib/hermes";
import type { HermesMemory, HermesRuntimeConfig, HermesSkill, HermesStatus } from "../../types/hermes";

export function useHermesRuntime() {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [memory, setMemory] = useState<HermesMemory | null>(null);
  const [skills, setSkills] = useState<HermesSkill[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("default");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<HermesRuntimeConfig>(() => loadRuntimeConfig());

  async function refreshHermes(profileName = selectedProfile, config = runtimeConfig) {
    setIsRefreshing(true);
    try {
      const nextStatus = await getHermesStatus(config, profileName);
      if (!nextStatus.ok) throw new Error(nextStatus.error || "Hermes status failed.");
      const profile = profileName || nextStatus.activeProfile?.name || "default";
      setStatus(nextStatus);
      setSelectedProfile(profile);

      const [nextMemory, nextSkills] = await Promise.all([
        getHermesMemory(profile, config),
        getHermesSkills(profile, config),
      ]);
      if (nextMemory.ok) setMemory(nextMemory);
      if (nextSkills.ok) setSkills(nextSkills.skills);
      else setSkills([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reach the Tauri bridge.";
      setStatus({
        ok: false,
        connected: false,
        root: "~/.hermes",
        hermesPath: null,
        hermesPathSource: null,
        hermesPathCandidates: [],
        version: null,
        checkedAt: Math.floor(Date.now() / 1000),
        connectionMode: config.connectionMode,
        remoteUrl: config.remoteUrl,
        gatewayUrl: config.gatewayUrl,
        managementApiUrl: config.managementApiUrl,
        activeApiUrl: resolveRuntimeApiUrl(config, profileName),
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
    void refreshHermes(profile);
  }

  function updateRuntimeConfig(nextConfig: HermesRuntimeConfig) {
    setRuntimeConfig(nextConfig);
    saveRuntimeConfig(nextConfig);
    void refreshHermes(selectedProfile, nextConfig);
  }

  async function runProfileAction(action: ProfileAction, name: string, sourceProfile = selectedProfile) {
    const target = name.trim();
    const source = sourceProfile || selectedProfile || "default";
    if (!target && !["delete", "switch"].includes(action)) return "Enter a profile name first.";
    const current = selectedProfile || "default";
    const result =
      action === "create"
        ? await createHermesProfile(target, runtimeConfig)
        : action === "clone"
          ? await cloneHermesProfile(source, target, runtimeConfig)
          : action === "rename"
            ? await renameHermesProfile(source, target, runtimeConfig)
            : action === "delete"
              ? await deleteHermesProfile(source, runtimeConfig)
              : await switchHermesProfile(target || current, runtimeConfig);

    if (!result.ok) return result.error || "Profile operation failed.";
    const nextProfile = action === "delete"
      ? source === current
        ? result.profile || "default"
        : current
      : result.profile || target || current;
    updateProfileApiRoutes(action, source, nextProfile);
    setSelectedProfile(nextProfile);
    await refreshHermes(nextProfile);
    return `Profile ${action} completed.`;
  }

  function updateProfileApiRoutes(action: ProfileAction, currentProfile: string, nextProfile: string) {
    if (!["clone", "rename", "delete"].includes(action)) return;
    setRuntimeConfig((currentConfig) => {
      const profileApiUrls = { ...(currentConfig.profileApiUrls || {}) };
      const profileSidecarUrls = { ...(currentConfig.profileSidecarUrls || {}) };
      if (action === "clone" && profileApiUrls[currentProfile] && nextProfile !== currentProfile) {
        profileApiUrls[nextProfile] = profileApiUrls[currentProfile];
      }
      if (action === "clone" && profileSidecarUrls[currentProfile] && nextProfile !== currentProfile) {
        profileSidecarUrls[nextProfile] = profileSidecarUrls[currentProfile];
      }
      if (action === "rename" && nextProfile !== currentProfile) {
        if (profileApiUrls[currentProfile]) profileApiUrls[nextProfile] = profileApiUrls[currentProfile];
        if (profileSidecarUrls[currentProfile]) profileSidecarUrls[nextProfile] = profileSidecarUrls[currentProfile];
        delete profileApiUrls[currentProfile];
        delete profileSidecarUrls[currentProfile];
      }
      if (action === "delete") {
        delete profileApiUrls[currentProfile];
        delete profileSidecarUrls[currentProfile];
      }
      const nextConfig = { ...currentConfig, profileApiUrls, profileSidecarUrls };
      saveRuntimeConfig(nextConfig);
      return nextConfig;
    });
  }

  async function saveMemoryFile(file: "memory" | "user", content: string, expectedUpdatedAt?: number | null) {
    const result = await saveHermesMemoryFile({
      profile: selectedProfile,
      file,
      content,
      expectedUpdatedAt,
    });
    if (!result.ok) return result.error || "Memory save failed.";
    setMemory(result.memory);
    await refreshHermes(selectedProfile);
    return "Memory saved.";
  }

  async function resetMemoryFile(file: "memory" | "user" | "all", confirm: string) {
    const result = await resetHermesMemoryFile({
      profile: selectedProfile,
      file,
      confirm,
    });
    if (!result.ok) return result.error || "Memory reset failed.";
    setMemory(result.memory);
    await refreshHermes(selectedProfile);
    return "Memory reset completed.";
  }

  useEffect(() => {
    void refreshHermes();
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
    refreshHermes,
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
