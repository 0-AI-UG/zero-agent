---
name: google-maps
description: Find local business leads on Google Maps — extract contact info, assess quality via reviews, enrich via business websites
metadata:
  version: "2.0.0"
  platform: google-maps
  login_required: false
  requires:
    env: []
    bins: []
  capabilities:
    - prospect
    - enrich
    - outreach
  tags:
    - local
    - b2b
    - lead-generation
---

# Google Maps — Sales Workflows

Best for local B2B prospecting. No login required. Rich business data (phone, website, hours, reviews) makes it ideal for building targeted lists of local businesses. Outreach happens off-platform via email/phone.

## Login & Gotchas

No login required. Dismiss cookie consent via "Accept all". If CAPTCHA appears, inform the user — cannot be bypassed. The results list and detail panel are **separate scroll areas** — scroll the correct one. "Sponsored" results at the top are ads.

## 1. Prospecting

**Goal:** Build a list of businesses matching the target market from product.md.

Search URL: `https://www.google.com/maps/search/{query}` (replace spaces with `+`). Add location qualifiers for better results: `dentists+in+San+Francisco`, `marketing+agencies+Austin+TX`.

The results panel on the left shows business cards. For each business, click to open the detail panel and extract:
- Business name, category
- Address, phone number
- Website URL
- Star rating and review count
- Hours of operation

**Scoring guidance:**
- 80-100: Category matches ICP + has website + good rating (4+) + many reviews (active business) + phone listed
- 60-79: Right category, has website but fewer signals (low reviews, no phone)
- 40-59: Adjacent category, may be a fit
- Below 40: Wrong category or closed/poor rating

**Batch extraction pattern:** Work through results systematically — click each business, extract data, navigate back. Look for "Next" or pagination at the bottom for more results.

```
saveLead({
  name: "Business Name",
  platform: "google-maps",
  platformHandle: "",
  profileUrl: "https://www.google.com/maps/place/...",
  source: "google-maps-search:{query}",
  interest: "{inferred from category}",
  priority: "medium",
  score: 75,
  tags: "dentist,san-francisco,4.5-stars",
  notes: "4.5 stars, 230 reviews. Website: example.com. Phone: (555) 123-4567. Open Mon-Fri 9-5."
})
```

## 2. Enrichment

**Step 1 — Maps detail panel:** Extract everything from the listing: phone, website, hours, rating, review count, category, and photos.

**Step 2 — Visit the website:** Navigate to the business website (from the Maps listing). Look for:
- Owner/decision-maker names (About page, Team page)
- Email addresses (Contact page, footer)
- Social media links (LinkedIn, Instagram, etc.)
- Company size signals (team photos, office locations)
- Services/pricing pages for fit assessment

**Step 3 — Check reviews for pain points:** Click the "Reviews" tab in the Maps detail panel. Sort by "Lowest rating" — negative reviews reveal pain points your product might solve. Sort by "Newest" to gauge recent activity.

```
updateLead({
  id: "{leadId}",
  score: 82,
  email: "info@example.com",
  tags: "dentist,san-francisco,owner-identified",
  interest: "practice management — website mentions manual scheduling",
  notes: "Owner: Dr. Jane Smith (from About page). Email: info@example.com. 3-person practice. Recent 1-star reviews mention long wait times — potential pain point for scheduling software. LinkedIn: /in/janesmith"
})
```

## 3. Outreach

Google Maps has **no direct messaging**. Outreach happens via extracted contact info:

**Email** (primary): Use `sendDirectMessage({ leadId, channel: "email", subject: "...", content: "..." })` when you have their email.

**Phone** (manual): Note the phone number and suggest the user call. Use `channel: "manual"` with content describing the recommended talking points.

**Social media** (cross-platform): If you found their LinkedIn/Instagram during enrichment, use the appropriate platform skill for outreach. Update the lead with the additional platform info:
```
updateLead({
  id: "{leadId}",
  notes: "Also found on LinkedIn: /in/janesmith — use LinkedIn skill for connection request"
})
```

**What works for local business outreach:**
- Reference their specific business by name and location
- Mention something specific (a recent review, their service offering)
- Offer a concrete benefit tied to their business type
- Local businesses respond better to phone than email — suggest to user if phone is available

## Navigation Reference

| Action | URL/Pattern |
|--------|-------------|
| Search businesses | `google.com/maps/search/{query+with+plus}` |
| Detail panel | Click business name in results list |
| Reviews tab | Click reviews section in detail panel |
| Sort reviews | Click sort dropdown in reviews |
| Back to results | Click back arrow or re-navigate to search URL |
| No results | Broaden query or change location |
| CAPTCHA | Cannot bypass — inform user |
