import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  checkIrisProfileConfig,
  createIrisProfileAlias,
  deleteIrisProfileAlias,
  getIrisProfileAlias,
  getIrisProfileIdentity,
  importIrisProfileArchive,
  installIrisProfileDistribution,
  resetIrisProfileSoul,
  saveIrisProfileConfig,
  saveIrisProfileSoul,
  updateIrisProfileDistribution,
  updateIrisProfileEnv,
} from "../irisRuntime";
import type { HermesRuntimeConfig } from "../../types/hermes";
import { ensureOk } from "./ensureOk";
import { runtimeRouteQueryKey } from "./runtimeKey";
import { agentKeys } from "./agents";
import { statusKeys } from "./status";

export const profileKeys = {
  all: (runtimeKey: string) => ["profile", runtimeKey] as const,
  identity: (runtimeKey: string, profile: string) => [...profileKeys.all(runtimeKey), profile || "default", "identity"] as const,
  alias: (runtimeKey: string, profile: string) => [...profileKeys.all(runtimeKey), profile || "default", "alias"] as const,
};

export function profileIdentityQueryOptions(runtime: HermesRuntimeConfig, profile = "default") {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: profileKeys.identity(routeKey, profile),
    queryFn: () => ensureOk(getIrisProfileIdentity(profile, runtime), "Could not load profile configuration."),
  });
}

export function profileAliasQueryOptions(runtime: HermesRuntimeConfig, profile = "default") {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: profileKeys.alias(routeKey, profile),
    queryFn: () => ensureOk(getIrisProfileAlias(profile, runtime), "Could not load profile alias."),
  });
}

export function useProfileIdentityQuery(runtime: HermesRuntimeConfig, profile = "default", enabled = true) {
  return useQuery({ ...profileIdentityQueryOptions(runtime, profile), enabled });
}

export function useProfileAliasQuery(runtime: HermesRuntimeConfig, profile = "default", enabled = true) {
  return useQuery({ ...profileAliasQueryOptions(runtime, profile), enabled });
}

export function useProfileMutationInvalidation(runtime: HermesRuntimeConfig, profile: string) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return () => {
    queryClient.invalidateQueries({ queryKey: profileKeys.identity(routeKey, profile) });
    queryClient.invalidateQueries({ queryKey: profileKeys.alias(routeKey, profile) });
    queryClient.invalidateQueries({ queryKey: agentKeys.all(routeKey) });
    queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
  };
}

export function useSaveProfileSoulMutation(runtime: HermesRuntimeConfig, profile: string) {
  const invalidate = useProfileMutationInvalidation(runtime, profile);
  return useMutation({
    mutationFn: (payload: { content: string; expectedContentHash?: string | null }) =>
      ensureOk(saveIrisProfileSoul({ profile, ...payload, runtime }), "Could not save SOUL.md."),
    onSuccess: invalidate,
  });
}

export function useResetProfileSoulMutation(runtime: HermesRuntimeConfig, profile: string) {
  const invalidate = useProfileMutationInvalidation(runtime, profile);
  return useMutation({
    mutationFn: (payload: { expectedContentHash?: string | null }) =>
      ensureOk(resetIrisProfileSoul({ profile, ...payload, runtime }), "Could not reset SOUL.md."),
    onSuccess: invalidate,
  });
}

export function useSaveProfileConfigMutation(runtime: HermesRuntimeConfig, profile: string) {
  const invalidate = useProfileMutationInvalidation(runtime, profile);
  return useMutation({
    mutationFn: (payload: { content: string; expectedContentHash?: string | null }) =>
      ensureOk(saveIrisProfileConfig({ profile, ...payload, runtime }), "Could not save config.yaml."),
    onSuccess: invalidate,
  });
}

export function useUpdateProfileEnvMutation(runtime: HermesRuntimeConfig, profile: string) {
  const invalidate = useProfileMutationInvalidation(runtime, profile);
  return useMutation({
    mutationFn: (payload: { values: Record<string, string>; removeKeys?: string[] }) =>
      ensureOk(updateIrisProfileEnv({ profile, ...payload, runtime }), "Could not update environment."),
    onSuccess: invalidate,
  });
}

export function useProfileConfigCheckMutation(runtime: HermesRuntimeConfig, profile: string) {
  return useMutation({
    mutationFn: () => ensureOk(checkIrisProfileConfig(profile, runtime), "Could not run Hermes config check."),
  });
}

export function useCreateProfileAliasMutation(runtime: HermesRuntimeConfig, profile: string) {
  const invalidate = useProfileMutationInvalidation(runtime, profile);
  return useMutation({
    mutationFn: (alias: string) => ensureOk(createIrisProfileAlias(profile, alias, runtime), "Could not create alias."),
    onSuccess: invalidate,
  });
}

export function useDeleteProfileAliasMutation(runtime: HermesRuntimeConfig, profile: string) {
  const invalidate = useProfileMutationInvalidation(runtime, profile);
  return useMutation({
    mutationFn: (alias: string) => ensureOk(deleteIrisProfileAlias(profile, alias, runtime), "Could not remove alias."),
    onSuccess: invalidate,
  });
}

function useNewProfileMutationInvalidation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return () => {
    queryClient.invalidateQueries({ queryKey: agentKeys.all(routeKey) });
    queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
  };
}

export function useImportProfileArchiveMutation(runtime: HermesRuntimeConfig) {
  const invalidate = useNewProfileMutationInvalidation(runtime);
  return useMutation({
    mutationFn: (payload: { file: File; name?: string }) =>
      ensureOk(importIrisProfileArchive({ ...payload, runtime }), "Profile import failed."),
    onSuccess: invalidate,
  });
}

export function useInstallProfileDistributionMutation(runtime: HermesRuntimeConfig) {
  const invalidate = useNewProfileMutationInvalidation(runtime);
  return useMutation({
    mutationFn: (payload: { source: string; name?: string; alias?: boolean; force?: boolean }) =>
      ensureOk(installIrisProfileDistribution({ ...payload, runtime }), "Distribution install failed."),
    onSuccess: invalidate,
  });
}

export function useUpdateProfileDistributionMutation(runtime: HermesRuntimeConfig, profile: string) {
  const invalidate = useProfileMutationInvalidation(runtime, profile);
  return useMutation({
    mutationFn: (payload: { forceConfig?: boolean } = {}) =>
      ensureOk(
        updateIrisProfileDistribution(profile, Boolean(payload.forceConfig), runtime),
        "Distribution update failed.",
      ),
    onSuccess: invalidate,
  });
}
