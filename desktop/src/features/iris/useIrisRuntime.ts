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
import {
  controlIrisCoreGateway,
  getIrisCoreAgentForProfile,
  type IrisCoreGatewayAction,
  type IrisCoreGatewayControlResult,
} from "../../lib/irisCore";
import type { HermesMemory, HermesRuntimeConfig, HermesSkill, HermesStatus } from "../../types/hermes";
import { ensureActiveSshTunnel } from "./sshRuntime";

type RefreshOptions = {
  loadProfileData?: boolean;
  selectProfile?: boolean;
  silent?: boolean;
};

export function useIrisRuntime() {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [memory, setMemory] = useState<HermesMemory | null>(null);
  const [skills, setSkills] = useState<HermesSkill[]>([]);
  const [selectedProfile, setSelectedProfile] = useState("default");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<HermesRuntimeConfig>(() => loadRuntimeConfig());
  const selectedProfileRef = useRef(selectedProfile);
  const runtimeConfigRef = useRef(runtimeConfig);
  const statusPollRef = useRef(false);

  function setCurrentProfile(profile: string) {
    selectedProfileRef.current = profile;
    setSelectedProfile(profile);
  }

  function setCurrentRuntimeConfig(config: HermesRuntimeConfig) {
    runtimeConfigRef.current = config;
    setRuntimeConfig(config);
  }

  async function refreshIris(
    profileName = selectedProfileRef.current,
    config = runtimeConfigRef.current,
    options: RefreshOptions = {},
  ) {
    if (!options.silent) setIsRefreshing(true);
    let activeConfig = config;
    const selectRefreshedProfile = options.selectProfile !== false;
    const loadProfileData = options.loadProfileData ?? selectRefreshedProfile;
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
      if (selectRefreshedProfile) setCurrentProfile(profile);

      if (!loadProfileData) return nextStatus;
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
      if (selectRefreshedProfile) {
        setCurrentProfile("default");
        setSkills([]);
      }
      return offlineStatus;
    } finally {
      if (!options.silent) setIsRefreshing(false);
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

  async function runGatewayAction(action: IrisCoreGatewayAction, targetProfile?: string): Promise<IrisCoreGatewayControlResult> {
    const profile = targetProfile || selectedProfileRef.current || "default";
    let activeConfig = runtimeConfigRef.current;
    const preserveSelectedProfile = profile !== selectedProfileRef.current;
    try {
      activeConfig = await ensureActiveSshTunnel(activeConfig);
      if (activeConfig !== runtimeConfigRef.current) {
        setCurrentRuntimeConfig(activeConfig);
        saveRuntimeConfig(activeConfig);
      }
      const agentResult = await getIrisCoreAgentForProfile(profile, activeConfig);
      if (!agentResult.ok || !agentResult.agent) {
        return {
          ok: false,
          agentId: "",
          runtimeId: "",
          profile,
          action,
          error: ("error" in agentResult ? agentResult.error : "") || "Could not resolve Iris agent.",
        };
      }
      const result = await controlIrisCoreGateway(agentResult.agent.id, action, activeConfig);
      const normalizedResult = result.ok || result.command
        ? result
        : {
            ok: false,
            agentId: agentResult.agent.id,
            runtimeId: agentResult.agent.runtimeId,
            profile,
            action,
            error: result.error || `Could not ${action} Hermes gateway.`,
          };
      await refreshAfterGatewayAction(action, profile, activeConfig, Boolean(normalizedResult.ok), preserveSelectedProfile);
      return normalizedResult;
    } catch (error) {
      await refreshIris(profile, activeConfig, {
        loadProfileData: !preserveSelectedProfile,
        selectProfile: !preserveSelectedProfile,
      });
      return {
        ok: false,
        agentId: "",
        runtimeId: "",
        profile,
        action,
        error: error instanceof Error ? error.message : `Could not ${action} Hermes gateway.`,
      };
    }
  }

  async function refreshAfterGatewayAction(
    action: IrisCoreGatewayAction,
    profile: string,
    config: HermesRuntimeConfig,
    commandOk: boolean,
    preserveSelectedProfile: boolean,
  ) {
    const expectedRunning = action !== "stop";
    const delays = commandOk ? [0, 300, 800, 1400] : [0];
    for (const delay of delays) {
      if (delay > 0) await sleep(delay);
      const nextStatus = await refreshIris(profile, config, {
        loadProfileData: !preserveSelectedProfile,
        selectProfile: !preserveSelectedProfile,
      });
      const target = nextStatus.profiles?.find((item) => item.name === profile);
      if (!target) continue;
      if (Boolean(target.gatewayRunning) === expectedRunning) break;
    }
  }

  useEffect(() => {
    void refreshIris();
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (statusPollRef.current) return;
      if (document.visibilityState === "hidden") return;
      statusPollRef.current = true;
      void refreshIris(selectedProfileRef.current, runtimeConfigRef.current, {
        loadProfileData: false,
        selectProfile: false,
        silent: true,
      }).finally(() => {
        statusPollRef.current = false;
      });
    }, 5000);
    return () => window.clearInterval(interval);
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
    runGatewayAction,
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

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
