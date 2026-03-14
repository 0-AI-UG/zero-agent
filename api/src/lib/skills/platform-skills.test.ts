import { test, expect, describe } from "bun:test";
import { parseSkillMd } from "./parser.ts";
import { resolve } from "path";

const SKILLS_DIR = resolve(import.meta.dir, "../../../../skills");

const PLATFORMS = ["google-maps", "linkedin", "x", "instagram", "rednote"] as const;

const REQUIRED_SECTIONS = [
  "## When to use",
  "## Prerequisites",
  "## Common Patterns",
  "## Operations",
  "## Tips",
  "## Error Recovery",
];

describe("platform skills", () => {
  for (const platform of PLATFORMS) {
    describe(platform, () => {
      let content: string;
      let parsed: ReturnType<typeof parseSkillMd>;

      test("reads and parses without error", async () => {
        const file = Bun.file(resolve(SKILLS_DIR, platform, "SKILL.md"));
        content = await file.text();
        parsed = parseSkillMd(content);
      });

      test("name matches directory name", () => {
        expect(parsed.frontmatter.name).toBe(platform);
      });

      test("has a description", () => {
        expect(parsed.frontmatter.description.length).toBeGreaterThan(0);
      });

      test("metadata.platform is set", () => {
        expect(parsed.frontmatter.metadata.platform).toBeTruthy();
      });

      test("capabilities is non-empty", () => {
        expect(parsed.frontmatter.metadata.capabilities.length).toBeGreaterThan(0);
      });

      test("body contains required sections", () => {
        for (const section of REQUIRED_SECTIONS) {
          expect(parsed.body).toContain(section);
        }
      });
    });
  }
});
