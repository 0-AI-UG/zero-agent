import { useState } from "react";
import { useInstallPrompt } from "@/hooks/use-install-prompt";
import { usePushSubscription } from "@/hooks/use-push-subscription";
import { Button } from "@/components/ui/button";
import { DownloadIcon, BellIcon, XIcon } from "lucide-react";

const DISMISSED_KEY = "install-banner-dismissed";

interface InstallBannerProps {
  variant?: "banner" | "card";
}

export function InstallBanner({ variant = "banner" }: InstallBannerProps) {
  const { canInstall, install, isIOS, isStandalone } = useInstallPrompt();
  const { isSubscribed, isSupported, subscribe } = usePushSubscription();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSED_KEY) === "1",
  );

  if (dismissed || isStandalone) return null;

  const dismiss = () => {
    setDismissed(true);
    localStorage.setItem(DISMISSED_KEY, "1");
  };

  const isCard = variant === "card";

  // Determine what to show
  let icon: React.ReactNode = null;
  let text = "";
  let actionLabel = "";
  let onAction: () => void = () => {};

  if (canInstall) {
    icon = <DownloadIcon className="size-4 text-muted-foreground shrink-0" />;
    text = isCard
      ? "Install for quick access & notifications."
      : "Install Zero Agent for quick access and push notifications.";
    actionLabel = "Install";
    onAction = install;
  } else if (isIOS) {
    icon = <DownloadIcon className="size-4 text-muted-foreground shrink-0" />;
    text = 'Tap share, then "Add to Home Screen" to install.';
    actionLabel = "";
    onAction = () => {};
  } else if (isSupported && !isSubscribed) {
    icon = <BellIcon className="size-4 text-muted-foreground shrink-0" />;
    text = isCard
      ? "Enable notifications from your agents."
      : "Enable notifications to hear from your agents.";
    actionLabel = "Enable";
    onAction = subscribe;
  } else {
    return null;
  }

  // Card variant - for sidebar
  if (isCard) {
    return (
      <div className="relative rounded-lg border bg-primary/5 p-3 mb-3">
        {/* Dismiss X - top right */}
        <button
          onClick={dismiss}
          className="absolute top-2 right-2 text-muted-foreground hover:text-foreground p-0.5"
          aria-label="Dismiss"
        >
          <XIcon className="size-3.5" />
        </button>

        <div className="flex items-start gap-2 pr-5">
          {icon}
          <p className="text-xs leading-relaxed">{text}</p>
        </div>

        {actionLabel && (
          <Button
            variant="default"
            size="sm"
            className="h-7 text-xs w-full mt-2.5"
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        )}
      </div>
    );
  }

  // Banner variant - default top bar
  return (
    <div className="shrink-0 border-b bg-primary/5 px-3 py-2 flex items-center gap-2">
      {icon}
      <p className="text-xs flex-1">{text}</p>
      {actionLabel && (
        <Button variant="default" size="sm" className="h-7 text-xs" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
      <button
        onClick={dismiss}
        className="text-muted-foreground hover:text-foreground p-1"
        aria-label="Dismiss"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
