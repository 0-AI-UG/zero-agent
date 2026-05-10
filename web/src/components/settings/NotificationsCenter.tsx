import { useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "@/api/client";
import { usePushSubscription } from "@/hooks/use-push-subscription";
import { useInstallPrompt } from "@/hooks/use-install-prompt";
import {
  useTelegramLinkStatus,
  useCreateTelegramLinkCode,
  useUnlinkTelegram,
  useSetTelegramActiveProject,
  type TelegramLinkCodeResult,
} from "@/api/telegram";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  BellIcon,
  RadioIcon,
  SmartphoneIcon,
  SendIcon,
  DownloadIcon,
  CopyIcon,
  CheckIcon,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Channel = "ws" | "push" | "telegram";

interface Rule {
  kind: string;
  channel: Channel;
  enabled: boolean;
}

interface SubsResponse {
  kinds: string[];
  defaultEnabledKinds: string[];
  channels: Channel[];
  rules: Rule[];
  availability: Record<Channel, boolean>;
}

const KIND_META: Record<string, { title: string; description: string }> = {
  cli_request: {
    title: "CLI messages",
    description: "When the agent CLI surfaces a question or request.",
  },
  task_completed: {
    title: "Task completed",
    description: "When a long-running task finishes successfully.",
  },
  task_failed: {
    title: "Task failed",
    description: "When something the agent was doing errors out.",
  },
};

const CHANNEL_META: Record<
  Channel,
  {
    label: string;
    tintText: string;
    tintBg: string;
    tintBorder: string;
    icon: ReactNode;
  }
> = {
  ws: {
    label: "In-app",
    tintText: "text-muted-foreground",
    tintBg: "bg-muted/40",
    tintBorder: "border-muted-foreground/30",
    icon: <RadioIcon className="size-3.5" />,
  },
  push: {
    label: "Push",
    tintText: "text-muted-foreground",
    tintBg: "bg-muted/40",
    tintBorder: "border-muted-foreground/30",
    icon: <SmartphoneIcon className="size-3.5" />,
  },
  telegram: {
    label: "Telegram",
    tintText: "text-muted-foreground",
    tintBg: "bg-muted/40",
    tintBorder: "border-muted-foreground/30",
    icon: <SendIcon className="size-3.5" />,
  },
};

function ruleKey(kind: string, channel: Channel): string {
  return `${kind}::${channel}`;
}

export function NotificationsCenter() {
  // ───── Subscription matrix state ─────
  const [data, setData] = useState<SubsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    apiFetch<SubsResponse>("/me/notification-subscriptions")
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ruleMap = new Map<string, boolean>();
  if (data) {
    for (const r of data.rules) ruleMap.set(ruleKey(r.kind, r.channel), r.enabled);
  }

  const isEnabled = (kind: string, channel: Channel): boolean => {
    if (!data) return false;
    const explicit = ruleMap.get(ruleKey(kind, channel));
    if (explicit !== undefined) return explicit;
    return data.defaultEnabledKinds.includes(kind);
  };

  const handleToggle = async (kind: string, channel: Channel, next: boolean) => {
    const key = ruleKey(kind, channel);
    setPending((s) => new Set(s).add(key));
    setData((prev) => {
      if (!prev) return prev;
      const filtered = prev.rules.filter(
        (r) => !(r.kind === kind && r.channel === channel)
      );
      return { ...prev, rules: [...filtered, { kind, channel, enabled: next }] };
    });
    try {
      await apiFetch(
        `/me/notification-subscriptions/${encodeURIComponent(kind)}/${channel}`,
        { method: "PUT", body: JSON.stringify({ enabled: next }) }
      );
    } catch (err) {
      setData((prev) => {
        if (!prev) return prev;
        const rolled = prev.rules.filter(
          (r) => !(r.kind === kind && r.channel === channel)
        );
        return { ...prev, rules: rolled };
      });
      setError((err as Error)?.message ?? "Failed to update");
    } finally {
      setPending((s) => {
        const copy = new Set(s);
        copy.delete(key);
        return copy;
      });
    }
  };

  // ───── Push state ─────
  const push = usePushSubscription();

  // ───── Telegram state ─────
  const { data: tgStatus, isLoading: tgLoading } = useTelegramLinkStatus();
  const createCode = useCreateTelegramLinkCode();
  const unlink = useUnlinkTelegram();
  const setActiveProject = useSetTelegramActiveProject();
  const qc = useQueryClient();
  const [code, setCode] = useState<TelegramLinkCodeResult | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [copied, setCopied] = useState(false);

  // Re-poll status while a code is outstanding so the UI flips as soon as
  // the user redeems it on Telegram.
  useEffect(() => {
    if (!code) return;
    const interval = setInterval(() => {
      qc.invalidateQueries({ queryKey: queryKeys.telegram.linkStatus });
    }, 3000);
    return () => clearInterval(interval);
  }, [code, qc]);

  useEffect(() => {
    if (tgStatus?.linked) setCode(null);
  }, [tgStatus?.linked]);

  // ───── Install state ─────
  const { canInstall, install, isStandalone, isIOS } = useInstallPrompt();

  // ───── Derived ─────
  const channels: Channel[] = data?.channels ?? ["ws", "push", "telegram"];
  const kinds = data?.kinds ?? Object.keys(KIND_META);

  const availability: Record<Channel, boolean> = {
    ws: data?.availability.ws ?? true,
    push: push.isSubscribed,
    telegram: !!tgStatus?.linked,
  };

  const pushStatusText = !push.isSupported
    ? "Unsupported"
    : push.isSubscribed
      ? "Active"
      : "Off";

  const telegramStatusText = tgLoading
    ? "Checking…"
    : !tgStatus?.configured
      ? "Not configured"
      : tgStatus.linked
        ? "Linked"
        : "Not linked";

  return (
    <section className="space-y-6">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <BellIcon className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Notifications</h3>
      </div>

      {/* ─── Channels platform ─── */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-5 pt-4 pb-3">
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60 font-mono">
            Channels
          </span>
        </div>
        <div className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* In-app */}
          <ChannelCard
            channel="ws"
            active={availability.ws}
            statusText={availability.ws ? "Always on" : "Disconnected"}
          />

          {/* Push */}
          <ChannelCard
            channel="push"
            active={availability.push}
            statusText={pushStatusText}
            action={
              push.isSupported ? (
                <ModuleAction
                  onClick={() =>
                    push.isSubscribed ? push.unsubscribe() : push.subscribe()
                  }
                  disabled={push.isLoading}
                >
                  {push.isSubscribed ? "Disable" : "Enable"}
                </ModuleAction>
              ) : null
            }
          />

          {/* Telegram */}
          <ChannelCard
            channel="telegram"
            active={availability.telegram}
            statusText={telegramStatusText}
            action={
              tgStatus?.configured ? (
                tgStatus.linked ? (
                  confirmUnlink ? (
                    <span className="flex items-center gap-2">
                      <ModuleAction
                        onClick={() =>
                          unlink.mutate(undefined, {
                            onSuccess: () => setConfirmUnlink(false),
                          })
                        }
                        disabled={unlink.isPending}
                        tone="destructive"
                      >
                        Confirm
                      </ModuleAction>
                      <ModuleAction onClick={() => setConfirmUnlink(false)}>
                        Cancel
                      </ModuleAction>
                    </span>
                  ) : (
                    <ModuleAction onClick={() => setConfirmUnlink(true)}>
                      Unlink
                    </ModuleAction>
                  )
                ) : (
                  <ModuleAction
                    onClick={() =>
                      createCode.mutate(undefined, {
                        onSuccess: (result) => setCode(result),
                      })
                    }
                    disabled={createCode.isPending}
                  >
                    {createCode.isPending ? "…" : "Link"}
                  </ModuleAction>
                )
              ) : null
            }
          />
        </div>

        {/* Telegram active-project picker */}
        {tgStatus?.linked && tgStatus.projects.length > 0 && (
          <div className="border-t border-border px-5 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <SendIcon className="size-3.5 text-muted-foreground shrink-0" />
              <p className="text-xs text-muted-foreground truncate">
                Default Telegram project
              </p>
            </div>
            <Select
              value={tgStatus.activeProjectId ?? undefined}
              disabled={
                setActiveProject.isPending || tgStatus.projects.length < 2
              }
              onValueChange={(next) => setActiveProject.mutate(next || null)}
            >
              <SelectTrigger className="h-8 text-xs max-w-[55%]">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                {tgStatus.projects.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Telegram link-code reveal */}
        {tgStatus?.configured && !tgStatus.linked && code && (
          <div className="border-t border-border px-5 py-4">
            <p className="text-xs text-muted-foreground">
              Open Telegram, message{" "}
              <span className="font-medium text-foreground">
                {code.botUsername ? `@${code.botUsername}` : "the bot"}
              </span>
              , and send:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 rounded-md border bg-muted/40 px-3 py-2 text-sm font-mono tracking-wider truncate">
                /start {code.code}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(`/start ${code.code}`);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="rounded-md border bg-muted/40 size-9 flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0"
                aria-label="Copy code"
              >
                {copied ? (
                  <CheckIcon className="size-4" />
                ) : (
                  <CopyIcon className="size-4" />
                )}
              </button>
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground gap-3">
              <span className="truncate">
                Expires in {Math.round(code.expiresIn / 60)} min
              </span>
              <button
                type="button"
                onClick={() => setCode(null)}
                className="hover:text-foreground shrink-0 uppercase tracking-wider font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Install / iOS hint */}
        {(canInstall || (isIOS && !isStandalone)) && (
          <div className="border-t border-border px-5 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <SmartphoneIcon className="size-3.5 text-muted-foreground shrink-0" />
              <p className="text-xs text-muted-foreground truncate">
                {isIOS && !isStandalone
                  ? "Add to Home Screen in Safari to enable push on iOS."
                  : "Install Zero as an app for native push support."}
              </p>
            </div>
            {canInstall && (
              <button
                type="button"
                onClick={install}
                className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground flex items-center gap-1.5 shrink-0"
              >
                <DownloadIcon className="size-3" />
                Install
              </button>
            )}
          </div>
        )}
      </div>

      {/* ─── Per-channel event cards ─── */}
      {error && !data ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        channels.map((ch) => {
          const meta = CHANNEL_META[ch];
          const active = availability[ch];
          return (
            <div
              key={ch}
              className="rounded-xl border bg-card overflow-hidden"
            >
              {/* Channel header */}
              <div className="flex items-center gap-3 px-5 pt-4 pb-3">
                <div
                  className={`size-7 rounded-md border flex items-center justify-center shrink-0 ${
                    active
                      ? `${meta.tintBg} ${meta.tintBorder} ${meta.tintText}`
                      : "border-border bg-muted/40 text-muted-foreground/50"
                  }`}
                >
                  {meta.icon}
                </div>
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="text-sm font-medium">{meta.label}</span>
                  <span
                    className={`size-1.5 rounded-full shrink-0 ${
                      active ? "bg-emerald-500" : "bg-muted-foreground/30"
                    }`}
                    aria-hidden
                  />
                </div>
                {!active && (
                  <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/50 font-mono shrink-0">
                    {ch === "ws"
                      ? "Disconnected"
                      : ch === "push"
                        ? pushStatusText
                        : telegramStatusText}
                  </span>
                )}
              </div>

              {/* Event toggles */}
              {!data ? (
                <div className="divide-y divide-border border-t border-border">
                  {Object.keys(KIND_META).map((kind) => (
                    <div
                      key={kind}
                      className="px-5 py-3 flex items-center gap-4"
                    >
                      <div className="flex-1">
                        <div className="h-3 w-32 rounded bg-muted" />
                      </div>
                      <div className="size-8 rounded-full bg-muted/40" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="divide-y divide-border border-t border-border">
                  {kinds.map((kind) => {
                    const kindMeta = KIND_META[kind];
                    const checked = isEnabled(kind, ch);
                    const key = ruleKey(kind, ch);
                    return (
                      <div
                        key={kind}
                        className="px-5 py-3 flex items-center gap-4 hover:bg-muted/15 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium leading-tight">
                            {kindMeta?.title ?? kind}
                          </p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={checked}
                          aria-label={`${kindMeta?.title ?? kind} via ${meta.label}`}
                          disabled={pending.has(key)}
                          onClick={() => handleToggle(kind, ch, !checked)}
                          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 disabled:opacity-50 ${
                            checked
                              ? "bg-emerald-600"
                              : "bg-muted-foreground/25"
                          } ${!active && checked ? "opacity-60" : ""}`}
                        >
                          <span
                            className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform ${
                              checked ? "translate-x-4" : "translate-x-0"
                            }`}
                          />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Footnote */}
      <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
        Events fire on every configured channel by default. Toggle off to
        silence per-channel — preferences are saved even before a channel is
        set up.
      </p>
      {error && data && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
}

// ─────────────────────────────────────────────
// Channel card - compact status card
// ─────────────────────────────────────────────
function ChannelCard({
  channel,
  active,
  statusText,
  action,
}: {
  channel: Channel;
  active: boolean;
  statusText: string;
  action?: ReactNode;
}) {
  const meta = CHANNEL_META[channel];
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3.5 flex items-center gap-3">
      <div
        className={`size-8 rounded-md border flex items-center justify-center shrink-0 ${
          active
            ? `${meta.tintBg} ${meta.tintBorder} ${meta.tintText}`
            : "border-border bg-muted/40 text-muted-foreground/50"
        }`}
      >
        <span className="[&>svg]:size-3.5">{meta.icon}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium leading-tight">{meta.label}</p>
          <span
            className={`size-1.5 rounded-full shrink-0 ${
              active ? "bg-emerald-500" : "bg-muted-foreground/30"
            }`}
            aria-hidden
          />
        </div>
        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70 font-mono mt-0.5">
          {statusText}
        </p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────
// Module action - small uppercase text button
// ─────────────────────────────────────────────
function ModuleAction({
  onClick,
  disabled,
  tone = "default",
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "destructive";
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`text-[10px] font-semibold uppercase tracking-[0.14em] disabled:opacity-50 shrink-0 ${
        tone === "destructive"
          ? "text-destructive hover:opacity-80"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

