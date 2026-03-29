import { cn } from "../lib/utils.ts";
import { Badge } from "./ui/badge.tsx";
import type { SessionDetail } from "../types.ts";

function timeAgo(ts: number): string {
	const diff = Math.floor((Date.now() - ts) / 1000);
	if (diff < 5) return "now";
	if (diff < 60) return `${diff}s`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m`;
	return `${Math.floor(diff / 3600)}h`;
}

const ACTION_CONFIG: Record<string, { label: string; dot: string }> = {
	navigate: { label: "Navigate", dot: "bg-blue-500" },
	click: { label: "Click", dot: "bg-emerald-500" },
	type: { label: "Type", dot: "bg-emerald-500" },
	screenshot: { label: "Screenshot", dot: "bg-violet-500" },
	snapshot: { label: "Read page", dot: "bg-violet-500" },
	scroll: { label: "Scroll", dot: "bg-slate-400" },
	evaluate: { label: "Run script", dot: "bg-amber-500" },
	back: { label: "Back", dot: "bg-slate-400" },
	forward: { label: "Forward", dot: "bg-slate-400" },
	reload: { label: "Reload", dot: "bg-slate-400" },
	wait: { label: "Wait", dot: "bg-slate-400" },
	hover: { label: "Hover", dot: "bg-emerald-500" },
	select: { label: "Select", dot: "bg-emerald-500" },
	tabs: { label: "List tabs", dot: "bg-slate-400" },
	switchTab: { label: "Switch tab", dot: "bg-blue-500" },
	closeTab: { label: "Close tab", dot: "bg-red-400" },
};

export function SessionDetailView({
	sessionId,
	session,
}: {
	sessionId: string;
	session: SessionDetail;
}) {
	const hasUrl = !!session.url;

	return (
		<section className="flex flex-col gap-3 p-4 flex-1 overflow-y-auto custom-scrollbar">
			{/* Status header */}
			<div className="rounded-lg border border-border bg-card p-3">
				<div className="flex items-center gap-2">
					<span className="w-2 h-2 rounded-full shrink-0 bg-blue-500" />
					<span className="text-xs font-semibold truncate flex-1 min-w-0">
						{session.label ?? session.title ?? "Browser Tab"}
					</span>
					<Badge variant="outline" className="h-4 px-1.5 text-[9px] bg-blue-50 text-blue-700 border-blue-200">
						{session.actions.length} action{session.actions.length !== 1 ? "s" : ""}
					</Badge>
				</div>
				{session.label && session.title && (
					<div className="text-[11px] text-muted-foreground mt-1 pl-4 truncate">{session.title}</div>
				)}
			</div>

			{/* Current page */}
			{hasUrl && (
				<div className="flex flex-col gap-1.5">
					<div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-0.5">
						Current Page
					</div>
					<div className="rounded-lg border border-border bg-card p-3">
						<span className="text-[10px] text-muted-foreground font-mono truncate block leading-relaxed">{session.url}</span>
					</div>
				</div>
			)}

			{/* Action history */}
			<div className="flex flex-col gap-1.5flex-1 min-h-0">
				<div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-0.5">
					Actions ({session.actions.length})
				</div>
				<div className="flex-1 min-h-0 rounded-lg border border-border bg-card overflow-hidden">
					{session.actions.length === 0 ? (
						<div className="py-8 text-center text-[11px] text-muted-foreground">No actions yet</div>
					) : (
						<div className="flex flex-col divide-y divide-border overflow-y-auto max-h-full custom-scrollbar">
							{[...session.actions].reverse().map((action, i) => {
								const cfg = ACTION_CONFIG[action.action] ?? { label: action.action, dot: "bg-muted-foreground" };
								return (
									<div key={`${action.timestamp}-${i}`} className="flex items-center gap-2.5 px-3.5 py-2.5">
										<span className={cn("w-1.5 h-1.5 rounded-full shrink-0", cfg.dot)} />
										<div className="flex flex-col min-w-0 flex-1">
											<span className="text-[11px] font-medium leading-tight">{cfg.label}</span>
											{action.detail && (
												<span className="text-[10px] text-muted-foreground truncate leading-tight font-mono">{action.detail}</span>
											)}
										</div>
										<span className="text-[9px] text-muted-foreground whitespace-nowrap shrink-0 tabular-nums">{timeAgo(action.timestamp)}</span>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</div>

			{/* Errors */}
			{session.errors.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<div className="text-[10px] font-medium text-destructive uppercase tracking-wider px-0.5">
						Errors ({session.errors.length})
					</div>
					<div className="rounded-lg border border-destructive/20 bg-card overflow-hidden divide-y divide-border">
						{session.errors.map((err, i) => (
							<div key={i} className="flex items-center gap-2.5 px-3.5 py-2.5">
								<span className="w-1.5 h-1.5 rounded-full shrink-0 bg-destructive" />
								<span className="text-[11px] text-destructive truncate">{err}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</section>
	);
}
