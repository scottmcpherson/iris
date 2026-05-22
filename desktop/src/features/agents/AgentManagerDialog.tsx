import type { ProfileActionHandler } from "../../app/types";
import type { IrisCoreGatewayAction } from "../../lib/irisCore";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import type { HermesProfile, HermesStatus } from "../../types/hermes";
import { AgentList } from "./AgentList";

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="agent-manager-dialog sm:max-w-[680px]">
        <DialogHeader className="agent-manager-dialog-header">
          <DialogTitle>Manage agents</DialogTitle>
          <DialogDescription>
            Create, switch, or remove agent profiles. Each agent has its own memory, skills, and runtime.
          </DialogDescription>
        </DialogHeader>
        <AgentList
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
