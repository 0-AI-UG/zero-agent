---
name: skill-creator
description: Create new skills for any platform or workflow. Load this when the user asks you to build, create, or author a new skill — guides you through research, interview, drafting, and installation.
metadata:
  version: "2.0.0"
  platform: meta
  login_required: false
  requires:
    env: []
    bins: []
  capabilities:
    - create
    - research
  tags:
    - meta
    - tooling
---

# Skill Creator

Build high-quality skills for any platform or workflow. Follow these phases in order — do not skip the interview or research steps, because skills written without understanding the platform's real behavior will produce broken workflows.

## Phase 1: Interview

Before researching or writing anything, ask the user these questions (adapt to context — skip what's already obvious):

1. **Platform/workflow**: What platform or workflow is this skill for?
2. **Goal**: What should the agent accomplish with this skill? (e.g., "find leads on TikTok", "manage outreach on Facebook Marketplace")
3. **Capabilities needed**: Which workflows matter? (prospect, enrich, outreach, reply-check, content-create, scrape, analyze)
4. **Auth**: Does the platform require login? API keys? Cookies?
5. **Edge cases**: Any known rate limits, anti-bot measures, or gotchas?
6. **Success criteria**: How will the user know the skill is working well?

Humans describe what they *do*, not what they *need*. Extract implicit requirements — if they say "find leads on TikTok", they also need scoring criteria, URL patterns, and save/update tool calls, even if they didn't mention those.

Summarize your understanding back to the user before proceeding. Get confirmation.

## Phase 2: Research

Use `searchWeb` and `fetchUrl` to study the target platform. Verify every assumption — don't guess URL patterns or UI flows.

### What to research
- **URL patterns**: Search URLs, profile URLs, messaging URLs, feed URLs. Navigate to the actual pages and confirm the patterns.
- **Login detection**: What does the page look like when logged out? Exact text ("Sign in", "Log in", "Create account") or selectors to check.
- **Rate limits**: Platform-specific limits and what happens when you hit them (error messages, captchas, soft blocks).
- **Anti-bot measures**: Captchas, behavioral detection, IP blocking, session expiry.
- **Navigation structure**: How to get from search results to profiles, from profiles to messaging, etc.
- **API alternatives**: Does the platform have a public API that might be more reliable than browser automation?

### What NOT to do
- Don't invent URL patterns from memory — fetch the actual pages and verify.
- Don't assume selectors or button text — snapshot the page and read what's there.
- Don't skip gotchas research — a skill that ignores rate limits will get the user's account flagged.

Summarize your research findings to the user before writing.

## Phase 3: Draft the SKILL.md

### Frontmatter

The `description` field is the primary trigger for when the agent loads this skill. Put all "when to use this" information in the description — the agent decides based on name + description alone.

```yaml
---
name: platform-name                    # lowercase, hyphenated
description: >-
  Verb-first summary of what this skill does and when to trigger it.
  Example: "Find and engage B2B leads on LinkedIn — prospect by
  role/company, enrich profiles, send connection requests and DMs"
metadata:
  version: "1.0.0"
  platform: platform-name              # used for UI grouping/color
  login_required: true                 # does the platform require auth?
  requires:
    env: []                            # env var names (API keys, tokens)
    bins: []                           # CLI tools (e.g., playwright)
  capabilities:                        # pick from this list
    - prospect       # find new leads
    - enrich         # fill in lead details from profiles
    - outreach       # send messages/connection requests
    - reply-check    # check for and process responses
    - content-create # create posts/comments
    - scrape         # extract data from pages
    - engage         # interact with content (like, comment)
    - analyze        # analyze data/metrics
    - search         # search for information
    - message        # send messages
    - connect        # send connection/follow requests
  tags:              # freeform, for discovery
    - social
    - b2b
---
```

### Body Structure

Write in imperative language ("Navigate to...", "Extract...") not second person ("You should navigate..."). Explain the *why* behind instructions — modern LLMs respond better to understanding intent than rigid rules.

#### Required sections

**1. Title & Overview** — One heading + 1-2 sentences explaining what this platform is best for and when to use this skill over others.

```markdown
# Platform — Sales Workflows

Best for {what}. {Why this platform is valuable for lead gen / sales}.
```

**2. Login & Gotchas** — Specific, actionable detection instructions. Not "check if logged in" but exactly what to look for.

```markdown
## Login & Gotchas

After navigating to any {platform} page, snapshot. If you see "{exact text}"
or a login form, stop and ask the user to log in via the companion browser.
Dismiss "{popup text}" popups via {how}. Cookie banner: click "{button text}".
Rate limit: ~{N} {actions}/day — if you see "{error text}", stop and inform the user.
```

**3. Numbered Workflows** — Each capability gets its own section. Every workflow needs:

- **Goal** paragraph (what and why)
- **Step-by-step instructions** with real, verified URLs
- **Tool call examples** showing exact parameter formats
- **Scoring guidance** that references the project's ICP/product.md

Here's the pattern from the LinkedIn skill (our best-performing skill):

```markdown
## 1. Prospecting

**Goal:** Find leads matching the ICP from product.md and save them.

Search URL: `https://platform.com/search?q={query}` (URL-encode query).
Build queries from product.md target audience — combine {relevant filters}.

For each promising result, click through to the profile and extract:
- Name, headline/bio
- Location, follower count / engagement metrics
- Profile URL

**Scoring guidance:**
- 80-100: {Exact match criteria for this platform}
- 60-79: {Close match criteria}
- 40-59: {Partial match criteria}
- Below 40: Poor match

**Save each lead:**
saveLead({
  name: "Full Name",
  platform: "platform-name",
  platformHandle: "username",
  profileUrl: "https://platform.com/username",
  source: "platform-search:{query}",
  interest: "{inferred from profile}",
  priority: "medium",
  score: 75,
  tags: "relevant,tags",
  notes: "Key details about why this lead matches ICP."
})
```

**4. Navigation Reference** (optional but recommended) — Quick-reference table of URLs and patterns.

```markdown
## Navigation Reference

| Action | URL/Pattern |
|--------|-------------|
| Search | `platform.com/search?q={query}` |
| Profile | `platform.com/{username}` |
| Messages | `platform.com/messages/` |
```

### Writing Principles

These principles come from analyzing what makes our best skills effective:

- **Be specific, not vague**: "Click the 'Connect' button (may be under the 'More' dropdown)" is better than "send a connection request".
- **Include exact URLs**: Real URL patterns verified by research, not guesses. Use `{placeholder}` syntax for dynamic parts.
- **Show tool calls**: Include exact `saveLead()`, `updateLead()`, `sendDirectMessage()`, `recordOutreachReply()` calls with all parameters. The agent needs to see the shape of the data.
- **Explain rate limits concretely**: "~100 profile views/day" not "be careful about rate limits".
- **Reference product.md for scoring**: The scoring criteria should always tie back to the project's ICP, not generic quality signals.
- **Keep it under 500 lines**: Skills that are too long waste context window. If a workflow is complex, split into separate skills.

## Phase 4: Review & Refine

Before installing, run through this checklist:

### Structure
- [ ] Frontmatter has all required fields (name, description, metadata with version/platform/requires/capabilities/tags)
- [ ] Description is verb-first and explains when to trigger
- [ ] Body starts with `# Platform — Sales Workflows` heading
- [ ] Login & Gotchas section has specific detection text, not vague instructions
- [ ] Each workflow has Goal, steps, tool calls, and scoring

### Accuracy
- [ ] All URLs are real platform URLs verified during research (not invented)
- [ ] Login detection text matches what the platform actually shows
- [ ] Rate limit numbers are realistic for the platform
- [ ] Tool call parameter names match our API (`saveLead`, `updateLead`, `sendDirectMessage`, `recordOutreachReply`)

### Security
- [ ] No hardcoded credentials, tokens, or API keys in the skill content
- [ ] No instructions that could trigger platform bans (mass-following, spam messaging)
- [ ] Rate limit warnings are present for all automated actions

### Quality
- [ ] Instructions are actionable — someone could follow them step by step
- [ ] Scoring guidance references ICP/product.md, not generic signals
- [ ] Edge cases are covered (profile not found, rate limit hit, logged out mid-session)
- [ ] Skill is under 500 lines

If any checks fail, fix them before proceeding. Show the user the final content and ask for approval.

## Phase 5: Install

Once the user approves, write the skill file:

```
writeFile({
  path: "skills/{name}/SKILL.md",
  content: "<full SKILL.md content including frontmatter>"
})
```

That's it — skills are file-native. Once `SKILL.md` exists under `skills/{name}/`, the skill is immediately active and will appear in the skills index within seconds.

After installation, suggest the user test it: "Try asking me to prospect on {platform} to verify the skill works correctly."
