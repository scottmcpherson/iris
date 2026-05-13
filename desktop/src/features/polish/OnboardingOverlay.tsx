import { CheckCircle2, FolderCog, Route, Sparkles, X } from "lucide-react";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";

type OnboardingOverlayProps = {
  connected: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
};

export function OnboardingOverlay({
  connected,
  onClose,
  onOpenSettings,
  onRefresh,
}: OnboardingOverlayProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="onboarding-card" showCloseButton={false}>
        <Button variant="appIcon" size="icon-md" className="onboarding-close" title="Close onboarding" onClick={onClose}>
          <X size={15} />
        </Button>
        <div className="onboarding-mark">
          <Sparkles size={24} />
        </div>
        <DialogHeader className="onboarding-heading">
          <p className="eyebrow">First run</p>
          <DialogTitle>Set up Iris for this Mac.</DialogTitle>
          <DialogDescription className="onboarding-copy">
            Connect Iris Desktop to a local or remote Hermes runtime.
          </DialogDescription>
        </DialogHeader>

        <div className="setup-steps">
          <Card className={connected ? "setup-step complete" : "setup-step"}>
            <CheckCircle2 size={17} />
            <span className="setup-step-copy">
              <strong>{connected ? "Bridge connected" : "Connect Hermes"}</strong>
              <small>{connected ? "An agent is available." : "Start hermes gateway and check the API URL."}</small>
            </span>
          </Card>
          <Card className="setup-step">
            <FolderCog size={17} />
            <span className="setup-step-copy">
              <strong>Choose an agent</strong>
              <small>Use default, clone a working agent, or create a clean one.</small>
            </span>
          </Card>
          <Card className="setup-step">
            <Route size={17} />
            <span className="setup-step-copy">
              <strong>Pick chat routing</strong>
              <small>Set the Iris Core API URL, then use defaults as fallbacks.</small>
            </span>
          </Card>
        </div>

        <div className="onboarding-actions">
          <Button size="appSmall" onClick={onOpenSettings}>
            Open Settings
          </Button>
          <Button variant="appGhost" size="appSmall" onClick={onRefresh}>
            Retry connection
          </Button>
          <Button variant="appGhost" size="appSmall" onClick={onClose}>
            Start exploring
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
