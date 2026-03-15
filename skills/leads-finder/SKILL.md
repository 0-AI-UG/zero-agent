---
name: leads-finder
description: >-
  Find and qualify leads from the web — potential customers, partners,
  investors, or candidates. Maintains a CSV pipeline and generates
  a live dashboard. Use when the user wants to build prospect lists,
  research companies, or find people matching specific criteria.
metadata:
  version: "1.0.0"
  platform: leads
  login_required: false
  requires:
    env: []
    bins: []
  capabilities:
    - search
    - scrape
    - analyze
    - export
    - monitor
  tags:
    - leads
    - prospecting
    - sales
    - research
    - crm
---

# Leads Finder

Find, qualify, and manage leads from the web. This skill covers the full pipeline: search → extract → enrich → score → CSV management → live dashboard.

## 1. Search Strategy Patterns

Use targeted search queries depending on the type of lead:

**Company leads:**
- `"{industry}" "series A" site:crunchbase.com`
- `"{industry}" "seed funding" {year}`
- `"{product category}" startup site:techcrunch.com`

**People leads:**
- `"{title}" "{company}" site:linkedin.com`
- `"{role}" "{industry}" site:linkedin.com`

**Hiring-signal leads:**
- `"{tool/product}" hiring OR careers`
- `"{company}" "we're hiring" "{role}"`

**Event-based leads:**
- `"{conference}" speakers {year}`
- `"{industry}" summit attendees {year}`

Combine multiple strategies per run to maximize coverage. Vary queries across runs to avoid duplicate-heavy result sets.

## 2. Data Extraction

For each search result, extract and record:

**Company fields:** name, website, industry, size (employee range), location, funding stage, tech stack signals
**Person fields:** name, title, company, LinkedIn URL
**Meta fields:** source URL, discovery date, search query used

Extract data from the search result snippets and landing pages. Prefer structured sources (Crunchbase, LinkedIn, company About pages) over unstructured blog posts.

## 3. Enrichment Workflow

For each raw lead, enrich with additional signals:

1. **Fetch homepage** → extract tagline, product description, team size signals (e.g. "team of 50+"), tech stack hints (check page source for React, Next.js, etc.)
2. **Search for recent news/funding** → query `"{company name}" funding OR raised OR series` to find recent rounds
3. **Check careers page** → look for `/careers`, `/jobs`, or links to Lever/Greenhouse/Ashby job boards. Note number of open roles and relevant titles.

Record enrichment findings in the `notes` column of the CSV.

## 4. Lead Scoring

Score each lead 1–100 using Python with configurable weights. The default weights are:

```python
score = 0
if funding_recent: score += 25        # Raised funding in last 12 months
if hiring_relevant_roles: score += 20  # Hiring roles matching target profile
if tech_stack_match: score += 20       # Uses tech in the target criteria
if company_size_in_range: score += 15  # Employee count within ideal range
if location_match: score += 10         # HQ in target geography
if website_quality_signals: score += 10 # Professional site, clear product, active blog
```

Weights can be customized via `leads/search-config.txt`. Apply scoring after enrichment so all signals are available.

## 5. CSV Pipeline Management

Maintain `leads/leads.csv` with these columns:

```
name,company,title,website,linkedin,source,score,status,found_date,notes
```

**Deduplication rules:**
- Match by website domain (normalize: strip www, trailing slash)
- Match by LinkedIn URL (normalize: strip trailing slash, query params)
- If a duplicate is found, update the existing row's score and notes rather than adding a new row

**Status lifecycle:**
```
new → contacted → replied → qualified → disqualified
```

All new leads start with status `new`. Status changes are manual (user-driven) unless the skill is explicitly told to update them.

## 6. Dashboard Generation

After every lead update, regenerate the pipeline dashboard. This is a two-step process:

### Step 1: Compute stats with Python

Run this Python script to read the CSV and produce a JSON stats blob:

```python
import csv, json
from collections import Counter
from datetime import datetime, timedelta

# Read the CSV
leads = []
with open('leads/leads.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        row['score'] = int(row.get('score', 0))
        leads.append(row)

# Pipeline stats
status_counts = Counter(l['status'] for l in leads)
total = len(leads)
funnel = {
    'new': status_counts.get('new', 0),
    'contacted': status_counts.get('contacted', 0),
    'replied': status_counts.get('replied', 0),
    'qualified': status_counts.get('qualified', 0),
    'disqualified': status_counts.get('disqualified', 0),
}

# Score distribution
score_buckets = {'0-25': 0, '26-50': 0, '51-75': 0, '76-100': 0}
for l in leads:
    s = l['score']
    if s <= 25: score_buckets['0-25'] += 1
    elif s <= 50: score_buckets['26-50'] += 1
    elif s <= 75: score_buckets['51-75'] += 1
    else: score_buckets['76-100'] += 1

# Top leads
top_leads = sorted(leads, key=lambda x: x['score'], reverse=True)[:20]

# Source breakdown
source_counts = Counter(l.get('source', 'unknown') for l in leads)

# Weekly trend
today = datetime.now()
weekly = {}
for l in leads:
    try:
        d = datetime.strptime(l['found_date'], '%Y-%m-%d')
        week_key = d.strftime('%Y-W%U')
        weekly[week_key] = weekly.get(week_key, 0) + 1
    except: pass

# New this week
week_ago = (today - timedelta(days=7)).strftime('%Y-%m-%d')
new_this_week = sum(1 for l in leads if l.get('found_date', '') >= week_ago)

# Average score
avg_score = round(sum(l['score'] for l in leads) / max(total, 1), 1)

# Output as JSON for the visualizer
data = {
    'total': total,
    'new_this_week': new_this_week,
    'avg_score': avg_score,
    'funnel': funnel,
    'score_buckets': score_buckets,
    'top_leads': [{'name': l['name'], 'company': l['company'], 'title': l.get('title',''),
                   'score': l['score'], 'status': l['status'], 'source': l.get('source',''),
                   'found_date': l.get('found_date','')} for l in top_leads],
    'source_counts': dict(source_counts),
    'weekly_trend': dict(sorted(weekly.items())),
}
print(json.dumps(data, indent=2))
```

### Step 2: Build the HTML dashboard

Load the visualizer skill, read its STYLE.md, and use the dashboard template to build `visualizations/leads-dashboard.html` with these sections:

- **KPI row:** Total Leads, New This Week, Avg Score, Qualified count — displayed as large number cards
- **Funnel chart:** Visual pipeline funnel (new → contacted → replied → qualified) with counts and conversion rates between stages
- **Score distribution:** Bar chart grouping leads into buckets (0-25, 26-50, 51-75, 76-100)
- **Top leads table:** Sortable table of top 20 leads by score, showing name, company, score bar, status badge, source, found date
- **Source breakdown:** Donut chart showing which search strategies produce the most leads
- **Trend line:** Leads added over time (weekly) from found_date data

Embed the JSON data directly into the HTML as a JavaScript variable. All charts should be rendered with inline SVG or Canvas — no external libraries.

**Key rule:** Every time you find new leads or update lead statuses, re-run the Python pipeline script and regenerate the dashboard so it always reflects the current CSV state.
