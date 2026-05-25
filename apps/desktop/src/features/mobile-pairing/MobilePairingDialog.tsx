import { useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import QRCode from "qrcode";
import { Copy, RefreshCw, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { activeCoreConnection, defaultCorePort } from "../../app/runtimeConfig";
import { Button } from "../../shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import { Field, FieldLabel } from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import { coreRequest } from "../../lib/coreTransport";
import type { HermesRuntimeConfig } from "../../types/hermes";
import {
  coreUrlFromDraft,
  createMobilePairingPayload,
  defaultMobilePairingDraft,
  draftWithPreferredMobileHost,
  pairingPayloadHasSecrets,
  validateMobilePairingPayload,
  type MobilePairingCode,
  type MobilePairingDraft,
} from "./mobilePairing";

type MobilePairingDialogProps = {
  open: boolean;
  runtimeConfig: HermesRuntimeConfig;
  onOpenChange: (open: boolean) => void;
};

type CoreSidecarStatus = {
  ready: boolean;
  startedByApp: boolean;
  bindHost: string;
  port: number;
  error: string;
};

export function MobilePairingDialog({ open, runtimeConfig, onOpenChange }: MobilePairingDialogProps) {
  const [draft, setDraft] = useState<MobilePairingDraft>(() => defaultMobilePairingDraft(runtimeConfig));
  const [pairingCode, setPairingCode] = useState<MobilePairingCode | null>(null);
  const [pairingError, setPairingError] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const payload = useMemo(() => createMobilePairingPayload(draft, pairingCode), [draft, pairingCode]);
  const payloadText = useMemo(() => JSON.stringify(payload, null, 2), [payload]);
  const expiresAt = payload.pairing.expiresAt ? new Date(payload.pairing.expiresAt * 1000).toLocaleTimeString() : "Not generated";
  const payloadIsValid = validateMobilePairingPayload(payload);
  const payloadHasSecrets = pairingPayloadHasSecrets(payload);
  const canScanPayload = payloadIsValid && !payloadHasSecrets && !pairingBusy;
  const payloadStatus = payloadStatusText(draft, pairingCode, payloadIsValid, payloadHasSecrets, pairingBusy, pairingError);

  useEffect(() => {
    let cancelled = false;

    if (open) {
      void preparePairingDraft().then((nextDraft) => {
        if (cancelled) return;
        setDraft(nextDraft);
        void regeneratePairingCode(nextDraft);
      });
    } else {
      setPairingCode(null);
      setPairingError("");
    }

    async function preparePairingDraft() {
      const nextDraft = defaultMobilePairingDraft(runtimeConfig);
      if (nextDraft.coreHost.trim()) return nextDraft;
      const tailscaleHost = await tailscaleSelfHost();
      if (tailscaleHost) return { ...nextDraft, coreHost: tailscaleHost };
      const candidates = await mobilePairingHostCandidates();
      return draftWithPreferredMobileHost(nextDraft, candidates);
    }

    return () => {
      cancelled = true;
    };
  }, [open, runtimeConfig]);

  useEffect(() => {
    if (!canScanPayload) {
      setQrDataUrl("");
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(JSON.stringify(payload), { margin: 1, width: 240 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [canScanPayload, payload]);

  async function copyPayload() {
    if (!canScanPayload) return;
    await navigator.clipboard.writeText(payloadText);
    toast.success("Mobile pairing payload copied.");
  }

  async function copyCode() {
    if (!pairingCode?.code) return;
    await navigator.clipboard.writeText(pairingCode.code);
    toast.success("Pairing code copied.");
  }

  async function regeneratePairingCode(nextDraft = draft) {
    setPairingBusy(true);
    setPairingError("");
    setPairingCode(null);
    const coreUrl = coreUrlFromDraft(nextDraft);
    if (!coreUrl) {
      setPairingBusy(false);
      setPairingError("Enter a Tailscale-reachable Core host before scanning.");
      return;
    }
    const mobileCore = await ensureManagedCoreForMobilePairing(runtimeConfig, nextDraft);
    if (!mobileCore.ok) {
      setPairingBusy(false);
      setPairingError(mobileCore.error);
      toast.error(mobileCore.error);
      return;
    }
    const result = await coreRequest<{ code: string; expiresAt: number }>(
      runtimeConfig,
      "POST",
      "/mobile/pairing-codes",
      {
        hostLabel: nextDraft.hostLabel,
        coreUrl,
        metadata: { source: "iris-desktop" },
      },
      { timeoutMs: 5000 },
    );
    setPairingBusy(false);
    if (!result.ok || !result.code || !result.expiresAt) {
      const error = result.error || "Could not create a mobile pairing code.";
      setPairingError(error);
      toast.error(error);
      return;
    }
    setPairingCode({ code: result.code, expiresAt: result.expiresAt });
  }

  function updateDraft(nextDraft: MobilePairingDraft) {
    setDraft(nextDraft);
    setPairingCode(null);
    setPairingError("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
          <DialogDescription>
            Scan the QR from Iris Mobile, or type the code below into Iris on another desktop. The code is
            short-lived and carries no reusable secret.
          </DialogDescription>
        </DialogHeader>

        <div className="grid items-start gap-5 md:grid-cols-[220px_1fr]">
          <div className="grid content-start gap-2">
            <div className="grid aspect-square place-items-center rounded-lg border border-border bg-background p-3">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="Iris pairing QR code" className="size-full rounded-sm" />
              ) : (
                <div className="grid place-items-center px-4 text-center text-[13px] text-muted-foreground">
                  {payloadStatus}
                </div>
              )}
            </div>
            <p className="text-center text-[12px] text-muted-foreground" aria-live="polite">
              {pairingCode?.expiresAt ? (
                <>
                  Expires at <strong className="text-foreground">{expiresAt}</strong>
                </>
              ) : (
                payloadStatus
              )}
            </p>
          </div>

          <div className="grid content-start gap-4">
            {pairingCode?.code ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3.5 py-2.5">
                <div className="grid min-w-0 gap-0.5">
                  <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Pairing code</span>
                  <span className="font-mono text-[22px] font-[700] leading-none tracking-[0.18em] text-foreground">
                    {formatPairingCode(pairingCode.code)}
                  </span>
                </div>
                <Button variant="appNeutral" size="appSmall" onClick={() => void copyCode()}>
                  <Copy data-icon="inline-start" />
                  Copy
                </Button>
              </div>
            ) : null}

            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <PairingTextField id="mobile-host-label" label="Host label" value={draft.hostLabel} onChange={(hostLabel) => updateDraft({ ...draft, hostLabel })} />
                <PairingTextField id="mobile-core-port" label="Core port" value={draft.corePort} onChange={(corePort) => updateDraft({ ...draft, corePort })} />
              </div>
              <PairingTextField id="mobile-core-host" label="Core host" value={draft.coreHost} onChange={(coreHost) => updateDraft({ ...draft, coreHost })} />
            </div>
          </div>
        </div>

        <details className="rounded-md border border-border bg-background p-3 text-[12px] text-muted-foreground">
          <summary className="cursor-default text-[13px] font-[700] text-foreground">Payload JSON</summary>
          <pre className="mt-3 max-h-[180px] overflow-auto whitespace-pre-wrap break-words">{payloadText}</pre>
        </details>

        <DialogFooter>
          <Button variant="appNeutral" size="appSmall" disabled={pairingBusy} onClick={() => void regeneratePairingCode()}>
            <RefreshCw data-icon="inline-start" />
            {pairingBusy ? "Generating" : "Regenerate QR"}
          </Button>
          <Button variant="appNeutral" size="appSmall" disabled={!canScanPayload} onClick={() => void copyPayload()}>
            <Copy data-icon="inline-start" />
            Copy Payload
          </Button>
          <Button size="appSmall" onClick={() => onOpenChange(false)}>
            <Smartphone data-icon="inline-start" />
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function payloadStatusText(
  draft: MobilePairingDraft,
  pairingCode: MobilePairingCode | null,
  payloadIsValid: boolean,
  payloadHasSecrets: boolean,
  pairingBusy: boolean,
  pairingError: string,
) {
  if (pairingBusy) return "Creating a one-time pairing code.";
  if (pairingError) return pairingError;
  if (!draft.coreHost.trim()) return "Enter the Tailscale Core host before scanning.";
  if (!pairingCode) return "Click Regenerate QR to create a one-time pairing code.";
  if (!payloadIsValid) return "Review required Core fields before scanning.";
  if (payloadHasSecrets) return "Payload needs review before scanning.";
  return "Ready to scan. The phone will generate and store its own device token.";
}

async function ensureManagedCoreForMobilePairing(
  runtimeConfig: HermesRuntimeConfig,
  draft: MobilePairingDraft,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isTauri()) return { ok: true };
  const connection = activeCoreConnection(runtimeConfig);
  if (connection.mode !== "managed-local") return { ok: true };

  const port = parsePort(draft.corePort, connection.local?.port || defaultCorePort);
  const config = {
    host: "0.0.0.0",
    port,
    hermesHome: connection.local?.hermesHome || undefined,
    autoStart: true,
  };

  try {
    const status = await invoke<CoreSidecarStatus>("core_sidecar_status");
    if (status.ready && status.port === port && !isLoopbackBind(status.bindHost)) {
      return { ok: true };
    }
    if (status.ready && status.port === port && isLoopbackBind(status.bindHost) && !status.startedByApp) {
      return {
        ok: false,
        error: `Iris Core is running on ${status.bindHost || "127.0.0.1"}:${port}, so mobile cannot reach it. Restart the dev session with \`IRIS_CORE_HOST=0.0.0.0 npm run dev\`, then regenerate the QR.`,
      };
    }
    const result = await invoke<CoreSidecarStatus>(
      status.startedByApp || status.ready ? "core_sidecar_restart" : "core_sidecar_start",
      { config },
    );
    if (result.ready && !isLoopbackBind(result.bindHost)) return { ok: true };
    if (result.ready) {
      return {
        ok: false,
        error: `Iris Core is still listening on ${result.bindHost || "127.0.0.1"}:${port}. Restart Core with host 0.0.0.0 before generating a mobile QR.`,
      };
    }
    return {
      ok: false,
      error: result.error || "Iris Core could not be prepared for mobile pairing.",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Iris Core could not be prepared for mobile pairing.",
    };
  }
}

function isLoopbackBind(host: string) {
  return ["", "localhost", "127.0.0.1", "::1", "[::1]"].includes(host.trim().toLowerCase());
}

async function mobilePairingHostCandidates() {
  if (!isTauri()) return [];
  try {
    return await invoke<string[]>("mobile_pairing_host_candidates");
  } catch {
    return [];
  }
}

async function tailscaleSelfHost(): Promise<string> {
  if (!isTauri()) return "";
  try {
    const status = await invoke<{
      running: boolean;
      selfNode: { dnsName?: string; tailscaleIps?: string[] } | null;
    }>("tailscale_status");
    if (!status.running || !status.selfNode) return "";
    return (
      status.selfNode.dnsName ||
      status.selfNode.tailscaleIps?.find((ip) => !ip.includes(":")) ||
      ""
    );
  } catch {
    return "";
  }
}

function formatPairingCode(code: string) {
  const clean = code.trim();
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

function parsePort(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function PairingTextField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}
