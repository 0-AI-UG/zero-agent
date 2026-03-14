import { test, expect, describe } from "bun:test";
import { parseSkillMd } from "./parser.ts";

describe("parseSkillMd", () => {
  test("parses valid SKILL.md with full metadata", () => {
    const content = `---
name: linkedin-outreach
description: Guide for LinkedIn prospecting and outreach
metadata:
  version: "1.0.0"
  platform: linkedin
  login_required: true
  requires:
    env:
      - LINKEDIN_COOKIE
    bins:
      - chromium
  capabilities:
    - search
    - message
  tags:
    - social
    - b2b
---

# LinkedIn Outreach

Use the browser tool to navigate to LinkedIn...`;

    const { frontmatter, body } = parseSkillMd(content);

    expect(frontmatter.name).toBe("linkedin-outreach");
    expect(frontmatter.description).toBe("Guide for LinkedIn prospecting and outreach");
    expect(frontmatter.metadata.version).toBe("1.0.0");
    expect(frontmatter.metadata.platform).toBe("linkedin");
    expect(frontmatter.metadata.login_required).toBe(true);
    expect(frontmatter.metadata.requires.env).toEqual(["LINKEDIN_COOKIE"]);
    expect(frontmatter.metadata.requires.bins).toEqual(["chromium"]);
    expect(frontmatter.metadata.capabilities).toEqual(["search", "message"]);
    expect(frontmatter.metadata.tags).toEqual(["social", "b2b"]);
    expect(body).toContain("# LinkedIn Outreach");
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
