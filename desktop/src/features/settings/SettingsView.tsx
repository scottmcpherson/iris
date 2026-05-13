import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Cpu,
  Database,
  Layers3,
  LayoutPanelLeft,
} from "lucide-react";
import { resolveCoreApiUrl } from "../../app/runtimeConfig";
import type { ProfileAction, ProfileActionHandler } from "../../app/types";
import {
  deleteRemoteCredential,
  getRemoteCredentialStatus,
  saveRemoteCredential,
} from "../../lib/irisRuntime";
import { endpointLabel } from "../../shared/format";
import { rawStringValue } from "../../shared/strings";
import { Alert, AlertDescription } from "../../shared/ui/alert";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardContent, CardHeader } from "../../shared/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../shared/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
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
  const [coreToken, setCoreToken] = useState("");
  const [coreCredentialStatus, setCoreCredentialStatus] = useState<RemoteCredentialStatus | null>(null);
  const [coreApiInput, setCoreApiInput] = useState("");
  const appliedManagementApiUrl = status?.coreApiUrl || resolveCoreApiUrl(runtimeConfig);
  const draftCoreApiUrl = normalizeServerUrl(coreApiInput);
  const pendingCoreApiUrl = draftCoreApiUrl !== appliedManagementApiUrl ? draftCoreApiUrl : "";
  const profileCount = status?.profiles?.length ?? 1;
  const checkedAt = status?.checkedAt ? formatTimestamp(status.checkedAt) : "Not checked";
  const modelDisplay = modelSummary(profile.provider, profile.model);

  useEffect(() => {
    setDraftConfig(runtimeConfig);
  }, [runtimeConfig]);

  useEffect(() => {
    setCoreApiInput(serverUrlInput(runtimeConfig.coreApiUrl));
  }, [runtimeConfig.coreApiUrl]);

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

  async function saveCoreConnection() {
    const coreUrl = normalizeServerUrl(coreApiInput);
    if (!coreUrl) {
      setNotice("Enter a full Iris Core URL with protocol and port, like http://127.0.0.1:8765.");
      return;
    }
    const nextConfig = { ...draftConfig, coreApiUrl: coreUrl };
    setDraftConfig(nextConfig);
    onRuntimeChange(nextConfig);

    const token = coreToken.trim();
    if (!token) {
      setNotice("Iris Core connection saved.");
      return;
    }

    const result = await saveRemoteCredential("core", token);
    setCoreCredentialStatus(result);
    if (result.ok) {
      setCoreToken("");
      setNotice("Iris Core connection and token saved.");
      return;
    }
    setNotice(result.error || "Iris Core URL saved, but token save failed.");
  }

  async function runProfileAction(action: ProfileAction) {
    const message = await onProfileAction(action, profileName);
    setNotice(message);
    if (action !== "switch") setProfileName("");
  }

  async function refreshCredentialStatus() {
    const unavailable: RemoteCredentialStatus = { ok: false, kind: "core", exists: false, source: "unavailable" };
    try {
      const coreResult = await getRemoteCredentialStatus("core");
      setCoreCredentialStatus(coreResult);
    } catch {
      setCoreCredentialStatus(unavailable);
    }
  }

  async function saveToken(kind: "core") {
    const token = coreToken;
    const result = await saveRemoteCredential(kind, token);
    setCoreCredentialStatus(result);
    if (result.ok) setCoreToken("");
    setNotice(result.ok ? `${credentialLabel(kind)} token saved to the OS credential store.` : result.error || "Token save failed.");
  }

  async function clearToken(kind: "core") {
    const result = await deleteRemoteCredential(kind);
    setCoreCredentialStatus(result);
    setCoreToken("");
    setNotice(result.ok ? `${credentialLabel(kind)} token cleared.` : result.error || "Token clear failed.");
  }

  return (
    <div className="tool-view settings-view">
      <div className="settings-toolbar">
        <span />
        <Button variant="appNeutral" size="appSmall" onClick={onRefresh}>
          Refresh
        </Button>
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
              <Button variant="appNeutral" size="appSmall" onClick={() => applyRuntimeConfig("App settings saved.")}>
                Save app settings
              </Button>
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
                value={coreToken}
                status={coreCredentialStatus}
                onChange={setCoreToken}
                onSave={() => void saveToken("core")}
                onClear={() => void clearToken("core")}
              />
            </ServiceCard>
            <div className="settings-actions">
              <Button variant="appNeutral" size="appSmall" onClick={() => void saveCoreConnection()}>
                Save Core connection
              </Button>
            </div>
          </SettingsSection>

          <section className="settings-section">
            <div className="settings-section-header">
              <div>
                <p className="eyebrow">Agents</p>
                <h2>{profileCount} {profileCount === 1 ? "agent" : "agents"}</h2>
                <span>{status?.coreApiUrl || resolveCoreApiUrl(runtimeConfig)}</span>
              </div>
            </div>
            <div className="usage-dashboard">
              {(status?.profiles ?? [profile]).map((item) => (
                <Card key={item.name} className={item.name === selectedProfile ? "usage-card active" : "usage-card"}>
                  <span>{item.name}</span>
                  <strong>{item.sessionCount}</strong>
                  <small>
                    {item.estimatedCostUsd == null ? "Cost unavailable" : `$${item.estimatedCostUsd.toFixed(4)} estimated`}
                  </small>
                </Card>
              ))}
            </div>
          </section>

        </>
      ) : (
        <>
          <SettingsSection
            title="Routes and credentials"
            variant="plain"
          >
            <Card className="core-connection-form">
              <CardHeader className="core-connection-heading">
                <div className="core-connection-title">
                  <span className={status?.managementStatus?.ok ? "service-health-dot online" : "service-health-dot offline"} />
                  <strong>Iris Core</strong>
                </div>
                <Badge variant={status?.managementStatus?.ok ? "secondary" : "outline"} title={endpointLabel(status?.managementStatus)}>
                  {healthLabel(status?.managementStatus)} · {checkedAt}
                </Badge>
              </CardHeader>
              <CardContent className="core-connection-fields">
                <RuntimeTextField
                  id="profile-core-route"
                  label="URL"
                  value={coreApiInput}
                  placeholder="http://127.0.0.1:8765"
                  onChange={setCoreApiInput}
                />
                <TokenField
                  id="profile-core-token"
                  label="Token"
                  value={coreToken}
                  status={coreCredentialStatus}
                  onChange={setCoreToken}
                  onSave={() => void saveToken("core")}
                  onClear={() => void clearToken("core")}
                  actions="none"
                />
              </CardContent>
              {pendingCoreApiUrl ? <em className="core-connection-pending">Unsaved URL: {pendingCoreApiUrl}</em> : null}
              <div className="core-connection-actions">
                <Button
                  type="button"
                  variant="appLink"
                  disabled={!coreCredentialStatus?.exists}
                  onClick={() => void clearToken("core")}
                >
                  Clear stored token
                </Button>
                <Button variant="appNeutral" size="appSmall" onClick={() => void saveCoreConnection()}>
                  Save Core connection
                </Button>
              </div>
            </Card>
          </SettingsSection>

          <section className="settings-section model-section">
            <div className="settings-section-header">
              <div>
                <h2>Runtime configuration</h2>
              </div>
            </div>
            <ModelCard summary={modelDisplay} rawModel={profile.model} provider={profile.provider} />
          </section>

          <div className="agent-metadata-strip">
            <SettingsRow icon={<LayoutPanelLeft size={17} />} label="Runtime" value={selectedProfile} />
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

      {notice ? (
        <Alert className="settings-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
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
    <Card className="profile-workflows">
      <div>
        <h2>Agent management</h2>
      </div>
      <Input
        value={profileName}
        placeholder="new-agent-name"
        onChange={(event) => onProfileNameChange(event.target.value)}
      />
      <div className="profile-actions">
        <Button variant="appNeutral" size="appSmall" onClick={() => void onProfileAction("create")}>
          Create
        </Button>
        <Button variant="appNeutral" size="appSmall" onClick={() => void onProfileAction("clone")}>
          Clone
        </Button>
        <Button variant="appNeutral" size="appSmall" onClick={() => void onProfileAction("rename")}>
          Rename
        </Button>
        <Button variant="appNeutral" size="appSmall" onClick={() => void onProfileAction("switch")}>
          Switch
        </Button>
        <Button variant="appDanger" size="appSmall" onClick={() => void onProfileAction("delete")}>
          Delete current
        </Button>
      </div>
    </Card>
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
    <Card className="service-card">
      <CardHeader>
        <div className="service-card-title">
          <span className={healthy ? "service-health-dot online" : "service-health-dot offline"} />
          <strong>{name}</strong>
        </div>
        <Badge variant={healthy ? "secondary" : "outline"} title={statusTitle}>
          {statusLabel} · {lastChecked}
        </Badge>
      </CardHeader>
      <CardContent className="service-card-fields">{children}</CardContent>
      {pendingUrl ? (
        <footer>
          <em>Unsaved URL: {pendingUrl}</em>
        </footer>
      ) : null}
    </Card>
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
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="model-card">
      <CollapsibleTrigger className="model-card-summary">
        <Cpu size={17} />
        <span>
          <strong>{summary.model}</strong>
          <small>{summary.provider}</small>
        </span>
        <em>Configuration</em>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre>{summary.config || prettyModelConfig(rawModel, provider)}</pre>
      </CollapsibleContent>
    </Collapsible>
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
  actions = "inline",
}: {
  id: string;
  label: string;
  value: string;
  status: RemoteCredentialStatus | null;
  onChange: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
  actions?: "inline" | "none";
}) {
  const storedLabel = status?.exists ? `Stored via ${status.source}` : "Not stored";
  return (
    <Field className="runtime-field wide token-field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="token-input-row">
        <Input
          id={id}
          type="password"
          value={value}
          placeholder={status?.exists ? storedLabel : "Bearer token"}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      {actions === "inline" ? (
        <div className="token-actions-row">
          <Button variant="appNeutral" size="appSmall" disabled={!value.trim()} onClick={onSave}>
            Save
          </Button>
          <Button variant="appNeutral" size="appSmall" disabled={!status?.exists} onClick={onClear}>
            Clear
          </Button>
        </div>
      ) : null}
      <FieldDescription>{storedLabel}</FieldDescription>
    </Field>
  );
}

function SettingsSection({
  eyebrow,
  title,
  detail,
  variant = "panel",
  children,
}: {
  eyebrow?: string;
  title: string;
  detail?: string;
  variant?: "panel" | "plain";
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <div>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h2>{title}</h2>
          {detail ? <span>{detail}</span> : null}
        </div>
      </div>
      {variant === "panel" ? <Card className="runtime-panel">{children}</Card> : children}
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
    <Field className="runtime-field wide">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
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
  const resolvedProvider = rawStringValue(parsed?.provider) || provider || "Provider unavailable";
  const resolvedModel = rawStringValue(parsed?.default) || rawStringValue(parsed?.model) || model || "Model unavailable";
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

function credentialLabel(_kind: "core") {
  return "Iris Core";
}
