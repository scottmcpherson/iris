import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Cpu,
  Database,
  Layers3,
  LayoutPanelLeft,
} from "lucide-react";
import { resolveManagementApiUrl, resolveRuntimeApiUrl } from "../../app/runtimeConfig";
import type { ProfileAction, ProfileActionHandler } from "../../app/types";
import {
  deleteRemoteCredential,
  getRemoteCredentialStatus,
  saveRemoteCredential,
} from "../../lib/hermes";
import { endpointLabel } from "../../shared/format";
import type {
  HermesProfile,
  HermesRuntimeConfig,
  HermesStatus,
  RemoteCredentialStatus,
} from "../../types/hermes";

type SettingsViewProps = {
  status: HermesStatus | null;
  profile: HermesProfile;
  selectedProfile: string;
  runtimeConfig: HermesRuntimeConfig;
  mode: "settings" | "profile";
  onRuntimeChange: (config: HermesRuntimeConfig) => void;
  onRefresh: () => void;
  onProfileAction: ProfileActionHandler;
};

export function SettingsView({
  status,
  profile,
  selectedProfile,
  runtimeConfig,
  mode,
  onRuntimeChange,
  onRefresh,
  onProfileAction,
}: SettingsViewProps) {
  const [draftConfig, setDraftConfig] = useState(runtimeConfig);
  const [profileName, setProfileName] = useState("");
  const [notice, setNotice] = useState("");
  const [hermesToken, setHermesToken] = useState("");
  const [sidecarToken, setSidecarToken] = useState("");
  const [hermesCredentialStatus, setHermesCredentialStatus] = useState<RemoteCredentialStatus | null>(null);
  const [sidecarCredentialStatus, setSidecarCredentialStatus] = useState<RemoteCredentialStatus | null>(null);
  const [coreApiInput, setCoreApiInput] = useState("");
  const [hermesApiInput, setHermesApiInput] = useState("");
  const [sidecarApiInput, setSidecarApiInput] = useState("");
  const selectedProfileApiUrl = draftConfig.profileApiUrls?.[selectedProfile] || "";
  const selectedProfileSidecarUrl =
    draftConfig.profileSidecarUrls?.[selectedProfile] || resolveManagementApiUrl(draftConfig, selectedProfile);
  const appliedApiUrl = status?.activeApiUrl || resolveRuntimeApiUrl(runtimeConfig, selectedProfile);
  const draftResolvedApiUrl = normalizeServerUrl(hermesApiInput);
  const pendingApiUrl = draftResolvedApiUrl !== appliedApiUrl ? draftResolvedApiUrl : "";
  const selectedApiStatus = endpointLabel(status?.activeApiStatus);
  const appliedManagementApiUrl = status?.managementApiUrl || resolveManagementApiUrl(runtimeConfig, selectedProfile);
  const draftCoreApiUrl = normalizeServerUrl(coreApiInput);
  const pendingCoreApiUrl = draftCoreApiUrl !== appliedManagementApiUrl ? draftCoreApiUrl : "";
  const draftManagementApiUrl = normalizeServerUrl(sidecarApiInput);
  const pendingManagementApiUrl =
    draftManagementApiUrl !== appliedManagementApiUrl ? draftManagementApiUrl : "";
  const profileCount = status?.profiles?.length ?? 1;
  const checkedAt = status?.checkedAt ? formatTimestamp(status.checkedAt) : "Not checked";
  const modelDisplay = modelSummary(profile.provider, profile.model);

  useEffect(() => {
    setDraftConfig(runtimeConfig);
  }, [runtimeConfig]);

  useEffect(() => {
    setHermesApiInput(serverUrlInput(selectedProfileApiUrl));
    setSidecarApiInput(serverUrlInput(selectedProfileSidecarUrl));
  }, [selectedProfile, selectedProfileApiUrl, selectedProfileSidecarUrl]);

  useEffect(() => {
    setCoreApiInput(serverUrlInput(runtimeConfig.managementApiUrl));
  }, [runtimeConfig.managementApiUrl]);

  useEffect(() => {
    void refreshCredentialStatus();
  }, []);

  function updateDraft<Key extends keyof HermesRuntimeConfig>(
    key: Key,
    value: HermesRuntimeConfig[Key],
  ) {
    setDraftConfig((current) => ({ ...current, [key]: value }));
  }

  function applyRuntimeConfig(message: string) {
    onRuntimeChange(draftConfig);
    setNotice(message);
  }

  function saveProfileConnection() {
    const profileApiUrls = { ...(draftConfig.profileApiUrls || {}) };
    const profileSidecarUrls = { ...(draftConfig.profileSidecarUrls || {}) };
    const apiUrl = normalizeServerUrl(hermesApiInput);
    const sidecarUrl = normalizeServerUrl(sidecarApiInput);

    if (!apiUrl || !sidecarUrl) {
      setNotice("Enter full URLs with protocol and port, like http://127.0.0.1:8643.");
      return;
    }

    profileApiUrls[selectedProfile] = apiUrl;
    profileSidecarUrls[selectedProfile] = sidecarUrl;

    const nextConfig = { ...draftConfig, profileApiUrls, profileSidecarUrls };
    setDraftConfig(nextConfig);
    onRuntimeChange(nextConfig);
    setNotice(`${selectedProfile} connection saved.`);
  }

  function saveCoreConnection() {
    const coreUrl = normalizeServerUrl(coreApiInput);
    if (!coreUrl) {
      setNotice("Enter a full Iris Core URL with protocol and port, like http://127.0.0.1:8765.");
      return;
    }
    const nextConfig = { ...draftConfig, managementApiUrl: coreUrl };
    setDraftConfig(nextConfig);
    onRuntimeChange(nextConfig);
    setNotice("Iris Core connection saved.");
  }

  async function runProfileAction(action: ProfileAction) {
    const message = await onProfileAction(action, profileName);
    setNotice(message);
    if (action !== "switch") setProfileName("");
  }

  async function refreshCredentialStatus() {
    const unavailable: RemoteCredentialStatus = { ok: false, kind: "hermes", exists: false, source: "unavailable" };
    try {
      const [hermesResult, sidecarResult] = await Promise.all([
        getRemoteCredentialStatus("hermes"),
        getRemoteCredentialStatus("sidecar"),
      ]);
      setHermesCredentialStatus(hermesResult);
      setSidecarCredentialStatus(sidecarResult);
    } catch {
      setHermesCredentialStatus(unavailable);
      setSidecarCredentialStatus({ ...unavailable, kind: "sidecar" });
    }
  }

  async function saveToken(kind: "hermes" | "sidecar") {
    const token = kind === "hermes" ? hermesToken : sidecarToken;
    const result = await saveRemoteCredential(kind, token);
    if (kind === "hermes") {
      setHermesCredentialStatus(result);
      if (result.ok) setHermesToken("");
    } else {
      setSidecarCredentialStatus(result);
      if (result.ok) setSidecarToken("");
    }
    setNotice(result.ok ? `${credentialLabel(kind)} token saved to the OS credential store.` : result.error || "Token save failed.");
  }

  async function clearToken(kind: "hermes" | "sidecar") {
    const result = await deleteRemoteCredential(kind);
    if (kind === "hermes") {
      setHermesCredentialStatus(result);
      setHermesToken("");
    } else {
      setSidecarCredentialStatus(result);
      setSidecarToken("");
    }
    setNotice(result.ok ? `${credentialLabel(kind)} token cleared.` : result.error || "Token clear failed.");
  }

  return (
    <div className="tool-view settings-view">
      <div className="settings-toolbar">
        <span />
        <button className="small-button settings-button" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      {mode === "settings" ? (
        <>
          <SettingsSection
            eyebrow="Application"
            title="App settings"
            detail="Optional provider and model overrides used by outgoing runtime requests."
          >
            <RuntimeTextField
              id="provider"
              label="Provider override"
              value={draftConfig.provider}
              placeholder="openai, nous, anthropic"
              onChange={(value) => updateDraft("provider", value)}
            />
            <RuntimeTextField
              id="model"
              label="Model override"
              value={draftConfig.model}
              placeholder="hermes-4, gpt-5.2"
              onChange={(value) => updateDraft("model", value)}
            />
            <div className="settings-actions">
              <button className="small-button settings-button" onClick={() => applyRuntimeConfig("App settings saved.")}>
                Save app settings
              </button>
            </div>
          </SettingsSection>

          <SettingsSection
            eyebrow="Core"
            title="Iris Core connection"
            detail="Local or private-network Core API used by Iris Desktop and future remote clients."
          >
            <ServiceCard
              name="Iris Core"
              healthy={Boolean(status?.managementStatus?.ok)}
              statusLabel={healthLabel(status?.managementStatus)}
              statusTitle={endpointLabel(status?.managementStatus)}
              lastChecked={checkedAt}
              pendingUrl={pendingCoreApiUrl}
            >
              <RuntimeTextField
                id="core-api-route"
                label="URL"
                value={coreApiInput}
                placeholder="http://127.0.0.1:8765"
                onChange={setCoreApiInput}
              />
              <TokenField
                id="core-api-token"
                label="Token"
                value={sidecarToken}
                status={sidecarCredentialStatus}
                onChange={setSidecarToken}
                onSave={() => void saveToken("sidecar")}
                onClear={() => void clearToken("sidecar")}
              />
            </ServiceCard>
            <div className="settings-actions">
              <button className="small-button settings-button" onClick={saveCoreConnection}>
                Save Core connection
              </button>
            </div>
          </SettingsSection>

          <section className="settings-section">
            <div className="settings-section-header">
              <div>
                <p className="eyebrow">Profiles</p>
                <h2>{profileCount} {profileCount === 1 ? "profile" : "profiles"}</h2>
                <span>{status?.root || "~/.hermes"}</span>
              </div>
            </div>
            <div className="usage-dashboard">
              {(status?.profiles ?? [profile]).map((item) => (
                <article key={item.name} className={item.name === selectedProfile ? "usage-card active" : "usage-card"}>
                  <span>{item.name}</span>
                  <strong>{item.sessionCount}</strong>
                  <small>
                    {item.estimatedCostUsd == null ? "Cost unavailable" : `$${item.estimatedCostUsd.toFixed(4)} estimated`}
                  </small>
                </article>
              ))}
            </div>
          </section>

        </>
      ) : (
        <>
          <SettingsSection
            eyebrow="Connection"
            title="Routes and credentials"
            detail="Hermes API, Iris Core, and their bearer tokens."
          >
            <div className="service-card-grid">
              <ServiceCard
                name="Hermes API"
                healthy={Boolean(status?.activeApiStatus?.ok)}
                statusLabel={healthLabel(status?.activeApiStatus)}
                statusTitle={selectedApiStatus}
                lastChecked={checkedAt}
                pendingUrl={pendingApiUrl}
              >
                <RuntimeTextField
                  id="profile-api-route"
                  label="URL"
                  value={hermesApiInput}
                  placeholder="http://127.0.0.1:8643"
                  onChange={setHermesApiInput}
                />
                <TokenField
                  id="profile-hermes-token"
                  label="Token"
                  value={hermesToken}
                  status={hermesCredentialStatus}
                  onChange={setHermesToken}
                  onSave={() => void saveToken("hermes")}
                  onClear={() => void clearToken("hermes")}
                />
              </ServiceCard>
              <ServiceCard
                name="Iris Core"
                healthy={Boolean(status?.managementStatus?.ok)}
                statusLabel={healthLabel(status?.managementStatus)}
                statusTitle={endpointLabel(status?.managementStatus)}
                lastChecked={checkedAt}
                pendingUrl={pendingManagementApiUrl}
              >
                <RuntimeTextField
                  id="profile-sidecar-route"
                  label="URL"
                  value={sidecarApiInput}
                  placeholder="http://127.0.0.1:8765"
                  onChange={setSidecarApiInput}
                />
                <TokenField
                  id="profile-sidecar-token"
                  label="Token"
                  value={sidecarToken}
                  status={sidecarCredentialStatus}
                  onChange={setSidecarToken}
                  onSave={() => void saveToken("sidecar")}
                  onClear={() => void clearToken("sidecar")}
                />
              </ServiceCard>
            </div>
            <div className="settings-actions">
              <button className="small-button settings-button" onClick={saveProfileConnection}>
                Save profile connection
              </button>
            </div>
          </SettingsSection>

          <section className="settings-section model-section">
            <div className="settings-section-header">
              <div>
                <p className="eyebrow">Model</p>
                <h2>Runtime configuration</h2>
                <span>Selected model and provider details.</span>
              </div>
            </div>
            <ModelCard summary={modelDisplay} rawModel={profile.model} provider={profile.provider} />
          </section>

          <div className="agent-metadata-strip">
            <SettingsRow icon={<LayoutPanelLeft size={17} />} label="Hermes root" value={status?.root || "~/.hermes"} />
            <SettingsRow icon={<Layers3 size={17} />} label="Sessions" value={`${profile.sessionCount} sessions`} />
            <SettingsRow
              icon={<Database size={17} />}
              label="Estimated cost"
              value={profile.estimatedCostUsd == null ? "Unavailable" : `$${profile.estimatedCostUsd.toFixed(4)}`}
            />
          </div>
          <ProfileWorkflows
            profileName={profileName}
            onProfileNameChange={setProfileName}
            onProfileAction={runProfileAction}
          />
        </>
      )}

      {notice ? <p className="settings-notice">{notice}</p> : null}
    </div>
  );
}

function ProfileWorkflows({
  profileName,
  onProfileNameChange,
  onProfileAction,
}: {
  profileName: string;
  onProfileNameChange: (value: string) => void;
  onProfileAction: (action: ProfileAction) => Promise<void>;
}) {
  return (
    <div className="profile-workflows">
      <div>
        <p className="eyebrow">Profile management</p>
        <h2>Create, clone, rename, switch, or delete profiles.</h2>
      </div>
      <input
        value={profileName}
        placeholder="new-profile-name"
        onChange={(event) => onProfileNameChange(event.target.value)}
      />
      <div className="profile-actions">
        <button className="small-button settings-button" onClick={() => void onProfileAction("create")}>
          Create
        </button>
        <button className="small-button settings-button" onClick={() => void onProfileAction("clone")}>
          Clone
        </button>
        <button className="small-button settings-button" onClick={() => void onProfileAction("rename")}>
          Rename
        </button>
        <button className="small-button settings-button" onClick={() => void onProfileAction("switch")}>
          Switch
        </button>
        <button className="small-button settings-button danger" onClick={() => void onProfileAction("delete")}>
          Delete current
        </button>
      </div>
    </div>
  );
}

function ServiceCard({
  name,
  healthy,
  statusLabel,
  statusTitle,
  lastChecked,
  pendingUrl,
  children,
}: {
  name: string;
  healthy: boolean;
  statusLabel: string;
  statusTitle: string;
  lastChecked: string;
  pendingUrl: string;
  children: ReactNode;
}) {
  return (
    <article className="service-card">
      <header>
        <div>
          <span className={healthy ? "service-health-dot online" : "service-health-dot offline"} />
          <strong>{name}</strong>
        </div>
        <small title={statusTitle}>
          {statusLabel} · {lastChecked}
        </small>
      </header>
      <div className="service-card-fields">{children}</div>
      {pendingUrl ? (
        <footer>
          <em>Unsaved URL: {pendingUrl}</em>
        </footer>
      ) : null}
    </article>
  );
}

function ModelCard({
  summary,
  rawModel,
  provider,
}: {
  summary: { model: string; provider: string; config: string };
  rawModel: string;
  provider: string;
}) {
  return (
    <details className="model-card">
      <summary>
        <Cpu size={17} />
        <span>
          <strong>{summary.model}</strong>
          <small>{summary.provider}</small>
        </span>
        <em>Configuration</em>
      </summary>
      <pre>{summary.config || prettyModelConfig(rawModel, provider)}</pre>
    </details>
  );
}

function TokenField({
  id,
  label,
  value,
  status,
  onChange,
  onSave,
  onClear,
}: {
  id: string;
  label: string;
  value: string;
  status: RemoteCredentialStatus | null;
  onChange: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const storedLabel = status?.exists ? `Stored via ${status.source}` : "Not stored";
  return (
    <div className="runtime-field wide token-field">
      <label htmlFor={id}>{label}</label>
      <div className="token-input-row">
        <input
          id={id}
          type="password"
          value={value}
          placeholder={status?.exists ? storedLabel : "Bearer token"}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <div className="token-actions-row">
        <button className="small-button settings-button" disabled={!value.trim()} onClick={onSave}>
          Save
        </button>
        <button className="small-button settings-button" disabled={!status?.exists} onClick={onClear}>
          Clear
        </button>
      </div>
      <span>{storedLabel}</span>
    </div>
  );
}

function SettingsSection({
  eyebrow,
  title,
  detail,
  children,
}: {
  eyebrow: string;
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
          <span>{detail}</span>
        </div>
      </div>
      <div className="runtime-panel">{children}</div>
    </section>
  );
}

function RuntimeTextField({
  id,
  label,
  value,
  placeholder,
  type = "text",
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  type?: "text" | "password";
  onChange: (value: string) => void;
}) {
  return (
    <div className="runtime-field wide">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function SettingsRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="settings-row">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function healthLabel(status: HermesStatus["activeApiStatus"]) {
  if (!status) return "Not checked";
  if (status.ok) return "Healthy";
  return "Offline";
}

function modelSummary(provider: string, model: string) {
  const parsed = parseModelConfig(model);
  const resolvedProvider = stringValue(parsed?.provider) || provider || "Provider unavailable";
  const resolvedModel = stringValue(parsed?.default) || stringValue(parsed?.model) || model || "Model unavailable";
  return {
    model: resolvedModel,
    provider: resolvedProvider,
    config: parsed ? JSON.stringify(parsed, null, 2) : prettyModelConfig(model, provider),
  };
}

function parseModelConfig(model: string): Record<string, unknown> | null {
  const trimmed = model.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return JSON.parse(trimmed.replace(/'/g, "\""));
    } catch {
      return null;
    }
  }
}

function prettyModelConfig(model: string, provider: string) {
  return JSON.stringify({ provider, model }, null, 2);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function formatTimestamp(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value * 1000));
}

function serverUrlInput(apiUrl: string) {
  const trimmed = apiUrl.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    const path = normalizePathname(url.pathname);
    if (!path || path === "/" || path === "/v1") return url.origin;
  } catch {
    return trimmed;
  }

  return trimmed;
}

function normalizeServerUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || !url.port) return "";
    const path = normalizePathname(url.pathname);
    if (path && path !== "/" && path !== "/v1") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function normalizePathname(pathname: string) {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function credentialLabel(kind: "hermes" | "sidecar") {
  return kind === "hermes" ? "Hermes API" : "Iris Core";
}
