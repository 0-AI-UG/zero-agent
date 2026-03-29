import { parse as parseYaml } from "yaml";
import type { SkillFrontmatter, SkillMetadata } from "./types.ts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillMd(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error("Invalid SKILL.md: missing YAML frontmatter delimiters (---)");
  }

  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(match[1]!) as Record<string, unknown>;
  } catch {
    // Some SKILL.md files use YAML-incompatible syntax like [placeholder] in values.
    // Fall back to parsing only the name and description lines.
    const lines = match[1]!.split("\n");
    const name = lines.find((l) => l.startsWith("name:"))?.replace("name:", "").trim();
    const desc = lines.find((l) => l.startsWith("description:"))?.replace("description:", "").trim();
    if (!name) throw new Error("Invalid SKILL.md: YAML parse failed and no 'name' field found");
    raw = { name, description: desc ?? "" };
  }
  const body = match[2]!.trim();

  if (!raw.name || typeof raw.name !== "string") {
    throw new Error("Invalid SKILL.md: missing required field 'name'");
  }
  if (!raw.description || typeof raw.description !== "string") {
    throw new Error("Invalid SKILL.md: missing required field 'description'");
  }

  const rawMeta = (raw.metadata ?? {}) as Record<string, unknown>;
  const rawRequires = (rawMeta.requires ?? {}) as Record<string, unknown>;

  const metadata: SkillMetadata = {
    version: typeof rawMeta.version === "string" ? rawMeta.version : "0.0.0",
    requires: {
      env: Array.isArray(rawRequires.env) ? rawRequires.env.map(String) : [],
      bins: Array.isArray(rawRequires.bins) ? rawRequires.bins.map(String) : [],
    },
    capabilities: Array.isArray(rawMeta.capabilities) ? rawMeta.capabilities.map(String) : [],
    platform: typeof rawMeta.platform === "string" ? rawMeta.platform : "",
    login_required: typeof rawMeta.login_required === "boolean" ? rawMeta.login_required : false,
    tags: Array.isArray(rawMeta.tags) ? rawMeta.tags.map(String) : [],
  };

  return {
    frontmatter: {
      name: raw.name,
      description: raw.description,
      metadata,
    },
    body,
  };
}
