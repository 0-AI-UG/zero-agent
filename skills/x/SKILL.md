---
name: x
description: Find and engage leads on X/Twitter — prospect via advanced search, reply/DM outreach, build presence through tweets
metadata:
  version: "2.0.0"
  platform: x
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
    - b2c
    - outreach
    - lead-generation
---

# X/Twitter — Sales Workflows

Best for real-time lead discovery through conversations. Advanced search operators make it powerful for finding people discussing specific problems or looking for solutions right now. Works for both B2B and B2C.

## Login & Gotchas

After navigating to any X page, snapshot. If you see "Sign in" or a login form, stop and ask the user to log in via the companion browser. Dismiss popups: "Turn on notifications" → X, "Get the app" → X, "Verify your phone" → X. Cookie banner: "Accept". Rate limit: "Rate limit exceeded" → wait 15s and retry once. Non-premium accounts have stricter limits.

## 1. Prospecting

**Goal:** Find people actively discussing problems your product solves.

**Search posts** (most powerful): `https://x.com/search?q={query}&src=typed_query`

**Advanced search operators** — combine these to find high-intent leads:
- `"looking for" {product category}` — people actively seeking solutions
- `"anyone recommend" {topic}` — recommendation requests
- `"frustrated with" OR "struggling with" {pain point}` — problem signals
- `from:{competitor} min_faves:50` — engaged competitor audience
- `{keyword} min_faves:10 -filter:retweets` — original posts with engagement
- `since:2024-01-01 until:2024-12-31` — date range
- `{keyword} filter:links` — posts containing links (often business users)

Switch to "Latest" tab for chronological results (better for timely outreach). Use `&f=user` for user search: `x.com/search?q={query}&src=typed_query&f=user`.

For each prospect, visit their profile (`x.com/{username}`) and extract:
- Name, handle, bio, location, website link
- Follower/following count and ratio
- Pinned tweet (often reveals priorities)

**Scoring guidance:**
- 80-100: Actively asking for solutions in your category + business account + relevant bio + recent post
- 60-79: Engages with related content, decent following, professional bio
- 40-59: Mentioned topic once, unclear if active need
- Below 40: Old tweet, inactive, or bot-like profile

```
saveLead({
  name: "Display Name",
  platform: "x",
  platformHandle: "@username",
  profileUrl: "https://x.com/username",
  source: "x-search:{query}",
  interest: "{inferred from tweet/bio}",
  priority: "high",  // if actively seeking solutions
  score: 85,
  tags: "active-seeker,saas,founder",
  notes: "Tweeted 'looking for a better tool for X' 2 days ago. 5k followers, SaaS founder per bio. Website: example.com"
})
```

## 2. Enrichment

Visit the lead's profileUrl. Snapshot and extract:
- **Bio**: Role, company, interests, website link
- **Pinned tweet**: Often their most important message — reveals priorities
- **Recent tweets**: Active topics, pain points, tech stack mentions
- **Follower/following ratio**: High ratio = influencer/thought leader
- **Website link**: Follow it to find company details, email, other socials

```
updateLead({
  id: "{leadId}",
  score: 88,
  email: "found@on-website.com",
  tags: "founder,saas,active-seeker,10k-followers",
  interest: "project management tools — tweeted about workflow pain 3 times this month",
  notes: "CTO at StartupXYZ (from bio). Website links to company with 50-person team. Pinned tweet about scaling engineering processes. Tweets daily."
})
```

## 3. Outreach

**Reply engagement** (recommended first): Reply to their relevant tweets with genuine insight or a helpful answer. This is public and builds credibility. Use `channel: "comment"` to track.

**Quote tweets**: Quote their tweet with added value/perspective. Good for showing expertise. Track as `channel: "comment"`.

**Direct messages**: Navigate to `https://x.com/messages`, click compose, search username, type message, send. **Most users restrict DMs to followers only** — if "Message" button is disabled, reply/mention instead. Use `channel: "direct_message"`.

**What works on X:**
- Reply with expertise to their problem tweet — don't pitch, help
- Add value in the conversation thread before going to DMs
- Be concise — X culture values brevity
- Humor and personality go further here than on LinkedIn
- 280 character limit for free accounts — make every word count
- Timing matters: reply within hours of their tweet for relevance

```
sendDirectMessage({
  leadId: "{leadId}",
  channel: "direct_message",
  content: "Hey! Saw your tweet about X — we built something that might help..."
})
```

## 4. Reply Checking

Navigate to `https://x.com/notifications`. Snapshot. Check for:
- Replies to your tweets/comments (mentions tab)
- DM notifications in `https://x.com/messages` (look for unread indicators)

Also search `to:{your_username}` to find public replies you may have missed.

```
recordOutreachReply({
  messageId: "{originalMessageId}",
  replyBody: "{their reply}"
})
```

## 5. Content Creation

Navigate to `https://x.com/compose/post` or click the compose button. Type tweet (280 chars free, longer for premium). Add images via media icon. Click "Post".

**What works:**
- Hot takes on industry trends drive engagement and followers
- Threads (multi-tweet) for deeper content — start with a hook tweet
- Quote-tweet interesting content with your perspective
- Ask questions to drive replies (potential leads)
- Post during peak hours for your target audience's timezone
- Use 1-2 relevant hashtags max — X culture disfavors hashtag stuffing

## Navigation Reference

| Action | URL/Pattern |
|--------|-------------|
| Search posts | `x.com/search?q={query}&src=typed_query` |
| Search users | `x.com/search?q={query}&src=typed_query&f=user` |
| View profile | `x.com/{username}` |
| DM inbox | `x.com/messages` |
| Notifications | `x.com/notifications` |
| Compose tweet | `x.com/compose/post` |
| DMs restricted | Most users disable DMs from non-followers — use replies instead |
| "Rate limit exceeded" | Wait 15s, retry once |
| Sensitive content interstitial | Click "Yes, view profile" |
