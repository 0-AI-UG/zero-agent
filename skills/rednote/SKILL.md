---
name: rednote
description: Find and engage leads on RedNote (小红书) — prospect via post/user search, DM outreach, content creation in Chinese
metadata:
  version: "2.0.0"
  platform: rednote
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
    - chinese
---

# RedNote (小红书) — Sales Workflows

Best for reaching Chinese consumers and lifestyle/beauty/wellness B2C audiences. Content-driven discovery platform — users search for product reviews and recommendations. All UI is in **Chinese**. Search keywords in Chinese yield far better results.

## Login & Gotchas

After navigating to any RedNote page, snapshot. If you see a QR code or "登录" (Login) dialog, stop and tell the user to scan the QR code with the RedNote mobile app via the companion browser. There is no username/password web login. Dismiss popups: "下载APP" / "打开APP" → X button, notification prompts → "不允许". Cookie/privacy notice: "同意" or "接受". Rate limit: "操作太频繁" (too frequent) → wait 30+ seconds.

## 1. Prospecting

**Goal:** Find users posting about topics related to product.md, especially those asking questions or seeking recommendations.

**Search posts**: `https://www.xiaohongshu.com/search_result?keyword={query}&type=1` (URL-encode, `type=1` = posts/笔记). Chinese keywords are essential — e.g., `护肤推荐` (skincare recommendations), `好用的工具` (useful tools).

**Search users**: `https://www.xiaohongshu.com/search_result?keyword={query}&type=2` (`type=2` = users/用户).

**Prospecting via posts** (most effective): Search for posts where people ask for recommendations or share pain points. Click into posts, then check the poster's profile. Users who actively seek solutions are higher-intent leads.

For each prospect, visit their profile (`xiaohongshu.com/user/profile/{user_id}`) and extract:
- Nickname (昵称), RedNote ID (小红书号), bio (简介)
- Location, follower count (粉丝), likes & collections (获赞与收藏)
- Post themes and frequency

**Scoring guidance:**
- 80-100: Actively seeking solutions in your category + recent posts asking for recommendations + engaged audience
- 60-79: Posts about related topics, moderate engagement
- 40-59: Tangentially related, mostly personal lifestyle content
- Below 40: Inactive or irrelevant niche

```
saveLead({
  name: "昵称 (Nickname)",
  platform: "rednote",
  platformHandle: "小红书号",
  profileUrl: "https://www.xiaohongshu.com/user/profile/{user_id}",
  source: "rednote-search:{keyword}",
  interest: "{从帖子/简介推断}",
  priority: "medium",
  score: 72,
  tags: "skincare,seeking-recommendations",
  notes: "Posted asking for serum recommendations. 5k followers, posts 3x/week about skincare routine."
})
```

## 2. Enrichment

Visit the lead's profileUrl. Snapshot and extract:
- **Stats**: 粉丝 (followers), 关注 (following), 获赞与收藏 (likes & collections)
- **Bio**: Keywords, location, any contact info or WeChat ID
- **Posts tab** (笔记): Content themes, posting frequency, engagement per post
- **Collections** (收藏): What they save reveals purchase intent

```
updateLead({
  id: "{leadId}",
  score: 80,
  tags: "skincare,high-engagement,shanghai",
  interest: "anti-aging skincare — multiple posts comparing serum brands",
  notes: "Based in Shanghai. 8k followers. Recent posts compare premium skincare brands by price/efficacy. Collections include competitor product reviews. WeChat ID in bio: wxid_xxx."
})
```

## 3. Outreach

**Comment engagement** (recommended first step): Comment on their posts with helpful information — e.g., answering a question they asked. RedNote's community is advice-driven. Use `channel: "comment"`.

**Direct messages** (私信): Navigate to the lead's profile, click "私信" (Private message) button, type message, click "发送" (Send). Use `channel: "direct_message"`. **Note:** DMs between non-followers may be restricted or filtered.

**What works on RedNote:**
- Share genuine expertise or helpful information (not sales pitches)
- Reference their specific post or question
- Write in Chinese — even if your product targets international users, the platform is Chinese-first
- Offer value: tips, comparisons, insider knowledge
- Keep DMs concise — 2-3 sentences in Chinese

```
sendDirectMessage({
  leadId: "{leadId}",
  channel: "direct_message",
  content: "你好！看到你之前发的关于精华液推荐的帖子..."
})
```

## 4. Reply Checking

Navigate to the messaging interface. Look for the messaging icon in the navigation or go to the notifications area. Snapshot and check for unread messages. For comment replies, check notification alerts for responses on your posts/comments.

```
recordOutreachReply({
  messageId: "{originalMessageId}",
  replyBody: "{reply content}"
})
```

## 5. Content Creation

Navigate to `https://www.xiaohongshu.com/`, find the publish button ("+" or "发布"). Upload image → add title (标题, required) → add body text (正文) → add hashtags (话题, via "#" icon or "添加话题") → click "发布" (Publish).

**Critical:** All images must be **portrait/vertical orientation** — this is the standard format for RedNote.

**What works:**
- Product comparison posts (测评) drive high engagement and comments
- "Honest review" (真实测评) format builds trust
- Lists: "5 must-have tools for X" (X个必备好物)
- Use trending hashtags relevant to your niche
- Include price information — RedNote users expect it
- Before/after photos perform well in beauty/lifestyle
- Web post creation is limited vs mobile — suggest mobile for complex posts

## Navigation Reference

| Action | URL/Pattern |
|--------|-------------|
| Search posts | `xiaohongshu.com/search_result?keyword={query}&type=1` |
| Search users | `xiaohongshu.com/search_result?keyword={query}&type=2` |
| View profile | `xiaohongshu.com/user/profile/{user_id}` |
| DM button | "私信" on profile page |
| Send button | "发送" |
| Publish | "发布" |
| Rate limited | "操作太频繁" — wait 30s+ |
| User not found | "用户不存在" — wrong ID or account deleted |
| QR login required | Must scan with RedNote mobile app — cannot bypass |
