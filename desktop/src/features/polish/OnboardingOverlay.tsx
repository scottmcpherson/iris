import { CheckCircle2, FolderCog, Route, Sparkles, X } from "lucide-react";
import { Button } from "../../shared/ui/button";

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
    <div className="onboarding-scrim" role="presentation">
      <section className="onboarding-card" role="dialog" aria-modal="true" aria-label="Iris setup">
        <Button variant="appIcon" size="icon-md" className="onboarding-close" title="Close onboarding" onClick={onClose}>
          <X size={15} />
        </Button>
        <div className="onboarding-mark">
          <Sparkles size={24} />
        </div>
        <p className="eyebrow">First run</p>
        <h1>Set up Iris for this Mac.</h1>
        <p className="onboarding-copy">
          Connect Iris Desktop to a local or remote Hermes runtime.
        </p>

        <div className="setup-steps">
          <div className={connected ? "setup-step complete" : "setup-step"}>
            <CheckCircle2 size={17} />
            <span>
              <strong>{connected ? "Bridge connected" : "Connect Hermes"}</strong>
              <small>{connected ? "An agent is available." : "Start hermes gateway and check the API URL."}</small>
            </span>
          </div>
          <div className="setup-step">
            <FolderCog size={17} />
            <span>
              <strong>Choose an agent</strong>
              <small>Use default, clone a working agent, or create a clean one.</small>
            </span>
          </div>
          <div className="setup-step">
            <Route size={17} />
            <span>
              <strong>Pick chat routing</strong>
              <small>Set the Iris Core API URL, then use defaults as fallbacks.</small>
            </span>
          </div>
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
      </section>
    </div>
  );
}
