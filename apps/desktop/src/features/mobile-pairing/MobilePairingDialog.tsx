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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import { coreRequest } from "../../lib/coreTransport";
import type { HermesRuntimeConfig } from "../../types/hermes";
import {
  coreUrlFromDraft,
  createMobilePairingPayload,
  defaultMobilePairingDraft,
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
  const payloadStatus = payloadStatusText(draft, payloadIsValid, payloadHasSecrets, pairingBusy, pairingError);

  useEffect(() => {
    if (open) {
      const nextDraft = defaultMobilePairingDraft(runtimeConfig);
      setDraft(nextDraft);
      void regeneratePairingCode(nextDraft);
    } else {
      setPairingCode(null);
      setPairingError("");
    }
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>Pair Mobile Device</DialogTitle>
          <DialogDescription>
            Scan this QR code from Iris Mobile. It contains a short-lived pairing code, not a reusable Core token or SSH key.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          <div className="grid content-start gap-3">
            <div className="grid min-h-[260px] place-items-center rounded-md border border-border bg-background p-3">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="Iris Mobile pairing QR code" className="size-[240px]" />
              ) : (
                <div className="grid min-h-[240px] place-items-center px-4 text-center text-[13px] text-muted-foreground">
                  Enter a Tailscale-reachable Core host before scanning.
                </div>
              )}
            </div>
            <div className="grid gap-1 text-[13px] text-muted-foreground">
              <span>
                Expires at <strong className="text-foreground">{expiresAt}</strong>
              </span>
              <span aria-live="polite">{payloadStatus}</span>
            </div>
          </div>

          <FieldSet className="grid gap-3 border-0 p-0">
            <FieldLegend className="sr-only">Mobile Core connection details</FieldLegend>
            <FieldDescription>
              The phone connects directly to Iris Core over Tailscale, then authenticates with a phone-generated device token.
            </FieldDescription>
            <FieldGroup className="grid gap-3">
              <PairingTextField id="mobile-host-label" label="Host label" value={draft.hostLabel} onChange={(hostLabel) => setDraft({ ...draft, hostLabel })} />
              <PairingTextField id="mobile-core-host" label="Core host" value={draft.coreHost} onChange={(coreHost) => setDraft({ ...draft, coreHost })} />
              <PairingTextField id="mobile-core-port" label="Core port" value={draft.corePort} onChange={(corePort) => setDraft({ ...draft, corePort })} />
            </FieldGroup>
          </FieldSet>
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
  payloadIsValid: boolean,
  payloadHasSecrets: boolean,
  pairingBusy: boolean,
  pairingError: string,
) {
  if (pairingBusy) return "Creating a one-time pairing code.";
  if (pairingError) return pairingError;
  if (!draft.coreHost.trim()) return "Enter the Tailscale Core host before scanning.";
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
    const result = await invoke<CoreSidecarStatus>(
      status.startedByApp || status.ready ? "core_sidecar_restart" : "core_sidecar_start",
      { config },
    );
    if (result.ready) return { ok: true };
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
