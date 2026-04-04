import { useState, useEffect, useRef } from "react";
import { MonitorIcon, XIcon, MaximizeIcon, MinimizeIcon } from "lucide-react";

interface BrowserViewerProps {
  sessionId: string;
  onClose?: () => void;
}

/**
 * Live browser viewer using noVNC RFB.
 * Connects to the server's noVNC WebSocket proxy for a given session.
 */
export function BrowserViewer({ sessionId, onClose }: BrowserViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);
  const [connected, setConnected] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (collapsed || !containerRef.current) return;

    let cancelled = false;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/novnc/${sessionId}`;

    import("@novnc/novnc/lib/rfb").then((mod) => {
      if (cancelled || !containerRef.current) return;
      const RFB = mod.default;

      try {
        const rfb = new RFB(containerRef.current, url);
        rfb.viewOnly = true;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfbRef.current = rfb;

        rfb.addEventListener("connect", () => {
          setConnected(true);
          setError(null);
        });
        rfb.addEventListener("disconnect", (e: any) => {
          setConnected(false);
          rfbRef.current = null;
          if (e.detail?.clean === false) setError("Connection lost");
        });
        rfb.addEventListener("securityfailure", () => {
          setError("Security failure");
        });
      } catch {
        setError("Failed to initialize viewer");
      }
    }).catch(() => {
      if (!cancelled) setError("Failed to load viewer");
    });

    return () => {
      cancelled = true;
      if (rfbRef.current) {
        rfbRef.current.disconnect();
        rfbRef.current = null;
      }
    };
  }, [sessionId, collapsed]);

  if (collapsed) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-zinc-900/50 px-3 py-1.5 text-xs">
        <MonitorIcon className="size-3.5 text-cyan-500" />
        <span className="text-muted-foreground">Live Browser</span>
        <span className={`size-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-zinc-500"}`} />
        <button onClick={() => setCollapsed(false)} className="ml-auto p-0.5 hover:text-foreground text-muted-foreground">
          <MaximizeIcon className="size-3" />
        </button>
        {onClose && (
          <button onClick={onClose} className="p-0.5 hover:text-foreground text-muted-foreground">
            <XIcon className="size-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-zinc-900/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-zinc-800/50">
        <MonitorIcon className="size-3.5 text-cyan-500" />
        <span className="text-xs font-medium">Live Browser</span>
        <span className={`size-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-zinc-500"}`} />
        <span className="text-[10px] text-muted-foreground">
          {connected ? "Connected" : error ?? "Connecting..."}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setCollapsed(true)} className="p-0.5 hover:text-foreground text-muted-foreground">
            <MinimizeIcon className="size-3" />
          </button>
          {onClose && (
            <button onClick={onClose} className="p-0.5 hover:text-foreground text-muted-foreground">
              <XIcon className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* Viewer area */}
      <div className="relative aspect-video bg-black">
        {!connected && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-xs text-muted-foreground">
              {error ?? "Connecting to browser..."}
            </p>
          </div>
        )}
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
}
