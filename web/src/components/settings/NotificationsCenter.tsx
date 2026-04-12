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
  sync_approval: {
    title: "File-change approvals",
    description: "When an agent needs you to review a write to your project.",
  },
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
    tintText: "text-emerald-600 dark:text-emerald-400",
    tintBg: "bg-emerald-500/10",
    tintBorder: "border-emerald-500/30",
    icon: <RadioIcon className="size-3.5" />,
  },
  push: {
    label: "Push",
    tintText: "text-violet-600 dark:text-violet-400",
    tintBg: "bg-violet-500/10",
    tintBorder: "border-violet-500/30",
    icon: <SmartphoneIcon className="size-3.5" />,
  },
  telegram: {
    label: "Telegram",
    tintText: "text-sky-600 dark:text-sky-400",
    tintBg: "bg-sky-500/10",
    tintBorder: "border-sky-500/30",
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

  return (
    <section className="space-y-4">
      {/* Section header — matches sibling settings sections */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BellIcon className="size-4 text-violet-500" />
          <h3 className="text-sm font-semibold">Notifications</h3>
        </div>
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60 font-mono">
          Console
        </span>
      </div>

      {/* Unified card: channel strip + events ledger + install footer */}
      <div className="rounded-lg border bg-card overflow-hidden">
        {/* ─── Channel strip ─── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border">
          <ChannelModule
            channel="ws"
            subtitle="Browser tab & toast"
            active={availability.ws}
            statusText={availability.ws ? "Always on" : "Disconnected"}
          />
          <ChannelModule
            channel="push"
            subtitle="OS notifications"
            active={availability.push}
            statusText={
              !push.isSupported
                ? "Not supported"
                : push.isSubscribed
                  ? "This device"
                  : "Off"
            }
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
          <ChannelModule
            channel="telegram"
            subtitle={
              tgStatus?.linked && tgStatus.telegramUsername
                ? `@${tgStatus.telegramUsername}`
                : "Chat & alerts"
            }
            active={availability.telegram}
            statusText={
              tgLoading
                ? "Checking…"
                : !tgStatus?.configured
                  ? "Not configured"
                  : tgStatus.linked
                    ? "Linked"
                    : "Not linked"
            }
            action={
              tgStatus?.configured ? (
                tgStatus.linked ? (
                  confirmUnlink ? (
                    <span className="flex items-center gap-3">
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

        {/* ─── Telegram active-project picker ─── */}
        {tgStatus?.linked && tgStatus.projects.length > 0 && (
          <div className="border-t border-border bg-muted/20 px-5 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <SendIcon className="size-3.5 text-sky-500 shrink-0" />
              <p className="text-xs text-muted-foreground truncate">
                Default project for Telegram messages
              </p>
            </div>
            <select
              value={tgStatus.activeProjectId ?? ""}
              disabled={
                setActiveProject.isPending || tgStatus.projects.length < 2
              }
              onChange={(e) => {
                const next = e.target.value || null;
                setActiveProject.mutate(next);
              }}
              className="text-xs rounded-md border bg-background px-2 py-1 max-w-[55%] truncate disabled:opacity-60"
            >
              {tgStatus.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* ─── Telegram link-code reveal (inline, no animation) ─── */}
        {tgStatus?.configured && !tgStatus.linked && code && (
          <div className="border-t border-border bg-muted/30 px-5 py-4">
            <div className="flex items-start gap-4">
              <div className="size-9 rounded-md border border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                <SendIcon className="size-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground">
                  Open Telegram, message{" "}
                  <span className="font-medium text-foreground">
                    {code.botUsername ? `@${code.botUsername}` : "the bot"}
                  </span>
                  , and send the code below.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="flex-1 rounded-md border bg-background px-3 py-2 text-sm font-mono tracking-wider truncate">
                    /start {code.code}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(`/start ${code.code}`);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="rounded-md border bg-background size-9 flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0"
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
                    Expires in {Math.round(code.expiresIn / 60)} min · waiting
                    for confirmation
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
            </div>
          </div>
        )}

        {/* ─── Events ledger ─── */}
        <div className="border-t border-border">
          <div className="flex items-center justify-between px-5 py-2.5">
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-mono">
              Events
            </span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60 font-mono hidden sm:block">
              Toggle per channel
            </span>
          </div>

          {error && !data ? (
            <p className="px-5 pb-5 text-xs text-destructive">{error}</p>
          ) : !data ? (
            <ul className="divide-y divide-border border-t border-border">
              {Object.keys(KIND_META).map((kind, i) => (
                <li key={kind} className="px-5 py-4 flex items-center gap-4">
                  <span className="font-mono text-[10px] text-muted-foreground/40 tabular-nums shrink-0 w-5">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="flex-1">
                    <div className="h-3 w-32 rounded bg-muted" />
                    <div className="h-2 w-48 mt-2 rounded bg-muted/60" />
                  </div>
                  <div className="flex items-center gap-2">
                    {(["ws", "push", "telegram"] as const).map((c) => (
                      <div
                        key={c}
                        className="size-7 rounded-md border border-border bg-muted/40"
                      />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {kinds.map((kind, idx) => {
                const meta = KIND_META[kind];
                return (
                  <li
                    key={kind}
                    className="px-5 py-4 flex items-center gap-4 hover:bg-muted/20"
                  >
                    <span className="font-mono text-[10px] text-muted-foreground/40 tabular-nums shrink-0 w-5">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-tight">
                        {meta?.title ?? kind}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {meta?.description ?? kind}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {channels.map((ch) => (
                        <ChannelChip
                          key={ch}
                          channel={ch}
                          checked={isEnabled(kind, ch)}
                          available={availability[ch]}
                          disabled={pending.has(ruleKey(kind, ch))}
                          onChange={(v) => handleToggle(kind, ch, v)}
                        />
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ─── Install / iOS hint footer ─── */}
        {(canInstall || (isIOS && !isStandalone)) && (
          <div className="border-t border-border bg-muted/20 px-5 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
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

      {/* Footnote + non-fatal errors */}
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Default-on: events fire on every configured channel. Toggle a chip off
        to silence that event on that channel — even if the channel isn&apos;t
        set up yet, your preference is remembered for when it is.
      </p>
      {error && data && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
}

// ─────────────────────────────────────────────
// Channel module — one column of the top strip
// ─────────────────────────────────────────────
function ChannelModule({
  channel,
  subtitle,
  active,
  statusText,
  action,
}: {
  channel: Channel;
  subtitle: string;
  active: boolean;
  statusText: string;
  action?: ReactNode;
}) {
  const meta = CHANNEL_META[channel];
  return (
    <div className="p-4 flex flex-col gap-3 min-h-[8.5rem]">
      <div className="flex items-start justify-between gap-2">
        <div
          className={`size-9 rounded-md border flex items-center justify-center shrink-0 ${
            active
              ? `${meta.tintBg} ${meta.tintBorder} ${meta.tintText}`
              : "border-border bg-muted/40 text-muted-foreground"
          }`}
        >
          <span className="[&>svg]:size-4">{meta.icon}</span>
        </div>
        <span
          className={`size-1.5 rounded-full mt-3 ${
            active ? "bg-emerald-500" : "bg-muted-foreground/30"
          }`}
          aria-hidden
        />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-display font-semibold leading-tight tracking-tight">
          {meta.label}
        </p>
        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
          {subtitle}
        </p>
      </div>
      <div className="flex items-center justify-between gap-2 mt-auto pt-1">
        <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80 font-mono truncate">
          {statusText}
        </span>
        {action}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Module action — small uppercase text button
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

// ─────────────────────────────────────────────
// Channel chip — square icon toggle (event row)
// ─────────────────────────────────────────────
function ChannelChip({
  channel,
  checked,
  available,
  disabled,
  onChange,
}: {
  channel: Channel;
  checked: boolean;
  available: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const meta = CHANNEL_META[channel];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${meta.label} notifications`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      title={
        !available
          ? `${meta.label} channel is not configured — your preference is saved for when it is.`
          : `${meta.label}: ${checked ? "on" : "off"}`
      }
      className={`relative size-7 rounded-md border flex items-center justify-center disabled:opacity-50 ${
        checked
          ? `${meta.tintBg} ${meta.tintBorder} ${meta.tintText}`
          : "border-border bg-background text-muted-foreground/50 hover:text-foreground hover:border-muted-foreground/40"
      } ${!available && checked ? "opacity-60" : ""}`}
    >
      {meta.icon}
      {!available && checked && (
        <span
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-amber-500 ring-2 ring-card"
          aria-hidden
        />
      )}
    </button>
  );
}
