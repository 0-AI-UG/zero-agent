import { Badge } from "./ui/badge.tsx";
import { CodeBlock } from "./code-block.tsx";
import { FileList } from "./file-list.tsx";
import type { CodeExecution } from "../types.ts";

function ExitCodeBadge({ code, status }: { code?: number; status: string }) {
	if (status === "running") {
		return <Badge variant="outline" className="h-5 px-2 text-[10px] bg-amber-100 text-amber-700 border-amber-200">Running</Badge>;
	}
	if (code === undefined) return null;
	if (code === 0) {
		return <Badge variant="outline" className="h-5 px-2 text-[10px] bg-emerald-100 text-emerald-700 border-emerald-200">Exit 0</Badge>;
	}
	return <Badge variant="outline" className="h-5 px-2 text-[10px] bg-red-100 text-red-700 border-red-200">Exit {code}</Badge>;
}

export function ExecutionDetailView({
	execution,
}: {
	execution: CodeExecution;
}) {
	return (
		<section className="flex flex-col gap-2.5 p-3 flex-1 overflow-y-auto custom-scrollbar">
			{/* Header with entrypoint and exit code */}
			<div className="rounded-lg border border-border bg-card p-3 flex items-center gap-2">
				<span className="text-xs font-semibold font-mono truncate flex-1 min-w-0">
					{execution.command}
				</span>
				<ExitCodeBadge code={execution.exitCode} status={execution.status} />
			</div>

			{/* stdout */}
			{execution.stdout && (
				<div className="flex flex-col gap-1">
					<div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-0.5">Output</div>
					<CodeBlock label="stdout">{execution.stdout}</CodeBlock>
					{execution.truncated && (
						<span className="text-[10px] text-muted-foreground italic px-0.5">Output truncated (max 10KB)</span>
					)}
				</div>
			)}

			{/* stderr */}
			{execution.stderr && (
				<div className="flex flex-col gap-1">
					<div className="text-[10px] font-medium text-destructive uppercase tracking-wider px-0.5">Errors</div>
					<CodeBlock label="stderr" variant="error">{execution.stderr}</CodeBlock>
				</div>
			)}

			{/* Changed files */}
			{execution.changedFiles && execution.changedFiles.length > 0 && (
				<div className="flex flex-col gap-1">
					<div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-0.5">
						Changed Files ({execution.changedFiles.length})
					</div>
					<FileList files={execution.changedFiles} />
				</div>
			)}

			{/* Deleted files */}
			{execution.deletedFiles && execution.deletedFiles.length > 0 && (
				<div className="flex flex-col gap-1">
					<div className="text-[10px] font-medium text-destructive uppercase tracking-wider px-0.5">
						Deleted Files ({execution.deletedFiles.length})
					</div>
					<FileList files={execution.deletedFiles.map(p => ({ path: p }))} />
				</div>
			)}

			{/* Empty state */}
			{execution.status === "running" && !execution.stdout && !execution.stderr && (
				<div className="py-8 text-center text-[11px] text-muted-foreground">Waiting for output...</div>
			)}
		</section>
	);
}
