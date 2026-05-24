import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  getIrisStatus,
  renameIrisAgent,
  switchIrisAgent,
} from "../../lib/irisRuntime";
import {
  agentKeys,
  ensureOk,
  memoryKeys,
  memoryQueryOptions,
  runtimeRouteQueryKey,
  sessionKeys,
  skillKeys,
  skillsQueryOptions,
  statusKeys,
  statusQueryOptions,
  useResetMemoryMutation,
  useSaveMemoryMutation,
} from "../../lib/query";
import {
  controlIrisCoreGateway,
  getIrisCoreAgentForProfile,
  type IrisCoreGatewayAction,
  type IrisCoreGatewayControlResult,
} from "../../lib/irisCore";
import type {
  HermesMemory,
  HermesMemoryResetExpectations,
  HermesRuntimeConfig,
  HermesSkill,
  HermesStatus,
} from "../../types/hermes";
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
  const queryClient = useQueryClient();
  const saveMemoryMutation = useSaveMemoryMutation(runtimeConfig);
  const resetMemoryMutation = useResetMemoryMutation(runtimeConfig);
  const statusQuery = useQuery({
    ...statusQueryOptions(runtimeConfig, selectedProfile),
    queryFn: () => loadStatusWithPreparedRuntime(selectedProfile, runtimeConfig, { selectProfile: true }),
    refetchInterval: () => document.visibilityState === "hidden" ? false : 5_000,
  });
  const memoryQuery = useQuery({
    ...memoryQueryOptions(runtimeConfig, selectedProfile),
    enabled: Boolean(status?.connected && selectedProfile),
  });
  const skillsQuery = useQuery({
    ...skillsQueryOptions(runtimeConfig, selectedProfile),
    enabled: Boolean(status?.connected && selectedProfile),
  });
  const profileActionMutation = useMutation({
    mutationFn: async ({
      action,
      target,
      source,
    }: {
      action: ProfileAction;
      target: string;
      source: string;
    }) =>
      action === "create"
        ? createIrisAgent(target, runtimeConfigRef.current)
        : action === "clone"
          ? cloneIrisAgent(source, target, runtimeConfigRef.current)
          : action === "rename"
            ? renameIrisAgent(source, target, runtimeConfigRef.current)
            : action === "delete"
              ? deleteIrisAgent(source, runtimeConfigRef.current)
              : switchIrisAgent(target, runtimeConfigRef.current),
    onSuccess: () => {
      const activeRouteKey = runtimeRouteQueryKey(runtimeConfigRef.current);
      queryClient.invalidateQueries({ queryKey: agentKeys.all(activeRouteKey) });
      queryClient.invalidateQueries({ queryKey: statusKeys.all(activeRouteKey) });
      queryClient.invalidateQueries({ queryKey: memoryKeys.all(activeRouteKey) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.all(activeRouteKey) });
      queryClient.invalidateQueries({ queryKey: skillKeys.all(activeRouteKey) });
    },
  });

  function setCurrentProfile(profile: string) {
    selectedProfileRef.current = profile;
    setSelectedProfile(profile);
  }

  function setCurrentRuntimeConfig(config: HermesRuntimeConfig) {
    runtimeConfigRef.current = config;
    setRuntimeConfig(config);
  }

  async function prepareRuntimeConfig(config: HermesRuntimeConfig) {
    const activeConfig = await ensureActiveSshTunnel(config);
    if (activeConfig !== config) {
      setCurrentRuntimeConfig(activeConfig);
      saveRuntimeConfig(activeConfig);
    }
    return activeConfig;
  }

  async function loadStatusWithPreparedRuntime(
    profileName: string,
    config: HermesRuntimeConfig,
    options: { selectProfile?: boolean } = {},
  ) {
    const activeConfig = await prepareRuntimeConfig(config);
    const nextStatus = await ensureOk(getIrisStatus(activeConfig, profileName), "Iris status failed.");
    const profile = profileName || nextStatus.activeProfile?.name || "default";
    setStatus(nextStatus);
    if (options.selectProfile !== false) setCurrentProfile(profile);
    return nextStatus;
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
      activeConfig = await prepareRuntimeConfig(config);

      const nextStatus = await queryClient.fetchQuery(statusQueryOptions(activeConfig, profileName));
      const profile = profileName || nextStatus.activeProfile?.name || "default";
      setStatus(nextStatus);
      if (selectRefreshedProfile) setCurrentProfile(profile);

      if (!loadProfileData) return nextStatus;
      const [nextMemory, nextSkills] = await Promise.allSettled([
        queryClient.fetchQuery(memoryQueryOptions(activeConfig, profile)),
        queryClient.fetchQuery(skillsQueryOptions(activeConfig, profile)),
      ]);
      if (nextMemory.status === "fulfilled" && profile === selectedProfileRef.current) {
        setMemory(nextMemory.value);
      }
      if (nextSkills.status === "fulfilled") setSkills(nextSkills.value.skills);
      else setSkills([]);
      return nextStatus;
    } catch (error) {
      const offlineStatus = offlineStatusForError(error, activeConfig);
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
    const result = await profileActionMutation.mutateAsync({
      action,
      target: action === "switch" ? target || current : target,
      source,
    });

    if (!result.ok) return result.error || "Agent operation failed.";
    const nextProfile = action === "delete"
      ? source === current
        ? result.profile || "default"
        : current
      : result.profile || target || current;
    setCurrentProfile(nextProfile);
    await refreshIris(nextProfile);
    return profileActionMessage(action, result);
  }

  async function saveMemoryFile(
    file: "memory" | "user",
    content: string,
    expectedUpdatedAt?: number | null,
    expectedContentHash?: string | null,
    profileName = selectedProfileRef.current,
  ) {
    const profile = profileName || selectedProfileRef.current || "default";
    try {
      const result = await saveMemoryMutation.mutateAsync({
        profile,
        file,
        content,
        expectedUpdatedAt,
        expectedContentHash,
      });
      if (profile === selectedProfileRef.current) setMemory(result.memory);
      await refreshIris(profile, runtimeConfigRef.current, {
        loadProfileData: profile === selectedProfileRef.current,
        selectProfile: profile === selectedProfileRef.current,
      });
      return "Memory saved.";
    } catch (error) {
      return error instanceof Error ? error.message : "Memory save failed.";
    }
  }

  async function resetMemoryFile(
    file: "memory" | "user" | "all",
    confirm: string,
    expectations: HermesMemoryResetExpectations = {},
    profileName = selectedProfileRef.current,
  ) {
    const profile = profileName || selectedProfileRef.current || "default";
    try {
      const result = await resetMemoryMutation.mutateAsync({
        profile,
        file,
        confirm,
        ...expectations,
      });
      if (profile === selectedProfileRef.current) setMemory(result.memory);
      await refreshIris(profile, runtimeConfigRef.current, {
        loadProfileData: profile === selectedProfileRef.current,
        selectProfile: profile === selectedProfileRef.current,
      });
      return "Memory reset completed.";
    } catch (error) {
      return error instanceof Error ? error.message : "Memory reset failed.";
    }
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
    if (!statusQuery.data) return;
    setStatus(statusQuery.data);
    const profile = selectedProfileRef.current || statusQuery.data.activeProfile?.name || "default";
    if (!selectedProfileRef.current) setCurrentProfile(profile);
  }, [statusQuery.data]);

  useEffect(() => {
    if (!statusQuery.error) return;
    const offlineStatus = offlineStatusForError(statusQuery.error, runtimeConfigRef.current);
    setStatus(offlineStatus);
    setCurrentProfile("default");
    setSkills([]);
  }, [statusQuery.error]);

  useEffect(() => {
    if (memoryQuery.data) setMemory(memoryQuery.data);
  }, [memoryQuery.data]);

  useEffect(() => {
    if (skillsQuery.data) setSkills(skillsQuery.data.skills);
    else if (skillsQuery.error) setSkills([]);
  }, [skillsQuery.data, skillsQuery.error]);

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

function profileActionMessage(
  action: ProfileAction,
  result: { warnings?: string[]; restartRequired?: boolean; adapterInstallRequired?: boolean },
) {
  const notes = [
    ...(result.warnings || []),
    result.adapterInstallRequired ? "Adapter install needs attention. Run Settings -> Install Hermes adapter." : "",
    result.restartRequired ? "Restart the Hermes gateway for this agent." : "",
  ].filter(Boolean);
  return [`Profile ${action} completed.`, ...notes].join(" ");
}

function offlineStatusForError(error: unknown, config: HermesRuntimeConfig): HermesStatus {
  const message = error instanceof Error ? error.message : "Could not reach the Tauri bridge.";
  return {
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
  };
}
