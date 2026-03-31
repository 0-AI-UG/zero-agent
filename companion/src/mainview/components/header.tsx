import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { cn } from "../lib/utils.ts";

type ConnectionState = "disconnected" | "connecting" | "connected";

function StatusBadge({ state }: { state: ConnectionState }) {
	const config: Record<ConnectionState, { label: string; dot: string; className: string }> = {
		disconnected: { label: "Offline", dot: "bg-muted-foreground", className: "" },
		connecting: { label: "Connecting", dot: "bg-muted-foreground", className: "bg-muted text-muted-foreground border-border" },
		connected: { label: "Online", dot: "bg-primary", className: "bg-muted text-foreground border-border" },
	};
	const { label, dot, className } = config[state];
	return (
		<Badge variant="outline" className={cn("no-drag gap-1.5 px-2 py-0 h-5 text-[10px] font-medium", className)}>
			<span className={cn("w-1.5 h-1.5 rounded-full", dot)} />
			{label}
		</Badge>
	);
}

export function Header({
	title,
	connection,
	canGoBack,
	onBack,
	onDisconnect,
	onResources,
}: {
	title: string;
	connection: ConnectionState;
	canGoBack: boolean;
	onBack: () => void;
	onDisconnect?: () => void;
	onResources?: () => void;
}) {
	return (
		<header className="drag-region flex items-center justify-between px-4 py-2.5 border-b border-border bg-card gap-3">
			<div className="flex items-center gap-2 min-w-0 flex-1">
				{canGoBack ? (
					<Button
						variant="ghost"
						size="xs"
						onClick={onBack}
						className="no-drag shrink-0 h-5 w-5 p-0"
					>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
							<path d="M7.5 9L4.5 6L7.5 3" />
						</svg>
					</Button>
				) : null}
				<span className="text-xs font-bold tracking-tight truncate">{title}</span>
			</div>
			<div className="flex items-center gap-2 shrink-0">
				{onResources && (
					<Button
						variant="ghost"
						size="xs"
						onClick={onResources}
						className="no-drag h-5 px-1.5 text-muted-foreground"
						title="Resources"
					>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
							<rect x="1.5" y="1.5" width="3.5" height="3.5" rx="0.5" />
							<rect x="7" y="1.5" width="3.5" height="3.5" rx="0.5" />
							<rect x="1.5" y="7" width="3.5" height="3.5" rx="0.5" />
							<rect x="7" y="7" width="3.5" height="3.5" rx="0.5" />
						</svg>
					</Button>
				)}
				{onDisconnect && (
					<Button
						variant="ghost"
						size="xs"
						onClick={onDisconnect}
						className="no-drag h-5 px-1.5 text-muted-foreground hover:text-destructive"
					>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
							<path d="M4.5 6H10.5M8.5 4L10.5 6L8.5 8M7.5 2H3C2.44772 2 2 2.44772 2 3V9C2 9.55228 2.44772 10 3 10H7.5" />
						</svg>
					</Button>
				)}
				<StatusBadge state={connection} />
			</div>
		</header>
	);
}
