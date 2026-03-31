import { cn } from "../lib/utils.ts";
import type { SessionDetail, WorkspaceDetail } from "../types.ts";

export function Overview({
	sessions,
	workspaces,
	onSelectSession,
	onSelectWorkspace,
}: {
	sessions: Map<string, SessionDetail>;
	workspaces: Map<string, WorkspaceDetail>;
	onSelectSession: (id: string) => void;
	onSelectWorkspace: (id: string) => void;
}) {
	const empty = sessions.size === 0 && workspaces.size === 0;

	return (
		<section className="flex flex-col gap-3 p-4 flex-1 overflow-y-auto custom-scrollbar">
			{/* Browser Sessions */}
			{sessions.size > 0 && (
				<div className="flex flex-col gap-1.5">
					<div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-0.5">
						Browser Sessions
					</div>
					<div className="rounded-lg border border-border bg-card overflow-hidden divide-y divide-border">
						{[...sessions.entries()].map(([id, s]) => (
							<button
								key={id}
								onClick={() => onSelectSession(id)}
								className="flex items-center gap-2.5 px-3.5 py-2.5 w-full text-left hover:bg-accent"
							>
								<span className="w-1.5 h-1.5 rounded-full shrink-0 bg-primary" />
								<div className="flex flex-col min-w-0 flex-1">
									<span className="text-[11px] font-medium leading-tight truncate">
										{s.label ?? s.title ?? `Session ${id.slice(0, 6)}`}
									</span>
									<span className="text-[10px] text-muted-foreground leading-tight truncate">
										{s.url ?? "No page loaded"}
										{s.actions.length > 0 && ` \u00B7 ${s.actions.length} action${s.actions.length !== 1 ? "s" : ""}`}
									</span>
								</div>
								<svg className="w-3 h-3 text-muted-foreground shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
									<path d="M4.5 3L7.5 6L4.5 9" />
								</svg>
							</button>
						))}
					</div>
				</div>
			)}

			{/* Workspaces */}
			{workspaces.size > 0 && (
				<div className="flex flex-col gap-1.5">
					<div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-0.5">
						Workspaces
					</div>
					<div className="rounded-lg border border-border bg-card overflow-hidden divide-y divide-border">
						{[...workspaces.entries()].map(([id, ws]) => (
							<button
								key={id}
								onClick={() => onSelectWorkspace(id)}
								className="flex items-center gap-2.5 px-3.5 py-2.5 w-full text-left hover:bg-accent"
							>
								<span className={cn("w-1.5 h-1.5 rounded-full shrink-0", ws.status === "running" ? "bg-muted-foreground" : ws.status === "error" ? "bg-destructive" : "bg-primary")} />
								<div className="flex flex-col min-w-0 flex-1">
									<span className="text-[11px] font-medium leading-tight font-mono">{id.slice(0, 8)}</span>
									<span className="text-[10px] text-muted-foreground leading-tight">
										{ws.status === "running" ? "Running" : ws.status === "error" ? "Error" : "Ready"}
										{ws.executions.length > 0 && ` \u00B7 ${ws.executions.length} run${ws.executions.length > 1 ? "s" : ""}`}
									</span>
								</div>
								<svg className="w-3 h-3 text-muted-foreground shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
									<path d="M4.5 3L7.5 6L4.5 9" />
								</svg>
							</button>
						))}
					</div>
				</div>
			)}

			{empty && (
				<div className="flex-1 flex items-center justify-center text-[11px] text-muted-foreground">
					No active sessions or workspaces
				</div>
			)}
		</section>
	);
}
