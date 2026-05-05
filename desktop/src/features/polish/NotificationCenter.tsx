import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import type { AppNotification } from "../../app/types";

type NotificationCenterProps = {
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
};

export function NotificationCenter({ notifications, onDismiss }: NotificationCenterProps) {
  if (!notifications.length) return null;

  return (
    <div className="notification-stack" aria-live="polite">
      {notifications.map((notification) => {
        const Icon =
          notification.tone === "success"
            ? CheckCircle2
            : notification.tone === "error"
              ? AlertCircle
              : Info;
        return (
          <article key={notification.id} className={`notification ${notification.tone}`}>
            <Icon size={17} />
            <span>
              <strong>{notification.title}</strong>
              <small>{notification.message}</small>
            </span>
            <button className="icon-button" title="Dismiss notification" onClick={() => onDismiss(notification.id)}>
              <X size={14} />
            </button>
          </article>
        );
      })}
    </div>
  );
}
