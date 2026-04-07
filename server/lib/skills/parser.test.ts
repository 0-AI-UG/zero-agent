import { test, expect, describe } from "vitest";
import { parseSkillMd } from "./parser.ts";

describe("parseSkillMd", () => {
  test("parses valid SKILL.md with full metadata", () => {
    const content = `---
name: web-research
description: Guide for web research and data extraction
metadata:
  version: "1.0.0"
  platform: web
  login_required: true
  requires:
    env:
      - API_KEY
    bins:
      - chromium
  capabilities:
    - search
    - extract
  tags:
    - research
    - data
---

# Web Research

Use the browser tool to navigate to websites...`;

    const { frontmatter, body } = parseSkillMd(content);

    expect(frontmatter.name).toBe("web-research");
    expect(frontmatter.description).toBe("Guide for web research and data extraction");
    expect(frontmatter.metadata.version).toBe("1.0.0");
    expect(frontmatter.metadata.platform).toBe("web");
    expect(frontmatter.metadata.login_required).toBe(true);
    expect(frontmatter.metadata.requires.env).toEqual(["API_KEY"]);
    expect(frontmatter.metadata.requires.bins).toEqual(["chromium"]);
    expect(frontmatter.metadata.capabilities).toEqual(["search", "extract"]);
    expect(frontmatter.metadata.tags).toEqual(["research", "data"]);
    expect(body).toContain("# Web Research");
    expect(body).toContain("Use the browser tool");
  });

  test("parses minimal SKILL.md with defaults", () => {
    const content = `---
name: basic-skill
description: A simple skill
---

Do the thing.`;

    const { frontmatter, body } = parseSkillMd(content);

    expect(frontmatter.name).toBe("basic-skill");
    expect(frontmatter.description).toBe("A simple skill");
    expect(frontmatter.metadata.version).toBe("0.0.0");
    expect(frontmatter.metadata.platform).toBe("");
    expect(frontmatter.metadata.login_required).toBe(false);
    expect(frontmatter.metadata.requires.env).toEqual([]);
    expect(frontmatter.metadata.requires.bins).toEqual([]);
    expect(frontmatter.metadata.capabilities).toEqual([]);
    expect(frontmatter.metadata.tags).toEqual([]);
    expect(body).toBe("Do the thing.");
  });

  test("throws on missing frontmatter", () => {
    expect(() => parseSkillMd("# Just markdown")).toThrow("missing YAML frontmatter");
  });

  test("throws on missing name", () => {
    const content = `---
description: No name here
---

Body.`;
    expect(() => parseSkillMd(content)).toThrow("missing required field 'name'");
  });

  test("throws on missing description", () => {
    const content = `---
name: no-desc
---

Body.`;
    expect(() => parseSkillMd(content)).toThrow("missing required field 'description'");
  });
});
