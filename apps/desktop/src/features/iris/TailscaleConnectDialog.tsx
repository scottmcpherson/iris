import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  Check,
  Download,
  Laptop,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import { Button } from "../../shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import { defaultCorePort } from "../../app/runtimeConfig";
import type { HermesRuntimeConfig } from "../../types/hermes";
import {
  nodeAddress,
  nodeKey,
  useTailscaleConnectionManager,
  type ProbeState,
  type TailscaleNode,
} from "./useTailscaleConnectionManager";

const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download/mac";

type TailscaleConnectDialogProps = {
  open: boolean;
  runtimeConfig: HermesRuntimeConfig;
  onOpenChange: (open: boolean) => void;
  onRuntimeChange: (config: HermesRuntimeConfig) => void;
  onRefresh?: () => void;
};

export function TailscaleConnectDialog({
  open,
  runtimeConfig,
  onOpenChange,
  onRuntimeChange,
  onRefresh,
}: TailscaleConnectDialogProps) {
  const { status, statusLoading, probes, busyHost, refreshStatus, probeHost, connectToHost } =
    useTailscaleConnectionManager({ runtimeConfig, onRuntimeChange, onRefresh });
  const [selected, setSelected] = useState<TailscaleNode | null>(null);
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!open) {
      setSelected(null);
      setCode("");
      return;
    }
    void refreshStatus().then((next) => {
      if (next.running) {
        for (const peer of next.peers.filter((peer) => peer.online)) void probeHost(peer);
      }
    });
  }, [open, refreshStatus, probeHost]);

  const onlinePeers = useMemo(() => status?.peers.filter((peer) => peer.online) ?? [], [status]);
  const offlinePeers = useMemo(() => status?.peers.filter((peer) => !peer.online) ?? [], [status]);

  async function handleConnect() {
    if (!selected) return;
    const { magicDnsName, tailscaleIp } = nodeAddress(selected);
    const result = await connectToHost({
      hostLabel: selected.hostName || magicDnsName || tailscaleIp || "Tailscale host",
      magicDnsName,
      tailscaleIp,
      corePort: defaultCorePort,
      code,
    });
    if (result.ok) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Connect to a host over Tailscale</DialogTitle>
          <DialogDescription>
            Iris reaches other machines privately over your tailnet. Pick a device running Iris, then
            enter the pairing code it shows.
          </DialogDescription>
        </DialogHeader>

        {statusLoading && !status ? (
          <StateMessage icon={<Loader2 className="size-5 animate-spin" />} title="Checking Tailscale…" />
        ) : !status?.installed ? (
          <NotInstalled />
        ) : !status.running ? (
          <NotRunning backendState={status.backendState} onRecheck={() => void refreshStatus()} />
        ) : selected ? (
          <PairPanel
            node={selected}
            code={code}
            busy={busyHost !== ""}
            onCode={setCode}
            onBack={() => {
              setSelected(null);
              setCode("");
            }}
            onConnect={() => void handleConnect()}
          />
        ) : (
          <div className="grid gap-2">
            {onlinePeers.length === 0 && offlinePeers.length === 0 ? (
              <StateMessage
                icon={<Server className="size-5" />}
                title="No other devices on your tailnet"
                detail="Add another machine to this tailnet and run Iris on it."
              />
            ) : (
              <div className="grid max-h-[320px] gap-1.5 overflow-auto pr-1">
                {onlinePeers.map((peer) => (
                  <PeerRow
                    key={nodeKey(peer)}
                    peer={peer}
                    probe={probes[nodeKey(peer)]}
                    onSelect={() => setSelected(peer)}
                  />
                ))}
                {offlinePeers.map((peer) => (
                  <PeerRow key={nodeKey(peer)} peer={peer} probe={undefined} onSelect={() => undefined} />
                ))}
              </div>
            )}
            {status.selfNode ? (
              <p className="px-1 pt-1 text-[12px] text-muted-foreground">
                This Mac is{" "}
                <span className="text-foreground">{status.selfNode.dnsName || status.selfNode.hostName}</span> on
                your tailnet.
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {status?.installed && status.running && !selected ? (
            <Button variant="appNeutral" size="appSmall" disabled={statusLoading} onClick={() => void refreshStatus().then((next) => {
              if (next.running) for (const peer of next.peers.filter((peer) => peer.online)) void probeHost(peer);
            })}>
              <RefreshCw data-icon="inline-start" className={statusLoading ? "animate-spin" : undefined} />
              Rescan
            </Button>
          ) : null}
          <Button variant="appLink" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PeerRow({
  peer,
  probe,
  onSelect,
}: {
  peer: TailscaleNode;
  probe: ProbeState | undefined;
  onSelect: () => void;
}) {
  const offline = !peer.online;
  const probeResult = probe && probe !== "checking" ? probe : null;
  const detected = Boolean(probeResult?.ok);
  const checking = !offline && !probeResult;
  return (
    <button
      type="button"
      disabled={offline || !detected}
      onClick={onSelect}
      className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2.5 text-left transition-colors enabled:hover:bg-menu disabled:cursor-default disabled:opacity-60"
    >
      <Laptop className="size-4 shrink-0 text-muted-foreground" />
      <span className="grid min-w-0 flex-1">
        <span className="truncate text-[13px] font-[600] text-foreground">{peer.hostName || peer.dnsName}</span>
        <span className="truncate text-[12px] text-muted-foreground">
          {peer.dnsName || peer.tailscaleIps[0]}
          {peer.os ? ` · ${peer.os}` : ""}
        </span>
      </span>
      {offline ? (
        <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
          <WifiOff className="size-3.5" /> Offline
        </span>
      ) : checking ? (
        <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Checking
        </span>
      ) : detected ? (
        <span className="inline-flex items-center gap-1 text-[12px] font-[600] text-foreground">
          <Check className="size-3.5" /> Iris{probeResult?.version ? ` ${probeResult.version}` : ""}
        </span>
      ) : (
        <span className="text-[12px] text-muted-foreground">No Iris</span>
      )}
    </button>
  );
}

function PairPanel({
  node,
  code,
  busy,
  onCode,
  onBack,
  onConnect,
}: {
  node: TailscaleNode;
  code: string;
  busy: boolean;
  onCode: (code: string) => void;
  onBack: () => void;
  onConnect: () => void;
}) {
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2 text-[13px]">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Back
        </button>
        <span className="text-muted-foreground">·</span>
        <span className="truncate font-[600] text-foreground">{node.hostName || node.dnsName}</span>
      </div>
      <Field>
        <FieldLabel htmlFor="tailscale-pairing-code">Pairing code</FieldLabel>
        <Input
          id="tailscale-pairing-code"
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="e.g. KJB3-SF5B"
          value={code}
          className="font-mono tracking-[0.18em] uppercase"
          onChange={(event) => onCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) onConnect();
          }}
        />
        <FieldDescription>
          In Iris on <span className="text-foreground">{node.hostName || node.dnsName}</span>, open Settings →
          “Let other devices connect” to see this code.
        </FieldDescription>
      </Field>
      <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-[12px] text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0" />
        Traffic is encrypted by Tailscale and authenticated with a per-device token stored only on this Mac.
      </div>
      <Button disabled={busy || !code.trim()} onClick={onConnect}>
        {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
        {busy ? "Connecting" : "Connect"}
      </Button>
    </div>
  );
}

function NotInstalled() {
  return (
    <div className="grid gap-3">
      <StateMessage
        icon={<Download className="size-5" />}
        title="Tailscale isn’t installed"
        detail="Iris connects to other machines only over Tailscale. Install it, sign in, then come back."
      />
      <Button variant="appNeutral" size="appSmall" onClick={() => void openUrl(TAILSCALE_DOWNLOAD_URL)}>
        <Download data-icon="inline-start" />
        Install Tailscale
      </Button>
    </div>
  );
}

function NotRunning({ backendState, onRecheck }: { backendState: string; onRecheck: () => void }) {
  const needsLogin = backendState === "NeedsLogin" || backendState === "NoState";
  return (
    <div className="grid gap-3">
      <StateMessage
        icon={<WifiOff className="size-5" />}
        title={needsLogin ? "Sign in to Tailscale" : "Tailscale isn’t connected"}
        detail={
          needsLogin
            ? "Open Tailscale and sign in, then rescan."
            : "Turn Tailscale on, then rescan to see your devices."
        }
      />
      <div className="flex gap-2">
        <Button variant="appNeutral" size="appSmall" onClick={() => void invoke("tailscale_open_app").catch(() => undefined)}>
          Open Tailscale
        </Button>
        <Button variant="appNeutral" size="appSmall" onClick={onRecheck}>
          <RefreshCw data-icon="inline-start" />
          Rescan
        </Button>
      </div>
    </div>
  );
}

function StateMessage({ icon, title, detail }: { icon: React.ReactNode; title: string; detail?: string }) {
  return (
    <div className="grid place-items-center gap-2 rounded-md border border-border bg-background px-4 py-8 text-center">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-[14px] font-[600] text-foreground">{title}</span>
      {detail ? <span className="max-w-[360px] text-[13px] text-muted-foreground">{detail}</span> : null}
    </div>
  );
}
