import { useEffect, useMemo, useRef, useState } from "react";
import { getHermesModelCatalog } from "../../lib/hermes";
import type {
  HermesModelCatalog,
  HermesModelSelection,
  HermesProfile,
  HermesRuntimeConfig,
} from "../../types/hermes";

const modelSelectionStorageKey = "hermes.desktop.modelSelectionByProfile";

type UseHermesModelCatalogOptions = {
  profile: string;
  profileSummary?: HermesProfile;
  runtimeConfig: HermesRuntimeConfig;
  connected: boolean;
  refreshKey?: string | number | null;
};

export function useHermesModelCatalog({
  profile,
  profileSummary,
  runtimeConfig,
  connected,
  refreshKey,
}: UseHermesModelCatalogOptions) {
  const [catalogs, setCatalogs] = useState<Record<string, HermesModelCatalog>>({});
  const [loadingByProfile, setLoadingByProfile] = useState<Record<string, boolean>>({});
  const [errorsByProfile, setErrorsByProfile] = useState<Record<string, string | null>>({});
  const [draftsByProfile, setDraftsByProfile] = useState<Record<string, HermesModelSelection>>(
    () => loadStoredSelections(),
  );
  const requestSeqRef = useRef(0);
  const routeKey = modelCatalogRouteKey(runtimeConfig, profile);
  const catalog = catalogs[profile] || null;
  const fallbackSelection = selectionFromProfile(profileSummary);
  const draftSelection = resolveDraftSelection(draftsByProfile[profile], catalog, fallbackSelection);
  const error = errorsByProfile[profile] || catalog?.error || null;
  const loading = Boolean(loadingByProfile[profile]);

  useEffect(() => {
    saveStoredSelections(draftsByProfile);
  }, [draftsByProfile]);

  useEffect(() => {
    if (!connected || !profile) {
      setLoadingByProfile((current) => ({ ...current, [profile]: false }));
      return undefined;
    }
    void refreshModelCatalog();
    return undefined;
  }, [connected, profile, routeKey, refreshKey]);

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

  async function refreshModelCatalog() {
    const requestId = ++requestSeqRef.current;
    setLoadingByProfile((current) => ({ ...current, [profile]: true }));
    setErrorsByProfile((current) => ({ ...current, [profile]: null }));
    try {
      const result = await getHermesModelCatalog(profile, runtimeConfig);
      if (requestSeqRef.current !== requestId) return;
      setCatalogs((current) => ({ ...current, [profile]: result }));
      setErrorsByProfile((current) => ({
        ...current,
        [profile]: result.ok ? null : result.error || "Could not load model catalog.",
      }));
    } catch (error) {
      if (requestSeqRef.current !== requestId) return;
      setErrorsByProfile((current) => ({
        ...current,
        [profile]: error instanceof Error ? error.message : "Could not load model catalog.",
      }));
      setCatalogs((current) => ({
        ...current,
        [profile]: fallbackCatalog(profile, fallbackSelection, error),
      }));
    } finally {
      if (requestSeqRef.current === requestId) {
        setLoadingByProfile((current) => ({ ...current, [profile]: false }));
      }
    }
  }

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
    refreshModelCatalog,
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

function modelCatalogRouteKey(runtimeConfig: HermesRuntimeConfig, profile: string) {
  return [
    runtimeConfig.gatewayUrl,
    runtimeConfig.agentuiGatewayUrls?.[profile] || "",
    runtimeConfig.profileApiUrls?.[profile] || "",
  ].join("|");
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

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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
  try {
    const parsed = JSON.parse(localStorage.getItem(modelSelectionStorageKey) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([profile, value]) => [profile, validSelection(value)])
        .filter((entry): entry is [string, HermesModelSelection] => Boolean(entry[0] && entry[1])),
    );
  } catch {
    return {};
  }
}

function saveStoredSelections(value: Record<string, HermesModelSelection>) {
  try {
    localStorage.setItem(modelSelectionStorageKey, JSON.stringify(value));
  } catch {
    // Session state is still enough if localStorage is unavailable.
  }
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
