import { CheckCircle2, FolderCog, Route, Sparkles, X } from "lucide-react";

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
      <section className="onboarding-card" role="dialog" aria-modal="true" aria-label="Hermes setup">
        <button className="icon-button onboarding-close" title="Close onboarding" onClick={onClose}>
          <X size={15} />
        </button>
        <div className="onboarding-mark">
          <Sparkles size={24} />
        </div>
        <p className="eyebrow">First run</p>
        <h1>Set up Hermes Agent for this Mac.</h1>
        <p className="onboarding-copy">
          Connect the desktop shell to a local or remote Hermes API server.
        </p>

        <div className="setup-steps">
          <div className={connected ? "setup-step complete" : "setup-step"}>
            <CheckCircle2 size={17} />
            <span>
              <strong>{connected ? "Bridge connected" : "Connect Hermes"}</strong>
              <small>{connected ? "A profile is available." : "Start hermes gateway and check the API URL."}</small>
            </span>
          </div>
          <div className="setup-step">
            <FolderCog size={17} />
            <span>
              <strong>Choose a profile</strong>
              <small>Use default, clone a working profile, or create a clean one.</small>
            </span>
          </div>
          <div className="setup-step">
            <Route size={17} />
            <span>
              <strong>Pick chat routing</strong>
              <small>Set the selected profile API URL, then use defaults as fallbacks.</small>
            </span>
          </div>
        </div>

        <div className="onboarding-actions">
          <button className="small-button" onClick={onOpenSettings}>
            Open Settings
          </button>
          <button className="ghost-button" onClick={onRefresh}>
            Retry connection
          </button>
          <button className="ghost-button" onClick={onClose}>
            Start exploring
          </button>
        </div>
      </section>
    </div>
  );
}
