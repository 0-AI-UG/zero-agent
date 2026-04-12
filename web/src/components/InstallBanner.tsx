import { useState } from "react";
import { useInstallPrompt } from "@/hooks/use-install-prompt";
import { usePushSubscription } from "@/hooks/use-push-subscription";
import { Button } from "@/components/ui/button";
import { DownloadIcon, BellIcon, XIcon } from "lucide-react";

const DISMISSED_KEY = "install-banner-dismissed";

export function InstallBanner() {
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

  // Show install prompt (Android/desktop Chrome)
  if (canInstall) {
    return (
      <div className="shrink-0 border-b bg-primary/5 px-3 py-2 flex items-center gap-2">
        <DownloadIcon className="size-4 text-primary shrink-0" />
        <p className="text-xs flex-1">
          Install Zero Agent for quick access and push notifications.
        </p>
        <Button variant="default" size="sm" className="h-7 text-xs" onClick={install}>
          Install
        </Button>
        <button onClick={dismiss} className="text-muted-foreground hover:text-foreground p-1" aria-label="Dismiss">
          <XIcon className="size-3.5" />
        </button>
      </div>
    );
  }

  // Show iOS instructions
  if (isIOS) {
    return (
      <div className="shrink-0 border-b bg-primary/5 px-3 py-2 flex items-center gap-2">
        <DownloadIcon className="size-4 text-primary shrink-0" />
        <p className="text-xs flex-1">
          Tap share, then "Add to Home Screen" to install.
        </p>
        <button onClick={dismiss} className="text-muted-foreground hover:text-foreground p-1" aria-label="Dismiss">
          <XIcon className="size-3.5" />
        </button>
      </div>
    );
  }

  // Show notification prompt if app is installed but notifications not enabled
  if (isSupported && !isSubscribed) {
    return (
      <div className="shrink-0 border-b bg-primary/5 px-3 py-2 flex items-center gap-2">
        <BellIcon className="size-4 text-primary shrink-0" />
        <p className="text-xs flex-1">
          Enable notifications to hear from your agents.
        </p>
        <Button variant="default" size="sm" className="h-7 text-xs" onClick={subscribe}>
          Enable
        </Button>
        <button onClick={dismiss} className="text-muted-foreground hover:text-foreground p-1" aria-label="Dismiss">
          <XIcon className="size-3.5" />
        </button>
      </div>
    );
  }

  return null;
}
