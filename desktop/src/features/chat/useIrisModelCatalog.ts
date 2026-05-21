import { useEffect, useMemo, useState } from "react";
import { loadJsonValue, saveJsonValue, storageKeys } from "../../app/storage";
import { useModelCatalogQuery } from "../../lib/query";
import { stringValue } from "../../shared/strings";
import type {
  HermesModelCatalog,
  HermesModelSelection,
  HermesProfile,
  HermesRuntimeConfig,
} from "../../types/hermes";

type UseIrisModelCatalogOptions = {
  profile: string;
  profileSummary?: HermesProfile;
  runtimeConfig: HermesRuntimeConfig;
  connected: boolean;
  refreshKey?: string | number | null;
};

export function useIrisModelCatalog({
  profile,
  profileSummary,
  runtimeConfig,
  connected,
  refreshKey,
}: UseIrisModelCatalogOptions) {
  const [draftsByProfile, setDraftsByProfile] = useState<Record<string, HermesModelSelection>>(
    () => loadStoredSelections(),
  );
  const fallbackSelection = selectionFromProfile(profileSummary);
  const catalogQuery = useModelCatalogQuery(runtimeConfig, profile, connected);
  const queryError = catalogQuery.error instanceof Error ? catalogQuery.error.message : null;
  const catalog = connected
    ? catalogQuery.data || (queryError ? fallbackCatalog(profile, fallbackSelection, catalogQuery.error) : null)
    : null;
  const draftSelection = resolveDraftSelection(draftsByProfile[profile], catalog, fallbackSelection);
  const error = queryError || catalog?.error || null;
  const loading = Boolean(connected && !catalogQuery.data && catalogQuery.isFetching);

  useEffect(() => {
    saveStoredSelections(draftsByProfile);
  }, [draftsByProfile]);

  useEffect(() => {
    if (!connected || !profile || refreshKey == null) return;
    void catalogQuery.refetch();
  }, [connected, profile, refreshKey]);

  useEffect(() => {
    if (!catalog) return;
    const saved = draftsByProfile[profile];
    if (saved && !selectionExistsInCatalog(saved, catalog)) {
      setDraftsByProfile((current) => {
        const next = { ...current };
        delete next[profile];
        return next;
      });
    }
  }, [catalog, draftsByProfile, profile]);

  function selectDraftModel(selection: HermesModelSelection) {
    setDraftsByProfile((current) => ({ ...current, [profile]: selection }));
  }

  const providerCount = useMemo(
    () => (catalog?.providers || []).filter((provider) => provider.models.length).length,
    [catalog],
  );

  return {
    catalog,
    currentSelection: catalog?.current || fallbackSelection,
    draftSelection,
    loading,
    error,
    providerCount,
    selectDraftModel,
    refreshModelCatalog: catalogQuery.refetch,
    modelLabel: modelSelectionLabel(draftSelection),
  };
}

export function resolveDraftSelection(
  saved: HermesModelSelection | undefined,
  catalog: HermesModelCatalog | null,
  fallback: HermesModelSelection | null,
) {
  if (saved && (!catalog || selectionExistsInCatalog(saved, catalog))) return saved;
  return catalog?.current || fallback;
}

export function selectionExistsInCatalog(selection: HermesModelSelection, catalog: HermesModelCatalog | null) {
  if (!catalog?.providers?.length) return false;
  return catalog.providers.some(
    (provider) =>
      provider.slug === selection.provider &&
      provider.models.some((model) => model === selection.model),
  );
}

export function modelSelectionLabel(selection: HermesModelSelection | null) {
  return selection?.model || "Model";
}

function selectionFromProfile(profile?: HermesProfile): HermesModelSelection | null {
  if (!profile?.model || profile.model === "not configured") return null;
  const model = profileModelName(profile.model);
  const provider = profileProviderName(profile.provider, profile.model);
  return {
    provider,
    model,
    providerName: provider || undefined,
  };
}

function profileModelName(value: string) {
  const trimmed = value.trim();
  const jsonLike = trimmed.replace(/'/g, '"');
  try {
    const parsed = JSON.parse(jsonLike);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>;
      return stringValue(row.default) || stringValue(row.model) || trimmed;
    }
  } catch {
    // Fall through to regex extraction for Python-style dict strings.
  }
  const match = trimmed.match(/['"](?:default|model)['"]\s*:\s*['"]([^'"]+)['"]/);
  return match?.[1] || trimmed;
}

function profileProviderName(provider: string, modelConfig: string) {
  if (provider && provider !== "not configured") return provider;
  const trimmed = modelConfig.trim().replace(/'/g, '"');
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return stringValue((parsed as Record<string, unknown>).provider);
    }
  } catch {
    // Fall through to regex extraction.
  }
  return modelConfig.match(/['"]provider['"]\s*:\s*['"]([^'"]+)['"]/)?.[1] || "";
}

function fallbackCatalog(
  profile: string,
  current: HermesModelSelection | null,
  error: unknown,
): HermesModelCatalog {
  return {
    ok: false,
    profile,
    current,
    providers: [],
    generatedAt: Math.floor(Date.now() / 1000),
    error: error instanceof Error ? error.message : "Could not load model catalog.",
  };
}

function loadStoredSelections() {
  const parsed = loadJsonValue<Record<string, unknown>>(storageKeys.modelSelectionByProfile, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed)
      .map(([profile, value]) => [profile, validSelection(value)])
      .filter((entry): entry is [string, HermesModelSelection] => Boolean(entry[0] && entry[1])),
  );
}

function saveStoredSelections(value: Record<string, HermesModelSelection>) {
  saveJsonValue(storageKeys.modelSelectionByProfile, value);
}

function validSelection(value: unknown): HermesModelSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const model = typeof row.model === "string" ? row.model.trim() : "";
  const provider = typeof row.provider === "string" ? row.provider.trim() : "";
  if (!model) return null;
  return {
    model,
    provider,
    providerName: typeof row.providerName === "string" ? row.providerName.trim() : undefined,
  };
}
