/**
 * Agent discovery and configuration.
 *
 * Sources, in lowest-to-highest precedence:
 *   1. Bundled default-agents (always included) — shipped alongside this
 *      extension under ./default-agents/*.md. Replaces the old behavior of
 *      symlinking these into <project>/.pi/agents from `ensurePiConfig`.
 *   2. User agents (~/.pi/agent/agents) — opt-in via scope.
 *   3. Project agents (<project>/.pi/agents) — opt-in via scope; intended
 *      for repo-controlled overrides.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "bundled" | "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	bundledAgentsDir: string;
}

function bundledAgentsDir(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "default-agents");
}

function realpathOrNull(p: string): string | null {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}

function loadAgentsFromDir(dir: string, source: "bundled" | "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const bundledDir = bundledAgentsDir();

	const bundledAgents = loadAgentsFromDir(bundledDir, "bundled");
	// `.pi/agents/` is materialized with symlinks to the bundled defaults for
	// inspection. Drop project entries whose realpath matches a bundled one
	// so they don't shadow the canonical "bundled" source label with "project".
	const bundledRealpaths = new Set(
		bundledAgents.map((a) => realpathOrNull(a.filePath) ?? a.filePath),
	);
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const rawProjectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const projectAgents = rawProjectAgents.filter(
		(a) => !bundledRealpaths.has(realpathOrNull(a.filePath) ?? a.filePath),
	);

	// Bundled defaults form the baseline. User/project overrides win by name
	// — letting a repo or the local user replace a bundled agent's prompt
	// without losing the others.
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of bundledAgents) agentMap.set(agent.name, agent);
	if (scope !== "project") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	}
	if (scope !== "user") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir, bundledAgentsDir: bundledDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
