/**
 * Probe: does Pi actually send `tools` to OpenRouter, and does the model emit tool_calls?
 *
 * Wraps global fetch, dumps request bodies + response chunks for the OpenRouter call,
 * and asserts whether the assistant message used tool_calls or fell back to plain text.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentSessionEvent,
	AuthStorage,
	createAgentSession,
	createBashTool,
	createReadTool,
	createWriteTool,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(SPIKE_DIR, "fixtures");
const PROJECT_DIR = join(tmpdir(), "pi-spike-probe", "project");
mkdirSync(PROJECT_DIR, { recursive: true });
mkdirSync(FIXTURES_DIR, { recursive: true });
writeFileSync(join(PROJECT_DIR, "hello.txt"), "hello\n");

// ---- intercept fetch ----
const origFetch = globalThis.fetch;
const captured: Array<{ url: string; body?: unknown; status?: number; sample?: string }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	let parsed: unknown;
	if (init?.body && typeof init.body === "string") {
		try {
			parsed = JSON.parse(init.body);
		} catch {
			parsed = init.body;
		}
	}
	const entry: (typeof captured)[number] = { url, body: parsed };
	captured.push(entry);
	const res = await origFetch(input as RequestInfo, init);
	entry.status = res.status;
	// Tee the stream so we can see chunks but still pass them through.
	if (res.body) {
		const [a, b] = res.body.tee();
		const sampler = new Response(b).text();
		sampler.then((t) => {
			entry.sample = t.slice(0, 4000);
		});
		return new Response(a, { status: res.status, headers: res.headers });
	}
	return res;
}) as typeof fetch;

// ---- run a single turn ----
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
	console.error("OPENROUTER_API_KEY required");
	process.exit(1);
}

const auth = AuthStorage.create(join(tmpdir(), "pi-spike-probe-auth.json"));
auth.setRuntimeApiKey("openrouter", apiKey);
const registry = ModelRegistry.create(auth);

// Try a sequence of OpenRouter models to see which (if any) emit tool_calls.
const candidates = [
	["openrouter", "openai/gpt-4o-mini"],
	["openrouter", "anthropic/claude-haiku-4.5"],
	["openrouter", "openai/gpt-4o"],
	["openrouter", "qwen/qwen3-30b-a3b-instruct-2507"],
] as const;

const reportLines: string[] = [];

for (const [provider, id] of candidates) {
	captured.length = 0;
	const model = getModel(provider, id);
	if (!model) {
		reportLines.push(`SKIP ${provider}/${id} — not in registry`);
		continue;
	}
	const loader = new DefaultResourceLoader({
		cwd: PROJECT_DIR,
		agentDir: join(tmpdir(), "pi-spike-probe", "agent"),
		systemPromptOverride: () =>
			"You MUST call the provided tools. Do not write code or describe steps in text.",
	});
	await loader.reload();

	const events: AgentSessionEvent[] = [];
	const { session } = await createAgentSession({
		cwd: PROJECT_DIR,
		agentDir: join(tmpdir(), "pi-spike-probe", "agent"),
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(PROJECT_DIR),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false, maxRetries: 0 },
		}),
		authStorage: auth,
		modelRegistry: registry,
		model,
		thinkingLevel: "off",
		tools: [
			createReadTool(PROJECT_DIR),
			createBashTool(PROJECT_DIR),
			createWriteTool(PROJECT_DIR),
		],
	});
	session.subscribe((e) => events.push(e));

	let err: string | undefined;
	try {
		await session.prompt(
			"Call the read tool with path='hello.txt'. Then call the bash tool with command='ls'. Reply DONE after both tool results return.",
		);
	} catch (e) {
		err = String(e);
	}

	// Find the upstream call and see whether it had tools and whether response had tool_calls.
	const upstream = captured.find((c) => /openrouter\.ai|openai\.com|anthropic\.com/.test(c.url));
	const requestTools = (upstream?.body as { tools?: unknown[] } | undefined)?.tools;
	const sample = upstream?.sample ?? "";
	const sawToolCallsInStream =
		/"tool_calls"\s*:\s*\[/.test(sample) || /"function"\s*:\s*\{\s*"name"/.test(sample);
	const hadToolExec = events.some((e) => e.type === "tool_execution_start");

	reportLines.push(
		`${provider}/${id}: status=${upstream?.status ?? "?"} requestTools=${
			Array.isArray(requestTools) ? requestTools.length : "missing"
		} streamHadToolCalls=${sawToolCallsInStream} agentToolExec=${hadToolExec}${
			err ? ` err=${err.slice(0, 80)}` : ""
		}`,
	);

	// Save the first request/response sample for the first candidate to inspect.
	if (provider === "openrouter" && id === "openai/gpt-4o-mini") {
		writeFileSync(
			join(FIXTURES_DIR, "openrouter-request.json"),
			JSON.stringify(upstream?.body ?? null, null, 2),
		);
		writeFileSync(join(FIXTURES_DIR, "openrouter-response-sample.txt"), sample);
	}

	session.dispose();
}

console.log("\n=== probe results ===");
for (const l of reportLines) console.log(l);
