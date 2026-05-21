import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteIrisSkill,
  getIrisSkillCatalog,
  getIrisSkillDetail,
  getIrisSkills,
  installIrisSkill,
  saveIrisSkill,
} from "../irisRuntime";
import type { HermesRuntimeConfig } from "../../types/hermes";
import { ensureOk } from "./ensureOk";
import { runtimeRouteQueryKey } from "./runtimeKey";
import { statusKeys } from "./status";

export const skillKeys = {
  all: (runtimeKey: string) => ["skills", runtimeKey] as const,
  list: (runtimeKey: string, profile: string) => [...skillKeys.all(runtimeKey), "list", profile || "default"] as const,
  catalog: (runtimeKey: string, profile: string) =>
    [...skillKeys.all(runtimeKey), "catalog", profile || "default"] as const,
  detail: (runtimeKey: string, profile: string, skillId: string) =>
    [...skillKeys.all(runtimeKey), "detail", profile || "default", skillId] as const,
};

export function skillsQueryOptions(runtime: HermesRuntimeConfig, profile = "default") {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: skillKeys.list(routeKey, profile),
    queryFn: () => ensureOk(getIrisSkills(profile, runtime), "Could not load skills."),
  });
}

export function skillCatalogQueryOptions(runtime: HermesRuntimeConfig, profile = "default", enabled = true) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: skillKeys.catalog(routeKey, profile),
    queryFn: () => ensureOk(getIrisSkillCatalog(profile, runtime), "Could not load skill catalog."),
    enabled,
  });
}

export function skillDetailQueryOptions(runtime: HermesRuntimeConfig, profile: string, skillId: string) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: skillKeys.detail(routeKey, profile, skillId),
    queryFn: () => ensureOk(getIrisSkillDetail(profile, skillId, runtime), "Could not load skill."),
    enabled: Boolean(skillId),
  });
}

export function useSkillsQuery(runtime: HermesRuntimeConfig, profile = "default", enabled = true) {
  return useQuery({ ...skillsQueryOptions(runtime, profile), enabled });
}

export function useSkillDetailQuery(runtime: HermesRuntimeConfig, profile: string, skillId: string) {
  return useQuery(skillDetailQueryOptions(runtime, profile, skillId));
}

export function useSkillCatalogQuery(runtime: HermesRuntimeConfig, profile = "default", enabled = true) {
  return useQuery(skillCatalogQueryOptions(runtime, profile, enabled));
}

export function useSaveSkillMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: (payload: {
      profile?: string;
      id?: string;
      path?: string;
      name: string;
      category: string;
      content: string;
    }) => ensureOk(saveIrisSkill({ ...payload, runtime }), "Could not save skill."),
    onSuccess: (result, payload) => {
      queryClient.invalidateQueries({ queryKey: skillKeys.list(routeKey, payload.profile || "default") });
      queryClient.invalidateQueries({ queryKey: skillKeys.catalog(routeKey, payload.profile || "default") });
      queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
      if (payload.id) {
        queryClient.invalidateQueries({ queryKey: skillKeys.detail(routeKey, payload.profile || "default", payload.id) });
      }
      if (result.skill.id) {
        queryClient.invalidateQueries({ queryKey: skillKeys.detail(routeKey, result.profile, result.skill.id) });
      }
    },
  });
}

export function useInstallSkillMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: (payload: {
      profile?: string;
      sourceProfile?: string;
      sourceAgentId?: string;
      sourceSkillId: string;
      overwrite?: boolean;
    }) => ensureOk(installIrisSkill({ ...payload, runtime }), "Could not install skill."),
    onSuccess: (result, payload) => {
      const profile = payload.profile || result.profile || "default";
      queryClient.invalidateQueries({ queryKey: skillKeys.list(routeKey, profile) });
      queryClient.invalidateQueries({ queryKey: skillKeys.catalog(routeKey, profile) });
      queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
      if (result.skill.id) {
        queryClient.invalidateQueries({ queryKey: skillKeys.detail(routeKey, profile, result.skill.id) });
      }
    },
  });
}

export function useDeleteSkillMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: (payload: {
      profile?: string;
      skillId: string;
    }) => ensureOk(deleteIrisSkill(payload.profile, payload.skillId, runtime), "Could not remove skill."),
    onSuccess: (result, payload) => {
      const profile = payload.profile || result.profile || "default";
      queryClient.invalidateQueries({ queryKey: skillKeys.list(routeKey, profile) });
      queryClient.invalidateQueries({ queryKey: skillKeys.catalog(routeKey, profile) });
      queryClient.invalidateQueries({ queryKey: skillKeys.detail(routeKey, profile, payload.skillId) });
      queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
    },
  });
}
