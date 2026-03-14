import { useState } from "react";
import {
  useChannels,
  useCreateChannel,
  useDeleteChannel,
  useStartChannel,
  useStopChannel,
  useChannelStatus,
  type Channel,
} from "@/api/channels";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { MessageSquareIcon, TrashIcon, PlayIcon, SquareIcon } from "lucide-react";

function ChannelStatusBadge({ projectId, channel }: { projectId: string; channel: Channel }) {
  const { data } = useChannelStatus(projectId, channel.id);
  const status = data?.status;

  if (!channel.enabled) {
    return <span className="text-[11px] text-muted-foreground">Stopped</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`size-2 rounded-full ${status?.connected ? "bg-emerald-500" : "bg-zinc-400"}`}
      />
      <span className="text-[11px]">
        {status?.connected ? "Connected" : status?.error ? "Error" : "Connecting..."}
      </span>
    </div>
  );
}

export function ChannelsManager({ projectId }: { projectId: string }) {
  const { data: channels, isLoading } = useChannels(projectId);
  const createChannel = useCreateChannel(projectId);
  const deleteChannel = useDeleteChannel(projectId);
  const startChannel = useStartChannel(projectId);
  const stopChannel = useStopChannel(projectId);

  const [createOpen, setCreateOpen] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [createError, setCreateError] = useState("");

  const handleCreate = () => {
    if (!botToken.trim()) {
      setCreateError("Please paste your bot token");
      return;
    }

    createChannel.mutate(
      {
        platform: "telegram",
        name: "Telegram",
        credentials: { botToken: botToken.trim() },
        allowedSenders: [],
      },
      {
        onSuccess: () => handleCloseDialog(),
        onError: (err: Error) => setCreateError(err.message),
      },
    );
  };

  const handleCloseDialog = () => {
    setCreateOpen(false);
    setBotToken("");
    setCreateError("");
  };

  const handleToggle = (channel: Channel) => {
    if (channel.enabled) {
      stopChannel.mutate(channel.id);
    } else {
      startChannel.mutate(channel.id);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <MessageSquareIcon className="size-4 text-blue-500" />
        <h3 className="text-sm font-semibold">Messaging Channels</h3>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        {isLoading && (
          <p className="text-xs text-muted-foreground">Loading...</p>
        )}

        {!isLoading && (!channels || channels.length === 0) && (
          <p className="text-xs text-muted-foreground">
            Connect a messaging app so people can chat with your assistant directly.
          </p>
        )}

        {channels && channels.length > 0 && (
          <div className="space-y-2">
            {channels.map((ch) => (
              <div
                key={ch.id}
                className="flex items-center justify-between gap-3 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{ch.name}</span>
                  </div>
                  <ChannelStatusBadge projectId={projectId} channel={ch} />
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleToggle(ch)}
                    disabled={startChannel.isPending || stopChannel.isPending}
                    className="text-muted-foreground hover:text-foreground p-1"
                    aria-label={ch.enabled ? "Stop" : "Start"}
                  >
                    {ch.enabled ? (
                      <SquareIcon className="size-3.5" />
                    ) : (
                      <PlayIcon className="size-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => deleteChannel.mutate(ch.id)}
                    className="text-muted-foreground hover:text-destructive p-1"
                    aria-label="Remove"
                  >
                    <TrashIcon className="size-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 pt-2 border-t">
          <button
            onClick={() => setCreateOpen(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Connect Telegram
          </button>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={handleCloseDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Telegram</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Open Telegram, search for <span className="font-medium text-foreground">@BotFather</span>, send <span className="font-mono text-foreground">/newbot</span>, and paste the token you get below.
              </p>
              <input
                type="text"
                placeholder="Paste bot token here"
                value={botToken}
                onChange={(e) => {
                  setBotToken(e.target.value);
                  setCreateError("");
                }}
                autoFocus
                className="w-full rounded-md border bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
              {createError && (
                <p className="text-[11px] text-destructive">{createError}</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <button
              onClick={handleCloseDialog}
              className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={createChannel.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createChannel.isPending ? "Connecting..." : "Connect"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
