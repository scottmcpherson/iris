import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Brain,
  CheckCircle2,
  Cpu,
  Download,
  FileCode2,
  KeyRound,
  MoreHorizontal,
  Package,
  Plus,
  RotateCcw,
  Save,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useCreateProfileAliasMutation,
  useDeleteProfileAliasMutation,
  useImportProfileArchiveMutation,
  useInstallProfileDistributionMutation,
  useProfileAliasQuery,
  useProfileConfigCheckMutation,
  useProfileIdentityQuery,
  useResetProfileSoulMutation,
  useSaveProfileConfigMutation,
  useSaveProfileSoulMutation,
  useUpdateProfileDistributionMutation,
  useUpdateProfileEnvMutation,
} from "../../lib/query";
import { getIrisCoreAgentForProfile, irisCoreProfileExportUrl } from "../../lib/irisCore";
import { CodeEditor } from "../../shared/CodeEditor";
import { Button } from "../../shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../shared/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/dropdown-menu";
import { Field, FieldLabel } from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import type { HermesRuntimeConfig } from "../../types/hermes";
import { normalizeProfileName, profileNameError } from "./profileNames";

type AgentConfigurationViewProps = {
  profile: string;
  runtimeConfig: HermesRuntimeConfig;
  connected: boolean;
  onRefresh: () => void;
  onOpenProfile: (profileName: string) => void;
};

type DistributionDialog = "import" | "install" | null;

export function AgentConfigurationView({
  profile,
  runtimeConfig,
  connected,
  onRefresh,
  onOpenProfile,
}: AgentConfigurationViewProps) {
  const identityQuery = useProfileIdentityQuery(runtimeConfig, profile, connected);
  const aliasQuery = useProfileAliasQuery(runtimeConfig, profile, connected);
  const identity = identityQuery.data;
  const [soulDraft, setSoulDraft] = useState("");
  const [configDraft, setConfigDraft] = useState("");
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [envDialogOpen, setEnvDialogOpen] = useState(false);
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [aliasDraft, setAliasDraft] = useState("");
  const [distributionDialog, setDistributionDialog] = useState<DistributionDialog>(null);
  const [importName, setImportName] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [distributionSource, setDistributionSource] = useState("");
  const [distributionName, setDistributionName] = useState("");
  const [configCheckOutput, setConfigCheckOutput] = useState("");
  const soulMutation = useSaveProfileSoulMutation(runtimeConfig, profile);
  const resetSoulMutation = useResetProfileSoulMutation(runtimeConfig, profile);
  const configMutation = useSaveProfileConfigMutation(runtimeConfig, profile);
  const envMutation = useUpdateProfileEnvMutation(runtimeConfig, profile);
  const checkMutation = useProfileConfigCheckMutation(runtimeConfig, profile);
  const createAliasMutation = useCreateProfileAliasMutation(runtimeConfig, profile);
  const deleteAliasMutation = useDeleteProfileAliasMutation(runtimeConfig, profile);
  const importArchiveMutation = useImportProfileArchiveMutation(runtimeConfig);
  const installDistributionMutation = useInstallProfileDistributionMutation(runtimeConfig);
  const updateDistributionMutation = useUpdateProfileDistributionMutation(runtimeConfig, profile);
  const soulDirty = Boolean(identity) && soulDraft !== (identity?.soul.content || "");
  const configDirty = Boolean(identity) && configDraft !== (identity?.config.raw || "");
  const normalizedImportName = normalizeProfileName(importName);
  const importNameError = importName ? profileNameError(normalizedImportName) : "";
  const normalizedDistributionName = normalizeProfileName(distributionName);
  const distributionNameError = distributionName ? profileNameError(normalizedDistributionName) : "";
  const envKeyError = envKey && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey.trim()) ? "Use a valid environment key." : "";
  const distribution = identity?.distribution;
  const alias = aliasQuery.data;
  const envKeys = identity?.env.keys || [];
  const provider = identity?.config.provider || "—";
  const model = identity?.config.model || "—";
  const reasoningEffortRaw = identity?.config.reasoningEffort?.trim() || "";
  const reasoningEffort = reasoningEffortRaw || (identity ? "medium (default)" : "—");

  useEffect(() => {
    if (!identity) return;
    setSoulDraft(identity.soul.content || "");
    setConfigDraft(identity.config.raw || "");
  }, [identity?.profile, identity?.soul.contentHash, identity?.config.contentHash]);

  if (!connected) {
    return <div className="profile-configuration-empty">Iris Core is offline.</div>;
  }

  return (
    <div className="profile-configuration-view grid content-start gap-3 min-w-0 min-h-0">
      <Card className="agent-overview-card profile-config-soul-card">
        <CardHeader>
          <CardTitle>
            <Brain className="agent-overview-card-icon" />
            <span>SOUL.md</span>
          </CardTitle>
          <CardDescription>{identity?.soul.path || identity?.path || "Loading profile…"}</CardDescription>
          <div className="flex flex-none row-start-1 row-span-2 col-start-2 gap-1.5">
            <Button
              variant="appIcon"
              size="icon-sm"
              type="button"
              title="Reset to default"
              aria-label="Reset SOUL.md"
              disabled={resetSoulMutation.isPending}
              onClick={() => void resetSoul()}
            >
              <RotateCcw />
            </Button>
            <Button
              variant="appIcon"
              size="icon-sm"
              type="button"
              title="Save SOUL.md"
              aria-label="Save SOUL.md"
              disabled={!soulDirty || soulMutation.isPending}
              onClick={() => void saveSoul()}
            >
              <Save />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid content-start gap-2.5 p-0">
          <CodeEditor
            value={soulDraft}
            onChange={setSoulDraft}
            spellCheck
            className="profile-config-editor min-h-[280px]"
            metadata={[{ label: "file", value: "SOUL.md" }]}
          />
          <div className={`profile-config-save-state ${soulDirty ? "dirty" : ""}`}>
            {soulDirty ? "Unsaved changes" : "Saved"}
          </div>
        </CardContent>
      </Card>

      <div className="profile-config-row-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-stretch gap-3 min-w-0">
        <Card className="agent-overview-card">
          <CardHeader>
            <CardTitle>
              <Cpu className="agent-overview-card-icon" />
              <span>Model</span>
            </CardTitle>
            <CardDescription>{identity?.config.path || "config.yaml"}</CardDescription>
            <div className="flex flex-none row-start-1 row-span-2 col-start-2 gap-1.5">
              <Button
                variant="appIcon"
                size="icon-sm"
                type="button"
                title="Run config check"
                aria-label="Run config check"
                disabled={checkMutation.isPending}
                onClick={() => void runConfigCheck()}
              >
                <Terminal />
              </Button>
              <Button
                variant="appIcon"
                size="icon-sm"
                type="button"
                title="Edit raw config.yaml"
                aria-label="Edit raw config.yaml"
                onClick={() => setConfigDialogOpen(true)}
              >
                <FileCode2 />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid content-start gap-2.5 p-0">
            <dl className="profile-config-summary grid gap-2 m-0">
              <div>
                <dt>Provider</dt>
                <dd>{provider}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{model}</dd>
              </div>
              <div>
                <dt>Reasoning effort</dt>
                <dd>{reasoningEffort}</dd>
              </div>
            </dl>
            {identity?.config.parseError ? (
              <p className="profile-config-warning">{identity.config.parseError}</p>
            ) : null}
            {configCheckOutput ? <pre className="profile-config-command-output">{configCheckOutput}</pre> : null}
          </CardContent>
        </Card>

        <Card className="agent-overview-card">
          <CardHeader>
            <CardTitle>
              <KeyRound className="agent-overview-card-icon" />
              <span>Environment</span>
            </CardTitle>
            <CardDescription>{identity?.env.path || ".env status unavailable"}</CardDescription>
            <div className="flex flex-none row-start-1 row-span-2 col-start-2 gap-1.5">
              <Button
                variant="appIcon"
                size="icon-sm"
                type="button"
                title="Add environment variable"
                aria-label="Add environment variable"
                onClick={() => {
                  setEnvKey("");
                  setEnvValue("");
                  setEnvDialogOpen(true);
                }}
              >
                <Plus />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid content-start gap-2.5 p-0">
            <div className="profile-config-pill-summary">
              {envKeys.length} {envKeys.length === 1 ? "variable" : "variables"}
            </div>
            <div className="profile-env-key-list flex flex-wrap gap-1.5 min-h-7">
              {envKeys.length ? envKeys.map((key) => <span key={key}>{key}</span>) : <em>No keys set</em>}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="profile-config-row-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-stretch gap-3 min-w-0">
        <Card className="agent-overview-card">
          <CardHeader>
            <CardTitle>
              <Package className="agent-overview-card-icon" />
              <span>Distribution</span>
            </CardTitle>
            <CardDescription>
              {distribution?.name
                ? `${distribution.name}${distribution.version ? ` · ${distribution.version}` : ""}`
                : "Local Hermes profile"}
            </CardDescription>
            <div className="flex flex-none row-start-1 row-span-2 col-start-2 gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="appIcon"
                    size="icon-sm"
                    type="button"
                    title="Distribution actions"
                    aria-label="Distribution actions"
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void exportProfile()}>
                    <Download />
                    <span>Export profile</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!distribution || updateDistributionMutation.isPending}
                    onClick={() => void updateDistribution()}
                  >
                    <Package />
                    <span>Update distribution</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => openDistributionDialog("import")}>
                    <Upload />
                    <span>Import archive…</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openDistributionDialog("install")}>
                    <Package />
                    <span>Install from source…</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardHeader>
          <CardContent className="grid content-start gap-2.5 p-0">
            <p className="profile-config-muted">
              {distribution?.source
                ? `Source: ${distribution.source}`
                : "Export to share this profile, or import an archive or install from a source."}
            </p>
          </CardContent>
        </Card>

        <Card className="agent-overview-card">
          <CardHeader>
            <CardTitle>
              <Terminal className="agent-overview-card-icon" />
              <span>CLI alias</span>
            </CardTitle>
            <CardDescription>{alias?.exists ? alias.path : "No wrapper alias found"}</CardDescription>
            <div className="flex flex-none row-start-1 row-span-2 col-start-2 gap-1.5">
              <Button
                variant="appIconDanger"
                size="icon-sm"
                type="button"
                title="Remove alias"
                aria-label="Remove alias"
                disabled={!alias?.exists || deleteAliasMutation.isPending}
                onClick={() => void removeAlias()}
              >
                <Trash2 />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid content-start gap-2.5 p-0">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-center">
              <Input
                value={aliasDraft}
                onChange={(event) => setAliasDraft(event.target.value)}
                placeholder={profile}
              />
              <Button
                size="appSmall"
                disabled={createAliasMutation.isPending}
                onClick={() => void createAlias()}
              >
                <CheckCircle2 data-icon="inline-start" />
                Create
              </Button>
            </div>
            {alias?.collision ? <p className="profile-config-warning">{alias.collision}</p> : null}
            {alias && !alias.inPath ? <p className="profile-config-muted">Alias directory is not on PATH.</p> : null}
          </CardContent>
        </Card>
      </div>

      <Dialog open={configDialogOpen} onOpenChange={setConfigDialogOpen}>
        <DialogContent className="profile-config-dialog w-[min(720px,92vw)] max-w-[min(720px,92vw)] sm:max-w-[min(720px,92vw)] max-h-[88vh] min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Edit config.yaml</DialogTitle>
            <DialogDescription>{identity?.config.path || "config.yaml"}</DialogDescription>
          </DialogHeader>
          <CodeEditor
            value={configDraft}
            onChange={setConfigDraft}
            className="profile-config-dialog-editor min-h-[280px] h-full"
            metadata={[{ label: "file", value: "config.yaml" }]}
          />
          <DialogFooter>
            <Button variant="appGhost" size="appSmall" onClick={() => setConfigDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="appSmall"
              disabled={!configDirty || configMutation.isPending}
              onClick={() => void saveConfig()}
            >
              <Save data-icon="inline-start" />
              Save config
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={envDialogOpen} onOpenChange={setEnvDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add environment variable</DialogTitle>
            <DialogDescription>Stored in {identity?.env.path || ".env"} for this agent.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="profile-env-key">Key</FieldLabel>
            <Input
              id="profile-env-key"
              value={envKey}
              onChange={(event) => setEnvKey(event.target.value.toUpperCase())}
              placeholder="OPENAI_API_KEY"
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="profile-env-value">Value</FieldLabel>
            <Input
              id="profile-env-value"
              type="password"
              value={envValue}
              onChange={(event) => setEnvValue(event.target.value)}
              placeholder="Secret value"
            />
          </Field>
          {envKeyError ? <p className="profile-config-warning">{envKeyError}</p> : null}
          <DialogFooter>
            <Button variant="appGhost" size="appSmall" onClick={() => setEnvDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="appSmall"
              disabled={!envKey.trim() || !envValue || Boolean(envKeyError) || envMutation.isPending}
              onClick={() => void updateEnv()}
            >
              <KeyRound data-icon="inline-start" />
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={distributionDialog === "import"}
        onOpenChange={(open) => {
          if (!open) setDistributionDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import profile archive</DialogTitle>
            <DialogDescription>Imports a .tar.gz exported from another Iris Core.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="profile-import-file">Archive</FieldLabel>
            <Input
              id="profile-import-file"
              type="file"
              accept=".tar.gz,.tgz,application/gzip"
              onChange={(event) => setImportFile(event.target.files?.[0] || null)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="profile-import-name">Target name</FieldLabel>
            <Input
              id="profile-import-name"
              value={importName}
              onChange={(event) => setImportName(event.target.value)}
              placeholder="target-profile"
            />
          </Field>
          {importNameError ? <p className="profile-config-warning">{importNameError}</p> : null}
          <DialogFooter>
            <Button variant="appGhost" size="appSmall" onClick={() => setDistributionDialog(null)}>
              Cancel
            </Button>
            <Button
              size="appSmall"
              disabled={!importFile || Boolean(importNameError) || importArchiveMutation.isPending}
              onClick={() => void importProfile()}
            >
              <Upload data-icon="inline-start" />
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={distributionDialog === "install"}
        onOpenChange={(open) => {
          if (!open) setDistributionDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install distribution</DialogTitle>
            <DialogDescription>Installs from a git URL or Iris Core local path.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="profile-install-source">Source</FieldLabel>
            <Input
              id="profile-install-source"
              value={distributionSource}
              onChange={(event) => setDistributionSource(event.target.value)}
              placeholder="git URL or Core-local path"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="profile-install-name">Target name</FieldLabel>
            <Input
              id="profile-install-name"
              value={distributionName}
              onChange={(event) => setDistributionName(event.target.value)}
              placeholder="target-profile"
            />
          </Field>
          {distributionNameError ? <p className="profile-config-warning">{distributionNameError}</p> : null}
          <DialogFooter>
            <Button variant="appGhost" size="appSmall" onClick={() => setDistributionDialog(null)}>
              Cancel
            </Button>
            <Button
              size="appSmall"
              disabled={!distributionSource.trim() || Boolean(distributionNameError) || installDistributionMutation.isPending}
              onClick={() => void installDistribution()}
            >
              <Package data-icon="inline-start" />
              Install
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  function openDistributionDialog(kind: "import" | "install") {
    setImportName("");
    setImportFile(null);
    setDistributionSource("");
    setDistributionName("");
    setDistributionDialog(kind);
  }

  async function saveSoul() {
    try {
      await soulMutation.mutateAsync({ content: soulDraft, expectedContentHash: identity?.soul.contentHash });
      toast.success("SOUL.md saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "SOUL.md save failed.");
    }
  }

  async function resetSoul() {
    if (soulDirty && !window.confirm("Reset SOUL.md and discard unsaved changes?")) return;
    try {
      await resetSoulMutation.mutateAsync({ expectedContentHash: identity?.soul.contentHash });
      toast.success("SOUL.md reset.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "SOUL.md reset failed.");
    }
  }

  async function saveConfig() {
    try {
      await configMutation.mutateAsync({ content: configDraft, expectedContentHash: identity?.config.contentHash });
      toast.success("config.yaml saved.");
      setConfigDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "config.yaml save failed.");
    }
  }

  async function updateEnv() {
    try {
      await envMutation.mutateAsync({ values: { [envKey.trim()]: envValue } });
      setEnvValue("");
      setEnvKey("");
      setEnvDialogOpen(false);
      toast.success("Secret updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Secret update failed.");
    }
  }

  async function runConfigCheck() {
    try {
      const result = await checkMutation.mutateAsync();
      const commands = "commands" in result && result.commands ? result.commands : {};
      const lines = Object.entries(commands).map(([name, command]) => {
        const body = [command.stdout, command.stderr, command.error].filter(Boolean).join("\n").trim();
        return `$ hermes config ${name}\n${body || (command.ok ? "ok" : "failed")}`;
      });
      setConfigCheckOutput(lines.join("\n\n"));
      if (result.ok) toast.success("Config check completed.");
      else toast.error(result.error || "Config check failed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Config check failed.");
    }
  }

  async function exportProfile() {
    const agentResult = await getIrisCoreAgentForProfile(profile, runtimeConfig);
    if (!agentResult.ok || !agentResult.agent) {
      toast.error(("error" in agentResult && agentResult.error) || "Could not resolve agent.");
      return;
    }
    window.open(irisCoreProfileExportUrl(agentResult.agent.id, runtimeConfig), "_blank", "noopener,noreferrer");
  }

  async function importProfile() {
    if (!importFile || importNameError) return;
    try {
      const result = await importArchiveMutation.mutateAsync({ file: importFile, name: normalizedImportName });
      toast.success("Profile imported.");
      setDistributionDialog(null);
      const nextProfile = result.profile || normalizedImportName;
      onRefresh();
      if (nextProfile) onOpenProfile(nextProfile);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Profile import failed.");
    }
  }

  async function installDistribution() {
    if (!distributionSource.trim() || distributionNameError) return;
    try {
      const result = await installDistributionMutation.mutateAsync({
        source: distributionSource.trim(),
        name: normalizedDistributionName,
      });
      toast.success("Distribution installed.");
      setDistributionDialog(null);
      const nextProfile = result.profile || normalizedDistributionName;
      onRefresh();
      if (nextProfile) onOpenProfile(nextProfile);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Distribution install failed.");
    }
  }

  async function updateDistribution() {
    try {
      await updateDistributionMutation.mutateAsync({ forceConfig: false });
      toast.success("Distribution updated.");
      onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Distribution update failed.");
    }
  }

  async function createAlias() {
    try {
      await createAliasMutation.mutateAsync(aliasDraft || profile);
      toast.success("Alias created.");
      setAliasDraft("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Alias creation failed.");
    }
  }

  async function removeAlias() {
    try {
      await deleteAliasMutation.mutateAsync(alias?.alias || profile);
      toast.success("Alias removed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Alias removal failed.");
    }
  }
}
