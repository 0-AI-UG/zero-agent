---
name: lead-generation
description: Lead qualification, scoring, discovery strategies, outreach playbook, and escalation rules — load before any lead-related work
metadata:
  version: "1.0.0"
  platform: ""
  login_required: false
  requires:
    env: []
    bins: []
  capabilities:
    - qualify
    - score
    - discover
    - outreach
    - enrich
  tags:
    - leads
    - qualification
    - scoring
    - outreach
    - strategy
---

# Lead Generation — Playbook

Load this skill before doing any lead-related work: finding, qualifying, scoring, enriching, or reaching out to leads. This skill works together with the project's `project.md` (ICP, disqualification, outreach strategy) and `product.md` (product details, audience, positioning).

**Before you start:** Read `project.md` and `product.md`. If the ICP section in `project.md` is still placeholder text, ask the user to fill it in first — you cannot qualify leads without knowing who the ideal customer is.

---

## 1. Qualification — Matching Against the ICP

Every lead must be evaluated against the **Ideal Customer Profile (ICP)** defined in `project.md`. Check these dimensions:

| ICP Dimension | Where to Find It | What to Check on the Lead |
|---------------|-------------------|---------------------------|
| Role / Title | project.md → ICP | Does their title/bio match? |
| Industry | project.md → ICP | Is their company/niche in the target industry? |
| Company size | project.md → ICP | Solo creator vs. team vs. enterprise? |
| Pain points | project.md → ICP | Do they mention problems the product solves? |
| Buying signals | project.md → ICP | Are they showing intent? (see below) |
| Platform | project.md → ICP | Are they on a platform where outreach works? |

**Buying signals to watch for:**
- Asking "how do I solve X?" where X is the problem your product addresses
- Posting about switching tools or being frustrated with a competitor
- Asking about pricing, features, or comparisons
- Engaging with your content (likes, comments, shares)
- Following competitor accounts
- Job postings that signal the need (e.g., hiring for the role your product replaces)

## 2. Scoring Rubric

Score every lead 0-100 based on ICP fit. This score drives priority and outreach order.

| Score | Label | Criteria | Priority |
|-------|-------|----------|----------|
| 80-100 | Hot | Strong ICP match on 3+ dimensions + at least one buying signal | high |
| 60-79 | Warm | Good ICP match (2+ dimensions), active profile, relevant audience — but no direct buying signals yet | medium |
| 40-59 | Lukewarm | Partial ICP match (1-2 dimensions). Some relevance but unclear intent or weak profile | medium |
| 20-39 | Cool | Weak match. Low activity, small audience, or tangential relevance only | low |
| 0-19 | Cold | Poor fit or matches a disqualification criterion. Only save if there's a reason to track | low |

**When saving or updating a lead, always include in the notes:**
- Which ICP dimensions they match (and which they don't)
- What buying signals you observed (if any)
- Why you chose that score

## 3. Discovery — How to Find Leads

### Strategy: Quality Over Quantity

5 well-qualified leads beat 50 random ones. Only save someone if they score >= 40 (unless the user explicitly asks for broader collection).

### Where to Look

1. **Start with project.md** — check which platforms the user listed under ICP → Platforms
2. **Load the platform skill** (`loadSkill`) for platform-specific search instructions
3. **Search using ICP-derived keywords**, not generic terms:
   - Combine: pain point keywords + role keywords + industry keywords
   - Example: Instead of "marketing", search "struggling with content calendar SaaS founder"
4. **Mine intent-rich locations:**
   - Comments on competitor posts
   - "Help me choose" or "alternatives to X" threads
   - Industry-specific communities, groups, hashtags
   - Q&A posts matching the problem your product solves

### Discovery Workflow

```
1. Read project.md → ICP + Platforms
2. Read product.md → pain points, competitors, use cases
3. For each target platform:
   a. loadSkill(platform) for search instructions
   b. Build search queries from ICP keywords
   c. Search and scan results
   d. For each promising profile:
      - Check against ICP dimensions
      - Check against disqualification criteria
      - If score >= 40: saveLead with full notes
      - If unsure: saveLead with low score + "needs manual review"
4. After saving, check listLeads to avoid duplicates
```

## 4. Disqualification — When NOT to Save

Check `project.md` → "Disqualification Criteria" for project-specific rules. Always apply these universal rules too:

- **Already exists** — check `listLeads` before saving to avoid duplicates
- **Competitor or their employee** — unless the user explicitly wants to track competitors
- **Bot / spam account** — no real profile, generic content, suspicious follower ratios
- **Inactive** — no activity in 6+ months (they won't see your outreach)
- **Wrong geography** — if the ICP specifies a region and the lead is clearly outside it
- **Wrong language** — if the product only supports certain languages

When disqualified: don't save the lead at all. If you already saved them and discover a disqualifier during enrichment, set score to 0 and append a note explaining why.

## 5. Enrichment

When enriching a lead (visiting their profile to fill in missing data), score them against the ICP:

```
1. Read project.md → ICP (to know what to look for)
2. Read product.md → competitors, use cases (to spot buying signals)
3. Visit the lead's profileUrl via browser
4. Extract and match:
   - Role/title → does it match ICP?
   - Industry/company → target industry?
   - Content/posts → mention pain points? Use competitors?
   - Activity level → active enough for outreach?
   - Audience → relevant size and composition?
5. Update the lead:
   - Set score based on rubric above
   - Set priority based on score (>=70 high, >=40 medium, else low)
   - Add tags reflecting ICP dimensions matched
   - Write notes explaining the score reasoning
   - Set interest to what makes them relevant
```

## 6. Outreach — Follow the Project Strategy

Read `project.md` → "Outreach Strategy" before crafting any message. Key rules:

### Channel Selection
- **Match the channel to where you found the lead.** Don't email someone you found on Instagram.
- If the lead has multiple platforms, prefer the one specified in `project.md` → Outreach Strategy → First touch approach.

### Message Crafting
- **Use the tone defined in project.md.** If it says "casual and direct", don't write formal business emails.
- **Personalize from notes.** Reference specific things from their profile, posts, or comments.
- **Never send generic templates.** Every message must reference at least one specific detail about the lead.
- **Lead with the value proposition** from project.md → Outreach Strategy, adapted to the lead's specific situation.

### Follow-up Cadence
- **Respect the max follow-ups** defined in project.md. Default to 3 if not specified.
- After the max is reached with no reply, mark as "dropped" with a note.
- Follow-up timing:
  - 1st follow-up: 3-5 days after initial outreach
  - 2nd follow-up: 5-7 days after 1st
  - 3rd (breakup): 7-14 days after 2nd — keep it short, no pressure
  - After breakup: set follow_up_date to 30 days for long-term nurture

### What NOT to Do
- Don't send outreach before reading the lead's notes and outreach history
- Don't message on platforms where the user hasn't logged in (check via the platform skill)
- Don't send multiple messages to the same lead in one day
- Don't use aggressive sales language unless the outreach strategy explicitly says to

## 7. Escalation — When to Stop and Ask the User

**Always escalate (don't act autonomously) when:**

1. A lead asks about **custom pricing or enterprise deals** — the user needs to handle this personally
2. A lead expresses **negative sentiment** about the product — wrong response can damage the brand
3. A lead requests a **call, demo, or meeting** — the user needs to schedule this
4. A lead's reply is **ambiguous or complex** — don't guess, ask the user
5. The **outreach strategy in project.md defines custom escalation rules** — follow those
6. You're **unsure whether someone fits the ICP** — save with a low score and flag for review rather than discard

**How to escalate:** Append a note to the lead with "ESCALATION NEEDED: [reason]" and inform the user in the chat. Do NOT draft an auto-response for escalated situations.

## 8. Conversion — When a Lead is "Converted"

Never mark a lead as "converted" on your own. Only the user can confirm a conversion. Suggest it when:
- The lead has agreed to buy, signed up, or made a commitment
- The user explicitly says the deal is done

When suggesting: "Lead [name] seems ready to convert — they [reason]. Want me to mark them as converted?"
