import type { SkillSummary } from "./types.ts";

export function buildSkillsIndex(skills: SkillSummary[]): string {
  if (skills.length === 0) return "";

  const rows = skills.map(
    (s) => `| ${s.name} | ${s.metadata.platform || "-"} | ${s.description} |`,
  );

  return `**Installed skills:**

| Skill | Platform | Description |
|-------|----------|-------------|
${rows.join("\n")}`;
}
