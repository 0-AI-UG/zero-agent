import { useState, useEffect, useRef } from "react";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { setSetupProgressHandler } from "../rpc-bridge.ts";

interface ConnectPanelProps {
	onConnect: (token: string, server: string) => void;
	error: string;
	runtimeReady: boolean | "checking" | "setting-up";
	canSetup: boolean;
	needsWsl: boolean;
	onSetup: () => void;
	onInstallWsl: () => void;
}

function Spinner({ size = 16 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ verticalAlign: "middle" }}>
			<circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.25" opacity="0.2" />
			<path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
				<animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.8s" repeatCount="indefinite" />
			</path>
		</svg>
	);
}

function CheckIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
			<circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.25" />
			<path d="M4.5 7l2 2 3-3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function ErrorIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
			<circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.25" />
			<path d="M5 5l4 4M9 5l-4 4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
		</svg>
	);
}

interface LogEntry {
	step: string;
	detail?: string;
	ts: number;
}

function SetupProgress({ error }: { error: string }) {
	const [currentStep, setCurrentStep] = useState("Initializing");
	const [log, setLog] = useState<LogEntry[]>([]);
	const logRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		setSetupProgressHandler((step, detail) => {
			if (step !== "output") {
				setCurrentStep(step);
			}
			setLog((prev) => [...prev, { step, detail, ts: Date.now() }]);
		});
		return () => setSetupProgressHandler(() => {});
	}, []);

	// Auto-scroll log
	useEffect(() => {
		if (logRef.current) {
			logRef.current.scrollTop = logRef.current.scrollHeight;
		}
	}, [log]);

	return (
		<section className="flex flex-1 flex-col px-8 py-6">
			<div className="flex items-center gap-2.5 mb-1">
				{error ? (
					<div className="text-destructive"><ErrorIcon /></div>
				) : (
					<div style={{ color: "var(--primary)" }}><Spinner /></div>
				)}
				<h2 className="text-sm font-semibold tracking-tight font-display">
					{error ? "Setup failed" : currentStep}
				</h2>
			</div>

			{!error && (
				<p className="text-[11px] text-muted-foreground mb-4">
					This may take a few minutes on first run
				</p>
			)}

			{error && (
				<p className="text-[11px] text-destructive mb-4">{error}</p>
			)}

			<div
				ref={logRef}
				className="flex-1 rounded-lg p-3 overflow-y-auto custom-scrollbar font-mono"
				style={{
					backgroundColor: "var(--muted)",
					maxHeight: "180px",
					minHeight: "80px",
				}}
			>
				{log.length === 0 && !error && (
					<p className="text-[10px] text-muted-foreground">Waiting for output</p>
				)}
				{log.map((entry, i) => (
					<div key={i} className="flex gap-1.5 leading-relaxed">
						{entry.step === "output" ? (
							<span className="text-[10px] text-muted-foreground">{entry.detail}</span>
						) : (
							<span className="text-[10px] text-foreground font-medium">{entry.step}{entry.detail ? ` — ${entry.detail}` : ""}</span>
						)}
					</div>
				))}
			</div>
		</section>
	);
}

export function ConnectPanel({ onConnect, error, runtimeReady, canSetup, needsWsl, onSetup, onInstallWsl }: ConnectPanelProps) {
	const [token, setToken] = useState("");
	const [server, setServer] = useState("http://localhost:3000");
	const [submitting, setSubmitting] = useState(false);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!token.trim()) return;
		setSubmitting(true);
		onConnect(token.trim(), server.trim());
	};

	useEffect(() => {
		if (error) setSubmitting(false);
	}, [error]);

	if (runtimeReady === "checking") {
		return (
			<section className="flex flex-1 items-center justify-center px-8">
				<div className="flex items-center gap-2">
					<div style={{ color: "var(--primary)" }}><Spinner /></div>
					<p className="text-xs text-muted-foreground">Checking container runtime</p>
				</div>
			</section>
		);
	}

	if (runtimeReady === "setting-up") {
		return <SetupProgress error={error} />;
	}

	if (!runtimeReady) {
		return (
			<section className="flex flex-1 items-center justify-center px-8">
				<div className="w-full">
					<h2 className="text-lg font-bold tracking-tight mb-1 font-display">Setup Required</h2>
					{needsWsl ? (
						<>
							<p className="text-xs text-muted-foreground mb-5 leading-relaxed">
								Docker requires WSL2 (Windows Subsystem for Linux) to run containers.
								This will enable WSL2 on your system and may require a restart.
							</p>
							<Button size="sm" className="w-full" onClick={onInstallWsl}>
								Enable WSL2
							</Button>
						</>
					) : canSetup ? (
						<>
							<p className="text-xs text-muted-foreground mb-5 leading-relaxed">
								Docker is required to run isolated workspaces.
								This will install Colima and the Docker CLI via Homebrew.
							</p>
							<Button size="sm" className="w-full" onClick={onSetup}>
								Install Docker
							</Button>
						</>
					) : (
						<p className="text-xs text-muted-foreground mb-5 leading-relaxed">
							A container runtime is required but could not be found. Please reinstall the companion app.
						</p>
					)}
					{error && <p className="text-[11px] text-destructive text-center mt-3">{error}</p>}
				</div>
			</section>
		);
	}

	return (
		<section className="flex flex-1 items-center justify-center px-8">
			<div className="w-full">
				<h2 className="text-lg font-bold tracking-tight mb-1 font-display">Connect</h2>
				<p className="text-xs text-muted-foreground mb-5 leading-relaxed">Enter your token and server address.</p>
				<form onSubmit={handleSubmit} className="flex flex-col gap-3">
					<div className="flex flex-col gap-1">
						<Label htmlFor="token" className="text-[11px] text-muted-foreground">Token</Label>
						<Input
							type="password"
							id="token"
							placeholder="Paste companion token"
							autoComplete="off"
							value={token}
							onChange={(e) => setToken(e.target.value)}
							disabled={submitting}
							className="h-8 text-xs"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="server" className="text-[11px] text-muted-foreground">Server</Label>
						<Input
							type="text"
							id="server"
							value={server}
							onChange={(e) => setServer(e.target.value)}
							disabled={submitting}
							className="h-8 text-xs"
						/>
					</div>
					<Button type="submit" size="sm" disabled={submitting || !token.trim()} className="w-full mt-1">
						{submitting ? "Connecting" : "Connect"}
					</Button>
					{error && <p className="text-[11px] text-destructive text-center">{error}</p>}
				</form>
			</div>
		</section>
	);
}
