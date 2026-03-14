---
name: linkedin
description: Find and engage B2B leads on LinkedIn — prospect by role/company, enrich profiles, send connection requests and DMs
metadata:
  version: "2.0.0"
  platform: linkedin
  login_required: true
  requires:
    env: []
    bins: []
  capabilities:
    - prospect
    - enrich
    - outreach
    - reply-check
    - content-create
  tags:
    - social
    - b2b
    - outreach
    - lead-generation
---

# LinkedIn — Sales Workflows

Best for B2B prospecting. Rich professional data (title, company, tenure) makes it ideal for identifying decision-makers and scoring leads against ICP.

## Login & Gotchas

After navigating to any LinkedIn page, snapshot. If you see "Sign in" or a login form, stop and ask the user to log in via the companion browser. Dismiss "Try Premium", "Turn on notifications" popups via X or "Not now". Cookie banner: click "Accept". Rate limit: ~100 profile views/day, ~100 connection requests/week — if you see "commercial use limit", stop and inform the user.

## 1. Prospecting

**Goal:** Find leads matching the ICP from product.md and save them.

Search URL: `https://www.linkedin.com/search/results/people/?keywords={query}` (URL-encode query). Build queries from product.md target audience — combine role + industry + location (e.g., `CTO fintech New York`). Use filter buttons near the top ("Connections", "Locations", "Current company", "Industry") to narrow results.

For each promising result, click through to the profile and extract:
- Name, headline, current company/title
- Location, connection degree
- Profile URL (`/in/{username}/`)

**Scoring guidance:**
- 80-100: Title matches ICP decision-maker role + company in target industry + 2nd-degree connection
- 60-79: Right role but company/industry is adjacent, or 3rd-degree
- 40-59: Related role, unclear fit
- Below 40: Poor match

**Save each lead:**
```
saveLead({
  name: "Full Name",
  platform: "linkedin",
  platformHandle: "/in/username",
  profileUrl: "https://www.linkedin.com/in/username/",
  source: "linkedin-search:{query}",
  interest: "{inferred from headline/role}",
  priority: "medium",  // high if C-suite or mentions buying signals
  score: 75,
  tags: "decision-maker,fintech",
  notes: "VP Engineering at Acme Corp. 2nd-degree via John. Headline mentions scaling challenges."
})
```

## 2. Enrichment

**Goal:** Visit a lead's profileUrl and fill in missing data.

Navigate to the profile URL. Snapshot and extract:
- **Experience section**: Current role, tenure, company size signals (team mentions)
- **About section**: Pain points, priorities, technology mentions
- **Skills section**: Tech stack, domain expertise
- **Activity**: Recent posts/comments that reveal interests or challenges

**Update the lead:**
```
updateLead({
  id: "{leadId}",
  score: 82,
  tags: "decision-maker,series-b,scaling",
  interest: "infrastructure automation — mentioned scaling pain in About",
  notes: "5yr at Acme, promoted from Senior to VP. Active poster about DevOps challenges. Company raised Series B per recent activity."
})
```

If you find an email (rare on LinkedIn — check contact info section if 1st-degree), set the `email` field.

## 3. Outreach

**Connection requests** (non-connections): Click "Connect" (may be under "More" dropdown). Add a note (max 300 characters) — reference something specific from their profile. This is `channel: "manual"` since you can't track delivery.

**Direct messages** (1st-degree only): Click "Message", type in the messaging panel, send. Use `sendDirectMessage({ leadId, channel: "direct_message", content: "..." })`.

**What works on LinkedIn:**
- Lead with a specific observation about their company/role
- Reference mutual connections or shared content
- Offer value (insight, resource) before asking for anything
- Keep connection notes under 200 chars — they truncate on mobile
- Messages can be longer but 3-4 sentences perform best

**Comment engagement** (alternative): Comment thoughtfully on their posts first to build familiarity before connecting. Use `channel: "comment"`.

## 4. Reply Checking

Navigate to `https://www.linkedin.com/messaging/`. Snapshot. Look for unread message indicators (bold names, notification badges). For each new reply from a known lead:

```
recordOutreachReply({
  messageId: "{originalMessageId}",
  replyBody: "{their reply text}"
})
```

The lead status auto-updates to "replied". Also check notification bell for connection acceptances — a connection accept from a lead you messaged is a positive signal worth noting via `appendLeadNote`.

## 5. Content Creation

Navigate to `https://www.linkedin.com/feed/`, click "Start a post". LinkedIn text posts (up to 3,000 chars) perform well for thought leadership and inbound lead generation.

**What works:**
- Problem → insight → takeaway structure
- Industry-specific observations
- "Unpopular opinion" or contrarian takes drive engagement
- Tag relevant people/companies to extend reach
- Post during business hours (Tue-Thu mornings)

To add an image, click the photo icon in the composer. Click "Post" to publish.

## Navigation Reference

| Action | URL/Pattern |
|--------|-------------|
| Search people | `linkedin.com/search/results/people/?keywords={query}` |
| View profile | `linkedin.com/in/{username}/` |
| Messaging | `linkedin.com/messaging/` |
| Feed/compose | `linkedin.com/feed/` |
| Connection is hidden | Check "More" dropdown → "Connect" |
| "Commercial use limit" | Daily cap reached — stop browsing |
| Profile 404 | Profile may be private or username wrong |
