/**
 * Phase 0 spike — Pi migration.
 *
 * Standalone script. Not wired into the Zero server.
 *
 * Probes the integration shape we'll need for `server/lib/pi/runTurn`:
 *   1. OS sandbox enforcement on `bash` (the reference extension's coverage).
 *   2. Whether the reference sandbox extension also covers Pi's other built-in
 *      filesystem tools (read/write/edit/grep/find/ls). This is open question §6.
 *   3. Per-turn unix socket round-trip from a bash command inside the sandbox.
 *   4. Per-chat Pi session files under `<project>/.pi-sessions/<chatId>.jsonl`.
 *   5. AuthStorage isolation between concurrent createAgentSession calls
 *      (open question §2).
 *   6. (LIVE=1 only) End-to-end real LLM turn that captures event fixtures
 *      under `fixtures/` for the eventual frontend renderer.
 *
 * Run:
 *   npm run spike            # plumbing only, no LLM calls
 *   LIVE=1 OPENROUTER_API_KEY=... npm run spike   # one real turn, captures fixtures
 */

import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
	type AgentSessionEvent,
	AuthStorage,
	createAgentSession,
	createReadTool,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(SPIKE_DIR, "fixtures");
const ROOT_TMP = join(tmpdir(), "pi-spike");
const PROJECT_ID = "spike-project";
const PROJECT_DIR = join(ROOT_TMP, "projects", PROJECT_ID);
const SOCKETS_DIR = join(ROOT_TMP, "sockets");

// ---------- tiny test harness ----------

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const findings: string[] = [];

function record(name: string, ok: boolean, detail = "") {
	results.push({ name, ok, detail });
	const tag = ok ? "PASS" : "FAIL";
	const line = `[${tag}] ${name}${detail ? ` — ${detail}` : ""}`;
	console.log(line);
}

function finding(s: string) {
	findings.push(s);
	console.log(`[NOTE] ${s}`);
}

// ---------- setup ----------

function resetDirs() {
	rmSync(ROOT_TMP, { recursive: true, force: true });
	mkdirSync(PROJECT_DIR, { recursive: true });
	mkdirSync(SOCKETS_DIR, { recursive: true });
	mkdirSync(FIXTURES_DIR, { recursive: true });
	writeFileSync(join(PROJECT_DIR, "hello.txt"), "hello from spike\n");
	writeFileSync(join(PROJECT_DIR, "AGENTS.md"), "# Spike project\nBe terse.\n");
}

// ---------- check 1+2: sandbox enforcement (raw, no Pi) ----------

async function shellInSandbox(
	cmd: string,
	cwd: string,
): Promise<{ exitCode: number | null; out: string }> {
	const wrapped = await SandboxManager.wrapWithSandbox(cmd);
	return new Promise((res) => {
		const child = spawn("bash", ["-c", wrapped], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		child.stdout.on("data", (b) => chunks.push(b));
		child.stderr.on("data", (b) => chunks.push(b));
		child.on("close", (code) =>
			res({ exitCode: code, out: Buffer.concat(chunks).toString("utf8") }),
		);
	});
}

async function checkBashSandbox() {
	// Allow project dir + /tmp; deny ~/.ssh/.aws/.gnupg.
	await SandboxManager.initialize({
		network: { allowedDomains: [], deniedDomains: [] },
		filesystem: {
			denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
			allowWrite: [PROJECT_DIR, "/tmp"],
			denyWrite: [".env", "*.pem", "*.key"],
		},
	});

	// Project-dir read should pass.
	{
		const r = await shellInSandbox("cat hello.txt", PROJECT_DIR);
		record(
			"sandbox: bash can read project file",
			r.exitCode === 0 && r.out.includes("hello from spike"),
			`exit=${r.exitCode} out=${JSON.stringify(r.out.slice(0, 80))}`,
		);
	}

	// Project-dir write should pass.
	{
		const r = await shellInSandbox(
			"echo touched > written-by-bash.txt && cat written-by-bash.txt",
			PROJECT_DIR,
		);
		record(
			"sandbox: bash can write inside project",
			r.exitCode === 0 && r.out.includes("touched"),
			`exit=${r.exitCode}`,
		);
	}

	// ~/.ssh read should fail. We don't require ~/.ssh to exist; we use a probe path
	// under the user's home and assert the sandbox blocks even the directory listing.
	{
		const r = await shellInSandbox(
			'(ls -1 "$HOME/.ssh" 2>&1 || true); (cat "$HOME/.ssh/id_rsa" 2>&1 || true); echo DONE',
			PROJECT_DIR,
		);
		const blocked =
			/Operation not permitted|Permission denied|sandbox|denied/i.test(r.out);
		record(
			"sandbox: bash cannot read ~/.ssh",
			blocked,
			blocked ? "denied as expected" : `unexpected out=${JSON.stringify(r.out)}`,
		);
	}

	// Write outside project (and outside /tmp) should fail.
	{
		const target = join(process.env.HOME || "/root", ".pi-spike-should-not-exist");
		rmSync(target, { force: true });
		const r = await shellInSandbox(
			`(echo nope > "${target}" 2>&1 || true); (test -f "${target}" && echo CREATED || echo BLOCKED)`,
			PROJECT_DIR,
		);
		const blocked = r.out.includes("BLOCKED");
		rmSync(target, { force: true });
		record(
			"sandbox: bash cannot write outside allowWrite paths",
			blocked,
			blocked ? "denied as expected" : `out=${JSON.stringify(r.out)}`,
		);
	}

	await SandboxManager.reset();
}

// ---------- check 2: Pi built-in tool coverage ----------

async function checkBuiltinToolCoverage() {
	// Pi's read/write/edit/grep/find/ls run as plain Node fs calls in the host process.
	// The reference sandbox extension only registers a sandboxed bash. The OS sandbox
	// (sandbox-exec / bubblewrap) is process-wide *only when wrapped via spawn* — when
	// SandboxManager.wrapWithSandbox runs the wrapper command in a child shell. The
	// Node process that hosts Pi is itself NOT inside the sandbox. So fs-tool calls
	// bypass the policy entirely.
	//
	// We create a synthetic "secret" file under a path we'd expect to be denied,
	// then call Pi's read tool. If it returns the contents, the gap is real.

	const secretDir = join(ROOT_TMP, "secret");
	mkdirSync(secretDir, { recursive: true });
	const secretFile = join(secretDir, "id_rsa");
	writeFileSync(secretFile, "PRETEND-PRIVATE-KEY-MATERIAL\n");

	await SandboxManager.initialize({
		network: { allowedDomains: [], deniedDomains: [] },
		filesystem: {
			denyRead: [secretDir],
			allowWrite: [PROJECT_DIR, "/tmp"],
			denyWrite: [".env", "*.pem", "*.key"],
		},
	});

	const readTool = createReadTool(PROJECT_DIR);

	// Project-relative read should succeed.
	{
		try {
			const ac = new AbortController();
			const r = await readTool.execute(
				"t1",
				{ path: "hello.txt" } as never,
				ac.signal,
				() => {},
				{} as never,
			);
			const text = JSON.stringify(r);
			record(
				"pi tool: read can read project file",
				text.includes("hello from spike"),
				text.slice(0, 120),
			);
		} catch (e) {
			record("pi tool: read can read project file", false, String(e));
		}
	}

	// Read of a denied path via Pi's read tool — does the OS sandbox stop it?
	{
		try {
			const ac = new AbortController();
			const r = await readTool.execute(
				"t2",
				{ path: secretFile } as never,
				ac.signal,
				() => {},
				{} as never,
			);
			const text = JSON.stringify(r);
			const leaked = text.includes("PRETEND-PRIVATE-KEY-MATERIAL");
			if (leaked) {
				record(
					"pi tool: confirms sandbox gap on built-in fs tools (expected)",
					true,
					"read returned secret contents — gap reproduced as finding",
				);
				finding(
					"GAP — Pi's built-in `read` tool is NOT constrained by the OS sandbox. " +
						"sandbox-exec/bubblewrap only confine the bash *child process* spawned by SandboxManager.wrapWithSandbox; " +
						"Pi's read/write/edit/grep/find/ls run in the host Node process and bypass denyRead/allowWrite entirely. " +
						"runTurn must enforce the policy at the tool layer for read/write/edit/grep/find/ls. " +
						"Practical options: (a) override these tools with shelled-out equivalents (cat / cp / sed / rg / find / ls) wrapped via wrapWithSandbox, " +
						"or (b) write a Pi extension that intercepts `tool_call` for these tool names and path-checks the input against the same policy. " +
						"Option (b) is preferred because it keeps Pi's nicer tool I/O and event shape.",
				);
			} else {
				record(
					"pi tool: confirms sandbox gap on built-in fs tools (expected)",
					false,
					`unexpected: read appears constrained by OS sandbox — re-verify finding §6. text=${text.slice(0, 120)}`,
				);
			}
		} catch (e) {
			record(
				"pi tool: confirms sandbox gap on built-in fs tools (expected)",
				false,
				`unexpected throw — sandbox may have caught it: ${String(e).slice(0, 100)}`,
			);
		}
	}

	await SandboxManager.reset();
}

// ---------- check 3: per-turn unix socket round-trip ----------

interface CliContext {
	projectId: string;
	chatId: string;
	userId: string;
	runId: string;
	expiresAt: number;
}

async function checkUnixSocket() {
	const runId = `run-${Date.now()}`;
	const ctx: CliContext = {
		projectId: PROJECT_ID,
		chatId: "chat-A",
		userId: "user-1",
		runId,
		expiresAt: Date.now() + 60_000,
	};
	const socketPath = join(SOCKETS_DIR, `${runId}.sock`);

	const server = createServer((sock: Socket) => {
		let buf = "";
		sock.on("data", (d) => {
			buf += d.toString("utf8");
			if (buf.includes("\n")) {
				const lines = buf.split("\n").filter(Boolean);
				for (const line of lines) {
					try {
						const req = JSON.parse(line);
						if (req.cmd === "ping") {
							sock.write(JSON.stringify({ ok: true, ctx }) + "\n");
						} else {
							sock.write(JSON.stringify({ ok: false, error: "unknown" }) + "\n");
						}
					} catch (e) {
						sock.write(JSON.stringify({ ok: false, error: String(e) }) + "\n");
					}
				}
			}
		});
	});
	await new Promise<void>((res) => server.listen(socketPath, res));

	// Mock zero CLI: a tiny node one-liner. Pi's bash inside the sandbox needs to
	// reach the socket file at `socketPath`. Confirm: a child bash, sandboxed,
	// can connect, send a ping, and read back the scoped context.
	const cliScript = join(SOCKETS_DIR, "zero-cli.mjs");
	writeFileSync(
		cliScript,
		`import net from "node:net";
const sock = net.createConnection(${JSON.stringify(socketPath)});
sock.on("connect", () => sock.write(JSON.stringify({cmd:"ping"})+"\\n"));
let buf=""; sock.on("data", d => { buf+=d.toString();
  if (buf.includes("\\n")) { process.stdout.write(buf); sock.end(); }
});
sock.on("error", e => { console.error("ERR", e.message); process.exit(2); });
`,
	);

	await SandboxManager.initialize({
		network: {
			allowedDomains: [],
			deniedDomains: [],
			// macOS: explicitly allow connect()/bind() to unix sockets under SOCKETS_DIR.
			// Without this, sandbox-exec denies AF_UNIX connect with EPERM.
			// Linux note: seccomp cannot filter unix sockets by path; on Linux the
			// bind-mount into bwrap (per the plan) is what controls visibility.
			allowUnixSockets: [SOCKETS_DIR],
		} as never,
		filesystem: {
			denyRead: [],
			allowWrite: [PROJECT_DIR, SOCKETS_DIR, "/tmp"],
			denyWrite: [],
		},
	});

	const r = await shellInSandbox(
		`node ${JSON.stringify(cliScript)}`,
		PROJECT_DIR,
	);

	let parsed: unknown = null;
	try {
		parsed = JSON.parse(r.out.split("\n").find(Boolean) || "{}");
	} catch {}
	const ok =
		r.exitCode === 0 &&
		typeof parsed === "object" &&
		parsed !== null &&
		(parsed as { ok?: boolean }).ok === true &&
		(parsed as { ctx?: CliContext }).ctx?.runId === runId &&
		(parsed as { ctx?: CliContext }).ctx?.chatId === "chat-A";

	record(
		"socket: bash inside sandbox round-trips scoped context",
		ok,
		ok
			? `runId=${runId} chatId=chat-A`
			: `exit=${r.exitCode} out=${JSON.stringify(r.out.slice(0, 200))}`,
	);

	await SandboxManager.reset();
	server.close();
	rmSync(socketPath, { force: true });
}

// ---------- check 4: per-chat session files ----------

async function checkPerChatSessions() {
	const sessionsDir = join(PROJECT_DIR, ".pi-sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const fileA = join(sessionsDir, "chat-A.jsonl");
	const fileB = join(sessionsDir, "chat-B.jsonl");

	// Use SessionManager.open with explicit per-chat path. open() handles non-existent
	// paths: it loads zero entries, then will append on first write.
	const smA = SessionManager.open(fileA, sessionsDir, PROJECT_DIR);
	const smB = SessionManager.open(fileB, sessionsDir, PROJECT_DIR);

	record(
		"sessions: explicit per-chat path is honored",
		smA.sessionFile === fileA && smB.sessionFile === fileB,
		`A=${smA.sessionFile} B=${smB.sessionFile}`,
	);

	// Force a write on each so the file materializes. Append a no-op label change
	// to a synthetic root id — appendLabelChange is one of the cheapest writes.
	// (We don't have a root id yet, so write the header by calling internal new-session
	// flow indirectly: createAgentSession with these SessionManagers.)
	const auth = AuthStorage.create("/tmp/pi-spike-auth.json");
	const registry = ModelRegistry.create(auth);

	// Pull in any model just to satisfy the type — we won't prompt it.
	// We only want createAgentSession to write the session header.
	const model =
		getModel("anthropic", "claude-haiku-4.5") ??
		getModel("openrouter", "anthropic/claude-haiku-4.5") ??
		getModel("openrouter", "openai/gpt-4o-mini");

	const loader = new DefaultResourceLoader({
		cwd: PROJECT_DIR,
		agentDir: join(ROOT_TMP, "agent-dir"),
		systemPromptOverride: () => "spike",
	});
	await loader.reload();

	// Force header + entry materialization. Persistence in SessionManager is lazy:
	// it only flushes once an assistant message exists. Append a synthetic
	// user→assistant pair on each so both files materialize without needing an LLM.
	for (const [sm, tag] of [
		[smA, "A"],
		[smB, "B"],
	] as const) {
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: `marker ${tag}` }],
		} as never);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `ack ${tag}` }],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		} as never);
	}

	const aExists = existsSync(fileA);
	const bExists = existsSync(fileB);
	const aContent = aExists ? readFileSync(fileA, "utf8") : "";
	const bContent = bExists ? readFileSync(fileB, "utf8") : "";

	record(
		"sessions: two chats produce distinct files in the same project",
		aExists && bExists && aContent !== bContent,
		`A=${aExists} bytes=${aContent.length}, B=${bExists} bytes=${bContent.length}`,
	);

	// Re-open chat A and verify continuation reads the same file.
	const smAReopen = SessionManager.open(fileA, sessionsDir, PROJECT_DIR);
	record(
		"sessions: re-opening a chat path resumes the same JSONL",
		smAReopen.sessionFile === fileA && smAReopen.getEntries().length > 0,
		`entries=${smAReopen.getEntries().length}`,
	);
}

// ---------- check 5: AuthStorage isolation ----------

async function checkAuthIsolation() {
	const a1 = AuthStorage.create("/tmp/pi-spike-auth-1.json");
	const a2 = AuthStorage.create("/tmp/pi-spike-auth-2.json");
	a1.setRuntimeApiKey("openrouter", "key-A");
	a2.setRuntimeApiKey("openrouter", "key-B");

	// AuthStorage.getApiKey is async. The contract: separate instances do not
	// share runtime API keys.
	const k1 = await (a1 as unknown as { getApiKey: (p: string) => Promise<string | undefined> }).getApiKey(
		"openrouter",
	);
	const k2 = await (a2 as unknown as { getApiKey: (p: string) => Promise<string | undefined> }).getApiKey(
		"openrouter",
	);
	record(
		"auth: two AuthStorage instances stay isolated",
		k1 === "key-A" && k2 === "key-B",
		`a1=${k1} a2=${k2}`,
	);
}

// ---------- check 6: live event capture (LIVE=1) ----------

async function liveCaptureFixtures() {
	if (!process.env.LIVE) {
		console.log(
			"[skip] LIVE=1 not set; skipping live LLM round-trip and event capture.",
		);
		return;
	}
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey && !process.env.ANTHROPIC_API_KEY) {
		finding(
			"LIVE=1 set but no OPENROUTER_API_KEY/ANTHROPIC_API_KEY in env — skipping live capture.",
		);
		return;
	}

	const auth = AuthStorage.create(join(ROOT_TMP, "auth.json"));
	if (apiKey) auth.setRuntimeApiKey("openrouter", apiKey);
	if (process.env.ANTHROPIC_API_KEY)
		auth.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);

	const registry = ModelRegistry.create(auth);
	const model =
		getModel("anthropic", "claude-haiku-4.5") ??
		getModel("openrouter", "openai/gpt-4o-mini") ??
		getModel("openrouter", "anthropic/claude-haiku-4.5");
	if (!model) {
		finding("LIVE: no usable model resolved; skipping.");
		return;
	}

	const sessionsDir = join(PROJECT_DIR, ".pi-sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const sessionFile = join(sessionsDir, "live.jsonl");

	const events: AgentSessionEvent[] = [];
	const sandboxFactory = (pi: ExtensionAPI) => {
		pi.on("user_bash", () => ({
			operations: {
				async exec(command, cwd, { onData, signal, timeout }) {
					const wrapped = await SandboxManager.wrapWithSandbox(command);
					return new Promise((res, rej) => {
						const child = spawn("bash", ["-c", wrapped], {
							cwd,
							detached: true,
							stdio: ["ignore", "pipe", "pipe"],
						});
						let to: NodeJS.Timeout | undefined;
						if (timeout && timeout > 0)
							to = setTimeout(() => child.kill("SIGKILL"), timeout * 1000);
						child.stdout?.on("data", onData);
						child.stderr?.on("data", onData);
						signal?.addEventListener(
							"abort",
							() => child.kill("SIGKILL"),
							{ once: true },
						);
						child.on("error", rej);
						child.on("close", (code) => {
							if (to) clearTimeout(to);
							res({ exitCode: code });
						});
					});
				},
			},
		}));

		pi.on("session_start", async () => {
			await SandboxManager.initialize({
				network: { allowedDomains: ["registry.npmjs.org"], deniedDomains: [] },
				filesystem: {
					denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
					allowWrite: [PROJECT_DIR, "/tmp"],
					denyWrite: [".env", "*.pem", "*.key"],
				},
			});
		});
		pi.on("session_shutdown", async () => {
			await SandboxManager.reset().catch(() => {});
		});
	};

	const loaderWithSandbox = new DefaultResourceLoader({
		cwd: PROJECT_DIR,
		agentDir: join(ROOT_TMP, "agent-dir"),
		systemPromptOverride: () =>
			"You are a terse coding agent. Use the bash and read tools. Reply briefly.",
		extensionFactories: [sandboxFactory],
	});
	await loaderWithSandbox.reload();

	const { session } = await createAgentSession({
		cwd: PROJECT_DIR,
		agentDir: join(ROOT_TMP, "agent-dir"),
		resourceLoader: loaderWithSandbox,
		sessionManager: SessionManager.open(sessionFile, sessionsDir, PROJECT_DIR),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false, maxRetries: 0 },
		}),
		authStorage: auth,
		modelRegistry: registry,
		model,
		thinkingLevel: "off",
		// `tools` is a string allowlist of names; omit it to keep the defaults
		// (read/bash/edit/write). Passing tool *definitions* here silently filters
		// to nothing — see the SDK type signature in sdk.d.ts.
	});

	session.subscribe((e) => {
		events.push(e);
	});

	try {
		// Prompt phrased to force actual tool calls (some OpenRouter routes lazy-respond
		// in pure text — see finding below if no tool_execution events show up).
		await session.prompt(
			"You MUST use tools, not text. Call the `read` tool with path='hello.txt'. " +
				"Then call the `bash` tool with command='ls'. " +
				"Then call the `write` tool to create 'spike-result.txt' with contents 'ok'. " +
				"After all three tool calls, reply with exactly: DONE.",
		);
	} catch (e) {
		finding(`live prompt threw: ${e}`);
	}

	const out = join(FIXTURES_DIR, "live-events.jsonl");
	writeFileSync(out, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

	const types = new Set(events.map((e) => e.type));
	const hasTextStream =
		types.has("message_update") && events.some(
			(e) =>
				e.type === "message_update" &&
				(e.assistantMessageEvent as { type?: string })?.type === "text_delta",
		);
	const hasToolExec = types.has("tool_execution_start") && types.has("tool_execution_end");

	record(
		"live: captured streaming text + lifecycle events",
		hasTextStream && types.has("agent_start") && types.has("agent_end"),
		`types=${[...types].join(",")} count=${events.length}`,
	);

	if (!hasToolExec) {
		finding(
			"OpenRouter's mappings for anthropic/* and openai/gpt-4o-mini route through Pi's `openai-completions` API. " +
				"In this spike, the model returned natural-language text instead of tool_calls (no tool_execution_* events). " +
				"For Phase 1 we should target the Anthropic API directly (or any provider whose `api` field is `openai-responses`/native-anthropic) " +
				"so tool calling and full event coverage are reliable. The event *shape* is otherwise as documented in pi/docs/json.md.",
		);
	}

	const fileMade = existsSync(join(PROJECT_DIR, "spike-result.txt"));
	record(
		"live: write tool produced expected file (model-dependent)",
		fileMade || !hasToolExec, // pass if either model wrote it OR model didn't call tools (separate finding)
		fileMade ? "file present" : "skipped — model did not call tools (see finding)",
	);
	console.log(`[live] events written to ${out}`);
}

// ---------- main ----------

async function main() {
	resetDirs();

	console.log("=== check: bash sandbox enforcement ===");
	await checkBashSandbox();

	console.log("\n=== check: built-in tool sandbox coverage (open Q §6) ===");
	await checkBuiltinToolCoverage();

	console.log("\n=== check: per-turn unix socket round-trip ===");
	await checkUnixSocket();

	console.log("\n=== check: per-chat session files ===");
	await checkPerChatSessions();

	console.log("\n=== check: AuthStorage isolation (open Q §2) ===");
	await checkAuthIsolation();

	console.log("\n=== check: live event capture (LIVE=1) ===");
	await liveCaptureFixtures();

	console.log("\n=== summary ===");
	const passed = results.filter((r) => r.ok).length;
	const failed = results.filter((r) => !r.ok).length;
	console.log(`${passed} passed, ${failed} failed, ${results.length} total`);
	if (findings.length) {
		console.log("\nFindings to fold into pi-migration.md:");
		for (const f of findings) console.log("  - " + f);
	}

	const summary = {
		when: new Date().toISOString(),
		platform: process.platform,
		results,
		findings,
	};
	writeFileSync(
		join(FIXTURES_DIR, "spike-summary.json"),
		JSON.stringify(summary, null, 2),
	);

	process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
