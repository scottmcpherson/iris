import { useRef } from "react";
import { Plus } from "lucide-react";
import type { ProfileActionHandler } from "../../app/types";
import type { IrisCoreGatewayAction } from "../../lib/irisCore";
import { Button } from "../../shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import type { HermesProfile, HermesStatus } from "../../types/hermes";
import { AgentList, type AgentListHandle } from "./AgentList";

type AgentManagerDialogProps = {
  open: boolean;
  profiles: HermesProfile[];
  status: HermesStatus | null;
  gatewayActionBusy: boolean;
  gatewayActionBusyAction: IrisCoreGatewayAction | null;
  gatewayActionBusyProfile: string;
  adapterInstallBusyProfile: string;
  onOpenChange: (open: boolean) => void;
  onOpenAgent: (profileName: string) => void;
  onProfileAction: ProfileActionHandler;
  onGatewayAction: (action: IrisCoreGatewayAction, profileName: string) => void;
  onInstallAdapter: (profileName: string) => void;
};

export function AgentManagerDialog({
  open,
  profiles,
  status,
  gatewayActionBusy,
  gatewayActionBusyAction,
  gatewayActionBusyProfile,
  adapterInstallBusyProfile,
  onOpenChange,
  onOpenAgent,
  onProfileAction,
  onGatewayAction,
  onInstallAdapter,
}: AgentManagerDialogProps) {
  const listRef = useRef<AgentListHandle>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3.5 pt-[18px] px-[18px] pb-4 sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>Manage agents</DialogTitle>
        </DialogHeader>
        <div className="flex justify-end">
          <Button
            type="button"
            size="appSmall"
            aria-label="Create agent"
            onClick={() => listRef.current?.openCreateDialog()}
          >
            <Plus data-icon="inline-start" />
            New agent
          </Button>
        </div>
        <AgentList
          ref={listRef}
          variant="dialog"
          profiles={profiles}
          status={status}
          gatewayActionBusy={gatewayActionBusy}
          gatewayActionBusyAction={gatewayActionBusyAction}
          gatewayActionBusyProfile={gatewayActionBusyProfile}
          adapterInstallBusyProfile={adapterInstallBusyProfile}
          onOpenAgent={(profileName) => {
            onOpenChange(false);
            onOpenAgent(profileName);
          }}
          onProfileAction={onProfileAction}
          onGatewayAction={onGatewayAction}
          onInstallAdapter={onInstallAdapter}
        />
      </DialogContent>
    </Dialog>
  );
}
