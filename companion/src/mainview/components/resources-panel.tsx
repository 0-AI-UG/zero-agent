import { useState, useEffect, useCallback } from "react";
import { Button } from "./ui/button.tsx";
import { cn } from "../lib/utils.ts";
import { getResources, removeContainer, removeImage, pruneAll } from "../rpc-bridge.ts";

interface Container {
	id: string;
	name: string;
	image: string;
	state: string;
	created: string;
}

interface Image {
	id: string;
	repository: string;
	tag: string;
	created: string;
}

interface Resources {
	containers: Container[];
	images: Image[];
}

function StatBlock({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</span>
			<span className="text-sm font-semibold tracking-tight">{value}</span>
			{sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
		</div>
	);
}

function StateIndicator({ state }: { state: string }) {
	const isRunning = state === "running";
	const isExited = state === "exited" || state === "stopped" || state === "created";
	return (
		<span className={cn(
			"w-1.5 h-1.5 rounded-full shrink-0",
			isRunning ? "bg-primary" : isExited ? "bg-muted-foreground" : "bg-muted-foreground",
		)} />
	);
}

function SectionHeader({ children }: { children: React.ReactNode }) {
	return (
		<div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-0.5">
			{children}
		</div>
	);
}

function DeleteButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
	return (
		<Button
			variant="ghost"
			size="xs"
			className="shrink-0 h-5 px-1.5 text-muted-foreground hover:text-destructive"
			disabled={loading}
			onClick={onClick}
		>
			{loading ? (
				<svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="animate-spin">
					<circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.2" />
					<path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
				</svg>
			) : (
				<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
					<path d="M2 3h8M4.5 3V2h3v1M3 3l.5 7a1 1 0 001 1h3a1 1 0 001-1L9 3" />
				</svg>
			)}
		</Button>
	);
}

export function ResourcesPanel({ onBack }: { onBack: () => void }) {
	const [resources, setResources] = useState<Resources | null>(null);
	const [loading, setLoading] = useState(true);
	const [removing, setRemoving] = useState<Set<string>>(new Set());
	const [pruning, setPruning] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const r = await getResources();
			setResources(r);
		} catch {}
		setLoading(false);
	}, []);

	useEffect(() => { refresh(); }, [refresh]);

	const handleRemoveContainer = async (id: string) => {
		setRemoving((prev) => new Set(prev).add(`c-${id}`));
		await removeContainer(id);
		setRemoving((prev) => { const n = new Set(prev); n.delete(`c-${id}`); return n; });
		refresh();
	};

	const handleRemoveImage = async (id: string) => {
		setRemoving((prev) => new Set(prev).add(`i-${id}`));
		await removeImage(id);
		setRemoving((prev) => { const n = new Set(prev); n.delete(`i-${id}`); return n; });
		refresh();
	};

	const handlePrune = async () => {
		setPruning(true);
		await pruneAll();
		setPruning(false);
		refresh();
	};

	if (loading && !resources) {
		return (
			<section className="flex flex-1 items-center justify-center">
				<span className="text-xs text-muted-foreground">Loading resources</span>
			</section>
		);
	}

	if (!resources) return null;

	const totalContainers = resources.containers.length;
	const runningContainers = resources.containers.filter((c) => c.state === "running").length;
	const totalImages = resources.images.length;

	return (
		<section className="flex flex-col flex-1 overflow-hidden">
			{/* Top bar */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-border">
				<div className="flex items-center gap-4">
					<StatBlock
						label="Containers"
						value={String(totalContainers)}
						sub={runningContainers > 0 ? `${runningContainers} running` : undefined}
					/>
					<StatBlock
						label="Images"
						value={String(totalImages)}
					/>
				</div>
				<div className="flex items-center gap-1.5">
					<Button
						variant="outline"
						size="xs"
						disabled={pruning || (totalContainers === 0 && totalImages === 0)}
						onClick={handlePrune}
					>
						{pruning ? "Cleaning" : "Clean up"}
					</Button>
					<Button
						variant="outline"
						size="xs"
						onClick={refresh}
						disabled={loading}
						className="h-6 w-6 p-0"
					>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" className={loading ? "animate-spin" : ""}>
							<path d="M1.5 6a4.5 4.5 0 018.25-2.5M10.5 6a4.5 4.5 0 01-8.25 2.5" />
							<path d="M10.5 1.5v2h-2M1.5 10.5v-2h2" />
						</svg>
					</Button>
				</div>
			</div>

			{/* Scrollable content */}
			<div className="flex-1 overflow-y-auto custom-scrollbar p-4 flex flex-col gap-3">
				{/* Containers */}
				{totalContainers > 0 && (
					<div className="flex flex-col gap-1.5">
						<SectionHeader>Containers</SectionHeader>
						<div className="rounded-lg border border-border bg-card overflow-hidden divide-y divide-border">
							{resources.containers.map((c) => (
								<div key={c.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
									<StateIndicator state={c.state} />
									<div className="flex flex-col min-w-0 flex-1">
										<span className="text-[11px] font-medium leading-tight truncate">
											{c.name || c.id}
										</span>
										<span className="text-[10px] text-muted-foreground leading-tight truncate">
											{c.image} · {c.state}
										</span>
									</div>
									<DeleteButton
										loading={removing.has(`c-${c.id}`)}
										onClick={() => handleRemoveContainer(c.id)}
									/>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Images */}
				{totalImages > 0 && (
					<div className="flex flex-col gap-1.5">
						<SectionHeader>Images</SectionHeader>
						<div className="rounded-lg border border-border bg-card overflow-hidden divide-y divide-border">
							{resources.images.map((img) => (
								<div key={img.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
									<div className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ backgroundColor: "var(--primary)", opacity: 0.5 }} />
									<div className="flex flex-col min-w-0 flex-1">
										<span className="text-[11px] font-medium leading-tight truncate">
											{img.repository === "<none>" ? img.id : `${img.repository}:${img.tag}`}
										</span>
										<span className="text-[10px] text-muted-foreground leading-tight">
											{img.id}
										</span>
									</div>
									<DeleteButton
										loading={removing.has(`i-${img.id}`)}
										onClick={() => handleRemoveImage(img.id)}
									/>
								</div>
							))}
						</div>
					</div>
				)}

				{totalContainers === 0 && totalImages === 0 && (
					<div className="flex-1 flex items-center justify-center text-[11px] text-muted-foreground">
						No resources found
					</div>
				)}
			</div>

		</section>
	);
}
