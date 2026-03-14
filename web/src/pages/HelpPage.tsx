import { useRef, useState, useEffect } from "react";
import {
  BotIcon,
  ArrowRightIcon,
  ShieldIcon,
  PuzzleIcon,
  MonitorIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const sections = [
  { id: "overview", label: "Overview" },
  { id: "capabilities", label: "Capabilities" },
  { id: "skills", label: "Skills" },
  { id: "browser", label: "Browser Automation" },
  { id: "chat", label: "Chat Interface" },
  { id: "pipeline", label: "Lead Pipeline" },
  { id: "outreach", label: "Outreach" },
  { id: "automation", label: "Automation" },
  { id: "getting-started", label: "Getting Started" },
  { id: "knowledge", label: "Knowledge Files" },
  { id: "tips", label: "Tips" },
] as const;

function SidebarNav({
  activeSection,
  onSelect,
}: {
  activeSection: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="space-y-0.5">
      {sections.map((section) => (
        <button
          key={section.id}
          onClick={() => onSelect(section.id)}
          className={cn(
            "block w-full text-left text-[13px] px-3 py-1.5 rounded-md transition-colors",
            activeSection === section.id
              ? "bg-accent text-accent-foreground font-medium"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
          )}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={`help-${id}`}
      className="text-base font-semibold tracking-tight pt-2"
    >
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[13px] font-semibold mt-5 mb-2">{children}</h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13px] text-muted-foreground leading-relaxed">
      {children}
    </p>
  );
}

function Ul({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1 mt-2">
      {items.map((item, i) => (
        <li
          key={i}
          className="text-[13px] text-muted-foreground leading-relaxed flex items-start gap-2"
        >
          <span className="text-border mt-[7px] shrink-0">–</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function ExampleBlock({ examples }: { examples: string[] }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3.5 py-3 mt-3 space-y-1.5">
      {examples.map((ex, i) => (
        <div
          key={i}
          className="flex items-start gap-2 text-[12px] text-muted-foreground"
        >
          <ArrowRightIcon className="size-3 mt-[3px] shrink-0 opacity-40" />
          <span className="italic">{ex}</span>
        </div>
      ))}
    </div>
  );
}

function StatusLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {label}
    </span>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold text-muted-foreground mt-px">
        {n}
      </span>
      <div className="pb-4">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="text-[12px] text-muted-foreground mt-0.5 leading-relaxed">
          {children}
        </p>
      </div>
    </div>
  );
}

export function HelpPage() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<string>(sections[0].id);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const handleScroll = () => {
      const scrollTop = container.scrollTop + 80;
      let current: string = sections[0].id;

      for (const section of sections) {
        const el = document.getElementById(`help-${section.id}`);
        if (el && el.offsetTop <= scrollTop) {
          current = section.id;
        }
      }
      setActiveSection(current);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollTo = (id: string) => {
    const el = document.getElementById(`help-${id}`);
    const container = scrollRef.current;
    if (el && container) {
      container.scrollTo({ top: el.offsetTop - 24, behavior: "smooth" });
    }
  };

  return (
    <div className="h-full flex">
      {/* Sidebar */}
      <aside className="hidden lg:flex w-52 shrink-0 border-r flex-col">
        <div className="p-4 pb-3 border-b">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <BotIcon className="size-4" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight">Help</h1>
              <p className="text-[11px] text-muted-foreground">
                LeadBot
              </p>
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <SidebarNav activeSection={activeSection} onSelect={scrollTo} />
        </div>
      </aside>

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-6 py-8 space-y-8">
          {/* Mobile header */}
          <div className="lg:hidden">
            <h1 className="text-lg font-bold tracking-tight">
              LeadBot
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              Documentation and feature reference
            </p>
          </div>

          {/* ───── Overview ───── */}
          <section className="space-y-2">
            <H2 id="overview">Overview</H2>
            <P>
              The LeadBot is an AI assistant that helps you find leads,
              create content, send outreach messages, and manage your sales
              pipeline across social media platforms.
            </P>
            <P>
              It comes equipped with built-in tools for web search, browser
              automation, lead management, outreach, file management, and image
              generation. Platform-specific capabilities can be added via
              installable skills.
            </P>
          </section>

          <hr className="border-border" />

          {/* ───── Capabilities ───── */}
          <section className="space-y-2">
            <H2 id="capabilities">Capabilities</H2>
            <P>
              The assistant has access to several tool groups that can be
              individually toggled on or off in the chat toolbar.
            </P>

            <H3>Lead Discovery & Qualification</H3>
            <P>
              Search across platforms and the web to find potential customers.
              The agent identifies high-intent prospects based on content and
              engagement patterns.
            </P>
            <ExampleBlock
              examples={[
                '"Find people interested in skincare products"',
                '"Search for users asking about CRM tools"',
                '"Who commented on competitor posts recently?"',
              ]}
            />

            <H3>Lead Enrichment</H3>
            <P>
              Research leads via web search and profile data. Discovers bio,
              follower count, location, and content topics, then calculates a
              lead score (0–100) based on intent signals, engagement, and
              product fit.
            </P>

            <H3>Outreach & Messaging</H3>
            <P>
              Send personalized messages to leads via direct message, comment,
              or email. Messages can require approval before sending. The agent
              tracks delivery status and monitors for replies.
            </P>

            <H3>Content Creation</H3>
            <P>
              Create platform-optimized posts tailored to your target audience.
              The agent adapts tone, format, and style based on the platform
              and your brand voice.
            </P>

            <H3>Cover Image Generation</H3>
            <P>
              Generate portrait-oriented cover images for social media posts.
              Supports styles like flat illustration, photorealistic,
              watercolor, and minimalist. Images are auto-saved to project files.
            </P>

            <H3>Web Search & Browsing</H3>
            <P>
              Search the web for trends, competitor analysis, and industry
              insights. Fetch full web pages for deeper research, or use the
              browser tool for interactive browsing via the companion agent.
            </P>

            <H3>File & Knowledge Management</H3>
            <P>
              Create, read, update, search, and organize project files. Supports
              folders, drag-and-drop uploads, full-text search, and in-browser
              previews for markdown, images, and text.
            </P>

            <H3>Sub-Agent Delegation</H3>
            <P>
              The agent can spawn autonomous sub-agents for complex multi-step
              tasks like enriching many leads or conducting in-depth research.
              Sub-agents run in the background with live progress tracking.
            </P>

            <H3>Tool groups</H3>
            <P>
              Toggle these groups on or off in the chat toolbar to control which
              capabilities the agent can use:
            </P>
            <Ul
              items={[
                "Sub Agents — delegate tasks to parallel background workers",
                "Lead Management — save, update, and enrich leads",
                "File Operations — create, read, edit, search, and organize files",
                "Web & Browse — web search, URL fetching, and interactive browser control",
                "Image Generation — create cover images for posts",
                "Outreach — draft and send messages to leads",
                "Scheduling — create and manage automated tasks",
              ]}
            />
          </section>

          <hr className="border-border" />

          {/* ───── Skills ───── */}
          <section className="space-y-2">
            <H2 id="skills">Skills</H2>
            <div className="flex items-start gap-2 mb-2">
              <PuzzleIcon className="size-4 text-muted-foreground mt-0.5 shrink-0" />
              <P>
                Skills are installable extensions that add platform-specific
                capabilities to the agent. Install and manage them from the
                Settings page.
              </P>
            </div>

            <H3>Available skills</H3>
            <div className="mt-3 space-y-2">
              {[
                {
                  name: "RedNote (Xiaohongshu)",
                  desc: "Search posts and users, view profiles, send DMs, create posts, and comment on the RedNote platform.",
                },
                {
                  name: "LinkedIn",
                  desc: "Search people, view profiles, send connection requests and messages, and create posts.",
                },
                {
                  name: "X / Twitter",
                  desc: "Search posts and users, view profiles, send DMs, create tweets, reply, and quote tweet.",
                },
                {
                  name: "Instagram",
                  desc: "Search users and hashtags, view profiles, send DMs, create posts, and comment.",
                },
                {
                  name: "Google Maps",
                  desc: "Search businesses, view details, and extract contact info for B2B lead generation.",
                },
              ].map((skill) => (
                <div
                  key={skill.name}
                  className="flex items-start gap-3 text-[13px]"
                >
                  <span className="font-medium text-[12px] text-foreground shrink-0 mt-px w-36">
                    {skill.name}
                  </span>
                  <span className="text-muted-foreground leading-relaxed">
                    {skill.desc}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex items-start gap-2 mt-4 text-muted-foreground">
              <ShieldIcon className="size-3.5 mt-0.5 shrink-0" />
              <p className="text-[12px] leading-relaxed">
                Some skills require browser automation via the companion agent.
                Make sure the companion is connected before using
                platform-specific features.
              </p>
            </div>
          </section>

          <hr className="border-border" />

          {/* ───── Browser Automation ───── */}
          <section className="space-y-2">
            <H2 id="browser">Browser Automation</H2>
            <div className="flex items-start gap-2 mb-2">
              <MonitorIcon className="size-4 text-muted-foreground mt-0.5 shrink-0" />
              <P>
                The companion agent is a desktop application that gives the AI
                assistant control over a real browser. This enables interactive
                web actions like logging into platforms, navigating pages, and
                taking screenshots.
              </P>
            </div>

            <H3>How it works</H3>
            <Ul
              items={[
                "Download and run the companion app on your computer",
                "It connects to the server via WebSocket and launches a Chrome instance",
                "The AI agent can navigate, click, type, scroll, and take screenshots",
                "Use it for platform logins (e.g. QR code scans), data extraction, and interactive browsing",
              ]}
            />

            <H3>Browser actions</H3>
            <Ul
              items={[
                "Navigate to URLs, go back/forward, reload",
                "Click, type, hover, and select elements on the page",
                "Take snapshots (accessibility tree) and screenshots",
                "Manage tabs — open, switch, and close",
                "Run custom JavaScript on the page",
              ]}
            />

            <P>
              Configure the companion connection in Settings. The status
              indicator shows whether the companion is connected and ready.
            </P>
          </section>

          <hr className="border-border" />

          {/* ───── Chat Interface ───── */}
          <section className="space-y-2">
            <H2 id="chat">Chat Interface</H2>
            <P>
              The chat is your primary way to interact with the assistant. It
              supports streaming responses and multiple conversations, each with
              its own history.
            </P>
            <Ul
              items={[
                "Tool toggles — enable or disable tool groups: Sub Agents, Lead Management, File Operations, Web & Browse, Image Generation, Outreach, Scheduling",
                "Screenshot parsing — upload a screenshot and the assistant extracts text, handles, and data using vision AI",
                "Multiple conversations — create separate threads via the sidebar",
              ]}
            />
          </section>

          <hr className="border-border" />

          {/* ───── Lead Pipeline ───── */}
          <section className="space-y-2">
            <H2 id="pipeline">Lead Pipeline</H2>
            <P>
              Every lead flows through a structured pipeline. The agent tracks
              status, priority, follow-up dates, and scores to keep you
              organized.
            </P>

            <div className="flex flex-wrap gap-1.5 mt-3">
              <StatusLabel label="New" />
              <StatusLabel label="Contacted" />
              <StatusLabel label="Replied" />
              <StatusLabel label="Converted" />
              <StatusLabel label="Dropped" />
            </div>

            <H3>Tracked per lead</H3>
            <Ul
              items={[
                "Priority (low / medium / high)",
                "Lead score (0–100, set by the agent)",
                "Platform & handle",
                "Interest category & tags",
                "Follow-up date with overdue alerts",
                "Source, notes, and last interaction timestamp",
              ]}
            />

            <H3>Scoring factors</H3>
            <Ul
              items={[
                "Purchase intent signals",
                "Engagement level",
                "Follower count & influence",
                "Product/market fit",
                "Content topic relevance",
                "Recency of activity",
              ]}
            />

            <H3>Pipeline features</H3>
            <Ul
              items={[
                "Filter by status tab (All, New, Contacted, …)",
                "Visual pipeline bar showing distribution across statuses",
                "Batch actions: change status or delete multiple leads at once",
                "Overdue follow-ups bubble to the top with alerts",
              ]}
            />
          </section>

          <hr className="border-border" />

          {/* ───── Outreach ───── */}
          <section className="space-y-2">
            <H2 id="outreach">Outreach & Messaging</H2>
            <P>
              The assistant can send messages to leads on your behalf and track
              the full conversation. Enable outreach approval in Settings to
              review messages before they are sent.
            </P>
            <Ul
              items={[
                "Channels: direct message, comment, or email — platform-specific delivery is handled by skills",
                "Approval workflow: optionally require your approval before any message is sent",
                "Reply tracking: the agent checks for new replies and logs them on each lead",
                "Outreach history: full message timeline per lead with status (pending → approved → sent → delivered → replied / failed)",
              ]}
            />
            <div className="flex items-start gap-2 mt-3 text-muted-foreground">
              <ShieldIcon className="size-3.5 mt-0.5 shrink-0" />
              <p className="text-[12px] leading-relaxed">
                Outreach approval can be toggled in Settings. Platform-specific
                channels (e.g. RedNote DMs, LinkedIn messages) require the
                corresponding skill to be installed and the companion to be
                connected.
              </p>
            </div>
          </section>

          <hr className="border-border" />

          {/* ───── Automation ───── */}
          <section className="space-y-2">
            <H2 id="automation">Automated Tasks</H2>
            <P>
              Schedule the agent to run tasks automatically in the background.
              Define a prompt and a schedule, and the agent executes it on a
              recurring basis.
            </P>
            <Ul
              items={[
                "Intervals: every 30m, 1h, 2h, 6h, 12h, 1d — or custom cron expressions",
                "Run history: view past results, errors, and summaries with links to the chat where each run executed",
                "Manual trigger: run any task immediately with the \"Run Now\" button",
                "Enable or disable automation globally in Settings",
              ]}
            />

            <H3>Project Heartbeat</H3>
            <P>
              Every project includes a built-in "Project Heartbeat" task that
              runs every 2 hours. It follows your{" "}
              <code className="text-[12px] font-mono text-foreground">
                heartbeat.md
              </code>{" "}
              checklist to monitor leads and follow-ups, and only notifies you
              when something needs attention.
            </P>

            <ExampleBlock
              examples={[
                '"Alert me if any contacted lead hasn\'t replied in 3+ days"',
                '"Search for new posts mentioning our product category daily"',
                '"Summarize pipeline changes every morning"',
              ]}
            />
          </section>

          <hr className="border-border" />

          {/* ───── Getting Started ───── */}
          <section className="space-y-2">
            <H2 id="getting-started">Getting Started</H2>
            <div className="mt-3 space-y-0">
              <Step n={1} title="Set up your product profile">
                Tell the agent about your product, target audience, pricing, and
                USPs. It saves this to product.md and project.md for future
                reference.
              </Step>
              <Step n={2} title="Install skills & connect the companion">
                Go to Settings to install platform skills (e.g. LinkedIn,
                Instagram) and set up the companion agent for browser
                automation. This unlocks platform-specific search and outreach.
              </Step>
              <Step n={3} title="Discover leads">
                Ask the agent to search for potential customers by topic,
                keyword, or competitor. It saves relevant users to your pipeline.
              </Step>
              <Step n={4} title="Enrich & score leads">
                The agent researches each lead's profile, calculates a fit
                score, and suggests outreach strategies. Use sub-agents to
                enrich multiple leads at once.
              </Step>
              <Step n={5} title="Send outreach">
                Enable outreach in Settings, then ask the agent to draft and
                send personalized messages. Optionally require approval before
                messages are sent.
              </Step>
              <Step n={6} title="Automate follow-ups">
                Set up scheduled tasks to monitor your pipeline, check for
                overdue follow-ups, scan for replies, and discover new leads on
                autopilot.
              </Step>
            </div>
          </section>

          <hr className="border-border" />

          {/* ───── Knowledge Files ───── */}
          <section className="space-y-2">
            <H2 id="knowledge">Knowledge Files</H2>
            <P>
              The agent maintains special files that persist context across
              conversations. These are created automatically with each new
              project and can be viewed or edited on the Files page.
            </P>

            <div className="mt-3 space-y-2">
              {[
                {
                  name: "product.md",
                  desc: "Single source of truth — product name, audience, features, pricing, USPs, objection handling, competitor info.",
                },
                {
                  name: "project.md",
                  desc: "Living knowledge base — goals, target market, content strategy, brand voice, campaign notes.",
                },
                {
                  name: "memory.md",
                  desc: "Key facts and preferences the agent should remember across all conversations.",
                },
                {
                  name: "heartbeat.md",
                  desc: "Monitoring checklist for the automated Project Heartbeat — what to check and when to alert.",
                },
              ].map((file) => (
                <div
                  key={file.name}
                  className="flex items-start gap-3 text-[13px]"
                >
                  <code className="font-mono font-medium text-[12px] text-foreground shrink-0 mt-px w-24">
                    {file.name}
                  </code>
                  <span className="text-muted-foreground leading-relaxed">
                    {file.desc}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <hr className="border-border" />

          {/* ───── Tips ───── */}
          <section className="space-y-2 pb-8">
            <H2 id="tips">Tips</H2>
            <div className="mt-2 space-y-2">
              {[
                "Be specific about your target audience — the agent gives better results with clear context.",
                "Set up product.md early — it shapes all outreach and content the agent creates.",
                "Install platform skills before asking the agent to search or interact on specific platforms.",
                "Make sure the companion agent is running and connected before using browser-dependent features.",
                "Use follow-up dates on leads so the agent can remind you when they're overdue.",
                "Combine search + enrichment: find leads first, then enrich the top ones.",
                "Use sub-agents for bulk work like enriching 10+ leads — they run in parallel.",
                "Toggle off unused tool groups in the chat toolbar to keep the agent focused.",
                "Schedule a daily automation to check for overdue follow-ups and new opportunities.",
                "Upload screenshots of profiles or chats — the agent extracts handles and text.",
                "Enable outreach approval in Settings to review messages before they're sent.",
              ].map((tip, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2.5 text-[13px] text-muted-foreground leading-relaxed"
                >
                  <span className="font-mono text-[11px] text-border mt-px shrink-0">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>{tip}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
