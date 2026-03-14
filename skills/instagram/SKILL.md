---
name: instagram
description: Find and engage B2C leads on Instagram — prospect via hashtags and profiles, DM outreach, comment engagement
metadata:
  version: "2.0.0"
  platform: instagram
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
    - b2c
    - outreach
    - lead-generation
---

# Instagram — Sales Workflows

Best for B2C and creator/influencer outreach. Visual-first platform — engagement (likes, comments, DMs) is the primary sales signal. Comment-first strategy works better than cold DMs.

## Login & Gotchas

After navigating to any Instagram page, snapshot. If you see "Log in" or "Sign up", stop and ask the user to log in via the companion browser. Dismiss popups: "Turn on Notifications" → "Not Now", "Get the Instagram app" → X, "Save Your Login Info" → "Not Now". Cookie banner: "Allow all cookies". **Rate limits are aggressive** — "Action Blocked" or "Try Again Later" means stop ALL operations immediately. Do NOT retry. Wait 24+ hours.

## 1. Prospecting

**Goal:** Find leads showing interest in topics related to product.md.

**By hashtag** (best for discovery): Navigate to `https://www.instagram.com/explore/tags/{tag}/` (no # in URL). Browse top posts. Click into posts with high engagement — check the poster's profile for ICP fit.

**By user search**: Click the search icon (magnifying glass) in the left sidebar, type a query, look for accounts in the dropdown.

**By competitor followers/engagers**: Visit competitor profiles, look at who comments on their posts — these are warm prospects already interested in the space.

For each prospect, navigate to their profile (`instagram.com/{username}/`) and extract:
- Username, display name, bio
- Follower/following count, post count
- Bio link (often Linktree or business website)
- Whether they have a business/creator account (visible in bio)

**Scoring guidance:**
- 80-100: Bio mentions relevant need/industry + active poster + business account + bio link
- 60-79: Engages with relevant content, decent following, but no clear buying signal
- 40-59: Tangentially related, mostly personal content
- Below 40: Inactive or no relevance

```
saveLead({
  name: "Display Name",
  platform: "instagram",
  platformHandle: "@username",
  profileUrl: "https://www.instagram.com/username/",
  source: "instagram-hashtag:{tag}",
  interest: "{inferred from bio/content}",
  priority: "medium",
  score: 70,
  tags: "creator,skincare,active",
  notes: "10k followers, posts daily about skincare routines. Bio link to personal brand site. Commented on competitor's post asking about alternatives."
})
```

## 2. Enrichment

Visit the lead's profileUrl. Snapshot and extract:
- **Bio**: Business keywords, location, email (sometimes listed directly)
- **Bio link**: Follow it — often reveals business details, pricing, other platforms
- **Story highlights**: Named highlights often reveal business offerings, testimonials
- **Recent posts**: Content themes, engagement rate (likes/comments vs follower count)
- **Tagged posts**: Collaborations and partnerships

```
updateLead({
  id: "{leadId}",
  score: 78,
  email: "found@in-bio.com",
  tags: "creator,skincare,10k-followers",
  interest: "skincare tools — posts product reviews, bio links to review blog",
  notes: "Email in bio. Highlights show brand collabs. Avg 500 likes/post on 10k followers = 5% engagement (high)."
})
```

## 3. Outreach

**Comment-first strategy** (recommended): Engage with 2-3 of their posts with thoughtful comments before DM-ing. This builds familiarity and moves your DM out of Message Requests. Use `sendDirectMessage({ leadId, channel: "comment", content: "..." })` to track each comment.

**Direct messages**: Navigate to `https://www.instagram.com/direct/inbox/`, click compose (pencil icon), search username, type message, send. **Warning:** DMs to non-followers go to Message Requests — they may never see it. Use `channel: "direct_message"`.

**What works on Instagram:**
- Reference their specific content ("loved your post about X")
- Be casual and conversational — Instagram is informal
- Voice messages get higher open rates than text (mention to user as option)
- Keep DMs to 2-3 sentences max
- Don't pitch in the first message — start a conversation

## 4. Reply Checking

Navigate to `https://www.instagram.com/direct/inbox/`. Snapshot. Look for unread conversations (bold text, notification dot). Check both the main inbox and "Requests" tab (for replies from non-followers).

```
recordOutreachReply({
  messageId: "{originalMessageId}",
  replyBody: "{their reply}"
})
```

Also check notifications (heart icon) for comment replies on your content posts — these may be leads responding to your content.

## 5. Content Creation

Navigate to `https://www.instagram.com/`, click "Create" or "+" in the left sidebar. Upload image → Next (crop) → Next (filter) → write caption → Share.

**What works:**
- Carousel posts (multiple images) get highest engagement — but limited on web
- Use relevant hashtags (5-15) in caption for discovery
- Ask a question in the caption to drive comments
- Post when audience is active (check product.md for target timezone)
- Web posting is limited to single images — suggest mobile for Reels/carousels

## Navigation Reference

| Action | URL/Pattern |
|--------|-------------|
| View profile | `instagram.com/{username}/` |
| Hashtag browse | `instagram.com/explore/tags/{tag}/` |
| DM inbox | `instagram.com/direct/inbox/` |
| Home/compose | `instagram.com/` → "+" button |
| Search | Click magnifying glass in sidebar |
| "Action Blocked" | Stop immediately. 24h+ wait. Inform user |
| Private profile | Limited info visible — can only see bio/stats |
| Message Requests | DMs from non-followers land here — low visibility |
