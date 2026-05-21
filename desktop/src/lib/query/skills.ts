import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getIrisSkillDetail, getIrisSkills, saveIrisSkill } from "../irisRuntime";
import type { HermesRuntimeConfig } from "../../types/hermes";
import { ensureOk } from "./ensureOk";
import { runtimeRouteQueryKey } from "./runtimeKey";

export const skillKeys = {
  all: (runtimeKey: string) => ["skills", runtimeKey] as const,
  list: (runtimeKey: string, profile: string) => [...skillKeys.all(runtimeKey), "list", profile || "default"] as const,
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
    onSuccess: (_result, payload) => {
      queryClient.invalidateQueries({ queryKey: skillKeys.list(routeKey, payload.profile || "default") });
      if (payload.id) {
        queryClient.invalidateQueries({ queryKey: skillKeys.detail(routeKey, payload.profile || "default", payload.id) });
      }
    },
  });
}
