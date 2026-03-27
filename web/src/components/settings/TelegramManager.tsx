import { useState } from "react";
import {
  useTelegramStatus,
  useSetupTelegram,
  useRemoveTelegram,
  useUpdateTelegramAllowlist,
} from "@/api/telegram";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { SendIcon } from "lucide-react";

interface TelegramManagerProps {
  projectId: string;
}

export function TelegramManager({ projectId }: TelegramManagerProps) {
  const { data: status, isLoading } = useTelegramStatus(projectId);
  const setupTelegram = useSetupTelegram(projectId);
  const removeTelegram = useRemoveTelegram(projectId);
  const updateAllowlist = useUpdateTelegramAllowlist(projectId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [userId, setUserId] = useState("");
  const [error, setError] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [editingUserId, setEditingUserId] = useState(false);
  const [newUserId, setNewUserId] = useState("");

  const currentUserId = status?.allowedUserIds?.[0] ?? null;

  const handleConnect = () => {
    if (!botToken.trim()) {
      setError("Bot token is required");
      return;
    }
    if (!userId.trim() || !/^\d+$/.test(userId.trim())) {
      setError("A valid Telegram user ID is required");
      return;
    }
    setupTelegram.mutate(
      { botToken, allowedUserIds: [userId.trim()] },
      {
        onSuccess: () => {
          setDialogOpen(false);
          setBotToken("");
          setUserId("");
          setError("");
        },
        onError: (err: Error) => setError(err.message),
      },
    );
  };

  const handleDisconnect = () => {
    removeTelegram.mutate(undefined, {
      onSuccess: () => setConfirmDisconnect(false),
    });
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setBotToken("");
    setUserId("");
    setError("");
  };

  const handleSaveUserId = () => {
    const id = newUserId.trim();
    if (!id || !/^\d+$/.test(id)) return;
    updateAllowlist.mutate([id], {
      onSuccess: () => {
        setEditingUserId(false);
        setNewUserId("");
      },
    });
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <SendIcon className="size-4 text-blue-500" />
        <h3 className="text-sm font-semibold">Telegram</h3>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        {isLoading && (
          <p className="text-xs text-muted-foreground">Checking connection...</p>
        )}

        {!isLoading && status?.connected && (
          <>
            <div className="flex items-center gap-3">
              <span className="size-2 rounded-full bg-emerald-500" />
              <span className="text-sm">
                Connected as <span className="font-medium">@{status.botUsername}</span>
              </span>
            </div>

            {/* Single allowed user */}
            <div className="pt-2 border-t space-y-2">
              <p className="text-sm font-medium">Allowed user</p>
              <p className="text-xs text-muted-foreground">
                Only this Telegram user can message the bot. Send{" "}
                <span className="font-mono text-[11px]">/start</span> to{" "}
                <span className="font-medium text-foreground">@userinfobot</span> to find your ID.
              </p>

              {!editingUserId ? (
                <div className="flex items-center gap-2">
                  {currentUserId ? (
                    <code className="text-xs font-mono bg-muted px-2 py-0.5 rounded">{currentUserId}</code>
                  ) : (
                    <span className="text-[11px] text-amber-600 dark:text-amber-400">
                      No user set — the bot won't respond to anyone.
                    </span>
                  )}
                  <button
                    onClick={() => {
                      setNewUserId(currentUserId ?? "");
                      setEditingUserId(true);
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Telegram user ID"
                    value={newUserId}
                    onChange={(e) => setNewUserId(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveUserId()}
                    className="flex-1 rounded-md border bg-background px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                    autoFocus
                  />
                  <button
                    onClick={handleSaveUserId}
                    disabled={!newUserId.trim() || updateAllowlist.isPending}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingUserId(false)}
                    className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {/* Disconnect */}
            <div className="flex items-center gap-2 pt-2 border-t">
              {confirmDisconnect ? (
                <>
                  <span className="text-xs text-muted-foreground">Disconnect bot?</span>
                  <button
                    onClick={handleDisconnect}
                    disabled={removeTelegram.isPending}
                    className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                  >
                    {removeTelegram.isPending ? "Disconnecting..." : "Yes, disconnect"}
                  </button>
                  <button
                    onClick={() => setConfirmDisconnect(false)}
                    className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmDisconnect(true)}
                  className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted text-destructive"
                >
                  Disconnect
                </button>
              )}
            </div>
          </>
        )}

        {!isLoading && !status?.connected && (
          <>
            <p className="text-xs text-muted-foreground">
              Connect a Telegram bot to chat with your agent from Telegram.
            </p>
            <div className="flex items-center gap-2 pt-2 border-t">
              <button
                onClick={() => setDialogOpen(true)}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                Connect Telegram
              </button>
            </div>
          </>
        )}
      </div>

      {/* Setup dialog */}
      <Dialog open={dialogOpen} onOpenChange={handleCloseDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Telegram Bot</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-medium">Bot Token</label>
              <p className="text-xs text-muted-foreground">
                Create a bot with{" "}
                <span className="font-medium text-foreground">@BotFather</span>{" "}
                on Telegram, then paste the token here.
              </p>
              <input
                type="text"
                placeholder="123456789:ABCdef..."
                value={botToken}
                onChange={(e) => {
                  setBotToken(e.target.value);
                  setError("");
                }}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium">Your Telegram User ID</label>
              <p className="text-xs text-muted-foreground">
                Send <span className="font-mono text-[11px]">/start</span> to{" "}
                <span className="font-medium text-foreground">@userinfobot</span>{" "}
                on Telegram to find your ID. Only this user will be able to message the bot.
              </p>
              <input
                type="text"
                placeholder="123456789"
                value={userId}
                onChange={(e) => {
                  setUserId(e.target.value);
                  setError("");
                }}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              />
            </div>

            {error && (
              <p className="text-[11px] text-destructive">{error}</p>
            )}
          </div>

          <DialogFooter>
            <button
              onClick={handleCloseDialog}
              className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              onClick={handleConnect}
              disabled={setupTelegram.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {setupTelegram.isPending ? "Connecting..." : "Connect"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
