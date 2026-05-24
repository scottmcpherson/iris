import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { Copy, RefreshCw, Smartphone } from "lucide-react";
import { toast } from "sonner";
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
import type { HermesRuntimeConfig } from "../../types/hermes";
import {
  createMobilePairingPayload,
  defaultMobilePairingDraft,
  pairingPayloadHasSecrets,
  validateMobilePairingPayload,
  type MobilePairingDraft,
} from "./mobilePairing";

type MobilePairingDialogProps = {
  open: boolean;
  runtimeConfig: HermesRuntimeConfig;
  onOpenChange: (open: boolean) => void;
};

export function MobilePairingDialog({ open, runtimeConfig, onOpenChange }: MobilePairingDialogProps) {
  const [draft, setDraft] = useState<MobilePairingDraft>(() => defaultMobilePairingDraft(runtimeConfig));
  const [nonceSeed, setNonceSeed] = useState(0);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const payload = useMemo(() => createMobilePairingPayload(draft), [draft, nonceSeed]);
  const payloadText = useMemo(() => JSON.stringify(payload, null, 2), [payload]);
  const expiresAt = new Date(payload.pairing.expiresAt * 1000).toLocaleTimeString();
  const payloadIsValid = validateMobilePairingPayload(payload);
  const payloadHasSecrets = pairingPayloadHasSecrets(payload);
  const canScanPayload = payloadIsValid && !payloadHasSecrets;
  const payloadStatus = payloadStatusText(draft, payloadIsValid, payloadHasSecrets);

  useEffect(() => {
    if (open) {
      setDraft(defaultMobilePairingDraft(runtimeConfig));
      setNonceSeed((value) => value + 1);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>Pair Mobile Device</DialogTitle>
          <DialogDescription>
            Scan this QR code from Iris Mobile. The code expires quickly and contains no private keys, passwords, or Core tokens.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          <div className="grid content-start gap-3">
            <div className="grid min-h-[260px] place-items-center rounded-md border border-border bg-background p-3">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="Iris Mobile pairing QR code" className="size-[240px]" />
              ) : (
                <div className="grid min-h-[240px] place-items-center px-4 text-center text-[13px] text-muted-foreground">
                  Enter a reachable SSH host before scanning.
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
            <FieldLegend className="sr-only">Mobile SSH connection details</FieldLegend>
            <FieldDescription>
              The phone connects through SSH, then forwards Iris Core from the desktop host.
            </FieldDescription>
            <FieldGroup className="grid gap-3">
              <PairingTextField id="mobile-host-label" label="Host label" value={draft.hostLabel} onChange={(hostLabel) => setDraft({ ...draft, hostLabel })} />
              <PairingTextField id="mobile-ssh-host" label="SSH host" value={draft.sshHost} onChange={(sshHost) => setDraft({ ...draft, sshHost })} />
              <div className="grid grid-cols-2 gap-2">
                <PairingTextField id="mobile-ssh-port" label="SSH port" value={draft.sshPort} onChange={(sshPort) => setDraft({ ...draft, sshPort })} />
                <PairingTextField id="mobile-core-port" label="Core port" value={draft.remoteCorePort} onChange={(remoteCorePort) => setDraft({ ...draft, remoteCorePort })} />
              </div>
              <PairingTextField id="mobile-user-hint" label="User hint" value={draft.userHint} onChange={(userHint) => setDraft({ ...draft, userHint })} />
            </FieldGroup>
          </FieldSet>
        </div>

        <details className="rounded-md border border-border bg-background p-3 text-[12px] text-muted-foreground">
          <summary className="cursor-default text-[13px] font-[700] text-foreground">Payload JSON</summary>
          <pre className="mt-3 max-h-[180px] overflow-auto whitespace-pre-wrap break-words">{payloadText}</pre>
        </details>

        <DialogFooter>
          <Button variant="appNeutral" size="appSmall" onClick={() => setNonceSeed((value) => value + 1)}>
            <RefreshCw data-icon="inline-start" />
            Regenerate QR
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

function payloadStatusText(draft: MobilePairingDraft, payloadIsValid: boolean, payloadHasSecrets: boolean) {
  if (!draft.sshHost.trim()) return "Enter the desktop SSH host before scanning.";
  if (!payloadIsValid) return "Review required SSH and Core fields before scanning.";
  if (payloadHasSecrets) return "Payload needs review before scanning.";
  return "Ready to scan. No secret fields detected.";
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
