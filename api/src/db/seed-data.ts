/**
 * Built-in skill and template seed data.
 * Extracted from db/index.ts so it can be referenced from multiple places.
 */

export const BUILTIN_SKILL_IDS: Record<string, string> = {
  "visualizer": "builtin-visualizer",
  "leads-finder": "builtin-leads-finder",
  "account-creation": "builtin-account-creation",
  "skill-creator": "builtin-skill-creator",
};

export const BUILTIN_SKILLS: { id: string; name: string; description: string }[] = [
  { id: "builtin-visualizer", name: "visualizer", description: "Create interactive HTML visualizations — charts, dashboards, data tables, and reports." },
  { id: "builtin-leads-finder", name: "leads-finder", description: "Find and qualify leads from the web — potential customers, partners, investors, or candidates." },
  { id: "builtin-account-creation", name: "account-creation", description: "Create new accounts on websites, generate secure passwords, set up TOTP, and manage credential files." },
  { id: "builtin-skill-creator", name: "skill-creator", description: "Create new skills for any platform or workflow." },
];

export const BUILTIN_TEMPLATES: {
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: string;
  category: string;
  requiredSkillIds: string[];
}[] = [
  {
    id: "builtin-morning-command-center",
    name: "Morning command center",
    description: "Builds an interactive personal dashboard every morning with weather, top news, your open tasks, and calendar — rendered as a live HTML visualization.",
    prompt: `Load the visualizer skill.

Step 1 — Weather:
Search the web for today's weather in the user's location. Get current temperature, high/low, conditions (sunny, cloudy, rain, etc.), humidity, and wind speed. If there are any weather alerts or unusual conditions, note those too.

Step 2 — News:
Search for the top 7 tech and business news headlines from today. For each headline capture: the title, source publication, a one-line summary, and the URL. Prioritize breaking news, major product launches, funding rounds, and industry shifts.

Step 3 — Tasks:
Read any existing files named tasks.csv, todos.md, or todo.txt for open items. Parse out task name, priority (if available), due date (if available), and status. If no task files exist, skip this section.

Step 4 — Quote:
Search the web for an inspirational or motivational quote. Pick one that's concise and energizing.

Step 5 — Build dashboard:
Using the visualizer skill, build an interactive HTML dashboard saved as morning-dashboard.html with these sections:
- KPI row at top: current temperature, number of open tasks, number of news stories
- Weather widget: temperature, conditions icon, high/low, humidity, wind
- News feed: each headline as a card with title, source, summary — sorted by relevance
- Open tasks table: sortable by priority and due date, with color-coded priority badges (high=red, medium=amber, low=green)
- Motivational quote displayed prominently at the bottom

Do not specify any particular color scheme — let the visualizer skill's default styling handle it.`,
    schedule: "0 7 * * 1-5",
    category: "dashboards",
    requiredSkillIds: ["builtin-visualizer"],
  },
  {
    id: "builtin-lead-generation-pipeline",
    name: "Lead generation pipeline",
    description: "Finds and qualifies leads from the web on a recurring schedule — searches, enriches, scores, maintains a CSV pipeline, and generates a live HTML dashboard.",
    prompt: `Load the leads-finder skill.

Step 1 — Read config:
Read leads/search-config.txt (create it if missing with:
  "target: SaaS companies using React
  ideal_size: 10-200 employees
  location: US, Europe
  signals: recently funded, actively hiring engineers
  scoring_weights: funding=25, hiring=20, tech_match=20, size=15, location=10, quality=10"
).

Step 2 — Search for leads:
Following the leads-finder skill search strategy patterns, run 3-5 different search queries tailored to the target profile. For each search result, extract company/person data as described in the skill.

Step 3 — Enrich:
For each new lead found, follow the enrichment workflow: fetch their website, search for recent news/funding, check for hiring signals.

Step 4 — Score and deduplicate:
Use Python following the lead scoring section of the skill. Read existing leads/leads.csv and deduplicate new leads against it by website domain. Append only genuinely new leads.

Step 5 — Generate dashboard:
Run the Python pipeline script from the leads-finder skill to compute all stats from the current leads/leads.csv. Load the visualizer skill and build visualizations/leads-dashboard.html with the full pipeline dashboard (KPIs, funnel, score distribution, top leads table, source breakdown, weekly trend).

Step 6 — Write summary:
Write leads/run-summary-{today's date}.md with: how many new leads found, top 3 by score, pipeline totals, and any notable findings.`,
    schedule: "0 8 * * 1,4",
    category: "automation",
    requiredSkillIds: ["builtin-leads-finder", "builtin-visualizer"],
  },
];
