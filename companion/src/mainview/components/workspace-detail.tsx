import { cn } from "../lib/utils.ts";
import { Badge } from "./ui/badge.tsx";
import { FileList } from "./file-list.tsx";
import type { WorkspaceDetail, CodeExecution } from "../types.ts";

function timeAgo(ts: number): string {
	const diff = Math.floor((Date.now() - ts) / 1000);
	if (diff < 5) return "now";
	if (diff < 60) return `${diff}s`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m`;
	return `${Math.floor(diff / 3600)}h`;
}

function ExitCodeBadge({ code, status }: { code?: number; status: string }) {
	if (status === "running") {
		return <Badge variant="outline" className="h-4 px-1.5 text-[9px] bg-muted text-muted-foreground border-border">running</Badge>;
	}
	if (code === undefined) return null;
	if (code === 0) {
		return <Badge variant="outline" className="h-4 px-1.5 text-[9px] bg-muted text-muted-foreground border-border">exit 0</Badge>;
	}
	return <Badge variant="outline" className="h-4 px-1.5 text-[9px] bg-muted text-destructive border-border">exit {code}</Badge>;
}

export function WorkspaceDetailView({
	workspaceId,
	workspace,
	onSelectExecution,
}: {
	workspaceId: string;
	workspace: WorkspaceDetail;
	onSelectExecution: (index: number) => void;
}) {
	const statusDot = workspace.status === "running" ? "bg-muted-foreground"
		: workspace.status === "error" ? "bg-destructive"
		: "bg-primary";

	const statusLabel = workspace.status === "running" ? "Running"
		: workspace.status === "error" ? "Error"
		: "Ready";

	return (
		<section className="flex flex-col gap-3 p-4 flex-1 overflow-y-auto custom-scrollbar">
			{/* Status header */}
			<div className="rounded-lg border border-border bg-card p-3">
				<div className="flex items-center gap-2">
					<span className={cn("w-2 h-2 rounded-full shrink-0", statusDot)} />
					<span className="text-xs font-semibold font-mono">{workspaceId.slice(0, 12)}</span>
					<span className="text-[10px] text-muted-foreground">{statusLabel}</span>
				</div>
			</div>

			{/* Files */}
			{workspace.files.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-0.5">
						Files ({workspace.files.length})
					</div>
					<FileList files={workspace.files.map(f => ({ path: f }))} />
				</div>
			)}

			{/* Executions */}
			<div className="flex flex-col gap-1.5flex-1 min-h-0">
				<div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-0.5">
					Executions ({workspace.executions.length})
				</div>
				<div className="flex-1 min-h-0 rounded-lg border border-border bg-card overflow-hidden">
					{workspace.executions.length === 0 ? (
						<div className="py-8 text-center text-[11px] text-muted-foreground">No executions yet</div>
					) : (
						<div className="flex flex-col divide-y divide-border overflow-y-auto max-h-full custom-scrollbar">
							{[...workspace.executions].reverse().map((exec, reverseIdx) => {
								const idx = workspace.executions.length - 1 - reverseIdx;
								return (
									<button
										key={idx}
										onClick={() => onSelectExecution(idx)}
										className="flex items-center gap-2.5 px-3.5 py-2.5 w-full text-left hover:bg-accent"
									>
										<div className="flex flex-col min-w-0 flex-1">
											<span className="text-[11px] font-medium leading-tight truncate font-mono">
												{exec.command}
											</span>
											<span className="text-[10px] text-muted-foreground leading-tight">
												{timeAgo(exec.timestamp)}
											</span>
										</div>
										<ExitCodeBadge code={exec.exitCode} status={exec.status} />
										<svg className="w-3 h-3 text-muted-foreground shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
											<path d="M4.5 3L7.5 6L4.5 9" />
										</svg>
									</button>
								);
							})}
						</div>
					)}
				</div>
			</div>
		</section>
	);
}
