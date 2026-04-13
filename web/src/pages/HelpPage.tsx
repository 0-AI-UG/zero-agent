import { useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  ChevronDownIcon,
  FolderIcon,
  MessageSquareIcon,
  FileTextIcon,
  ZapIcon,
  PuzzleIcon,
  BrainIcon,
  ToggleLeftIcon,
  CodeIcon,
  WrenchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/* ─── FAQ data ─── */
const FAQ_ITEMS: { q: string; a: string }[] = [
  {
    q: "What is Zero Agent?",
    a: "Zero Agent is an AI-powered assistant for research, content creation, automation, and project management. It organizes your work into projects, each with their own chat, files, tasks, and skills.",
  },
  {
    q: "How do I create a project?",
    a: 'Click the "+ New" button on the Projects page. Give your project a name and description. Each project gets its own workspace with chat, files, tasks, and skills.',
  },
  {
    q: "What are skills?",
    a: "Skills are installable extensions that add platform-specific capabilities. For example, a LinkedIn skill lets the agent search profiles and send messages. You can install skills from the Skills tab in any project.",
  },
  {
    q: "How do automations work?",
    a: 'You can schedule the agent to run tasks automatically using cron expressions or presets (30m, 1h, 2h, 6h, 12h, 1d). Create tasks from the Tasks page and enable automation in project Settings.',
  },
  {
    q: "What are knowledge files?",
    a: "Knowledge files (SOUL.md, MEMORY.md, HEARTBEAT.md) are auto-created files that persist context across conversations. SOUL.md defines identity and tone, MEMORY.md stores facts and preferences, and HEARTBEAT.md sets up monitoring checklists.",
  },
  {
    q: "Can I control which tools the agent uses?",
    a: "Yes. In any conversation you can toggle tool groups on or off — Sub Agents, File Operations, Web & Browse, Image Generation, and Scheduling. This lets you focus the agent on specific capabilities.",
  },
  {
    q: "How do I set up two-factor authentication?",
    a: "Go to Settings > Security. You can enable an authenticator app (Google Authenticator, 1Password) or add passkeys (Face ID, Touch ID, hardware keys) for additional security.",
  },
  {
    q: "Is Zero Agent open source?",
    a: "Yes. You can clone the repo, customize it, and add your own tools and skills. The codebase is organized into api/ (backend), web/ (frontend), and skills/ (extensions).",
  },
];

/* ─── Help card data ─── */
interface HelpCard {
  icon: typeof FolderIcon;
  title: string;
  description: string;
  details: string[];
}

const HELP_CARDS: HelpCard[] = [
  {
    icon: FolderIcon,
    title: "Projects",
    description: "Organize work into separate workspaces",
    details: [
      "Each project has its own chat, files, tasks, and skills",
      "Search and filter across all your projects",
      "Configure project-level settings and members",
    ],
  },
  {
    icon: MessageSquareIcon,
    title: "Chat",
    description: "Your primary interface with the agent",
    details: [
      "Ask the agent to research, create, and take actions",
      "Results are displayed inline with rich formatting",
      "Conversation history is preserved per project",
    ],
  },
  {
    icon: FileTextIcon,
    title: "Files",
    description: "Manage project files with ease",
    details: [
      "Drag-and-drop uploads with in-browser preview",
      "Search across all files in your project",
      "Edit markdown files directly in the browser",
    ],
  },
  {
    icon: BrainIcon,
    title: "Knowledge",
    description: "Persistent context across conversations",
    details: [
      "SOUL.md — Identity, personality, and tone",
      "MEMORY.md — Facts, preferences, and context",
      "HEARTBEAT.md — Monitoring checklist and alerts",
    ],
  },
  {
    icon: ZapIcon,
    title: "Automation",
    description: "Schedule the agent to run on autopilot",
    details: [
      "Cron expressions or presets: 30m, 1h, 6h, 1d",
      "View run history, errors, and chat links",
      "Toggle individual tasks on and off",
    ],
  },
  {
    icon: PuzzleIcon,
    title: "Skills",
    description: "Platform-specific capabilities",
    details: [
      "Install skills for LinkedIn, Instagram, Twitter, and more",
      "Each skill adds specialized tools and integrations",
      "Build and import your own custom skills",
    ],
  },
  {
    icon: ToggleLeftIcon,
    title: "Tool Groups",
    description: "Control agent capabilities per conversation",
    details: [
      "Toggle Sub Agents, File Operations, Web & Browse",
      "Enable or disable Image Generation and Scheduling",
      "Focus the agent on exactly what you need",
    ],
  },
  {
    icon: WrenchIcon,
    title: "Settings",
    description: "Configure project and account preferences",
    details: [
      "Manage project members and permissions",
      "Enable review mode for file changes",
      "Customize appearance and notifications",
    ],
  },
];

/* ─── Claude Code prompt ─── */
const CLAUDE_CODE_PROMPT = `Clone the zero-agent repo from https://github.com/0-AI-UG/zero-agent.git and set it up for local development:

1. git clone https://github.com/0-AI-UG/zero-agent.git && cd zero-agent
2. Run bun install to install all dependencies (this is a monorepo with api/ and web/ workspaces)
3. Copy .env.example to .env - the only required key is OPENROUTER_API_KEY from https://openrouter.ai
4. Start the dev server with bun run dev (this runs the API on :3001 and the web app on :3000 concurrently with HMR)
5. Open http://localhost:3000/setup in the browser to create an admin account and configure the LLM

The project structure:
- api/ - Backend server (Bun, SQLite, S3-compatible file storage, all API routes and AI tool definitions)
- web/ - Frontend (React 19, Tailwind, shadcn/ui components, React Router)
- skills/ - Installable extensions that add platform-specific capabilities (each skill is a self-contained module)
Once setup is complete, read through the CLAUDE.md files in the root, api/, and web/ directories to understand the project conventions (Bun over Node, no Express, HTML imports, etc.).

Then ask me what I'd like to customize, add, or change about the agent. Wait for my response before making any changes.`;

/* ─── Components ─── */

function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-border/60 last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-4 py-4 text-left group"
      >
        <span className="text-sm font-medium group-hover:text-foreground transition-colors">
          {q}
        </span>
        <ChevronDownIcon
          className={`size-4 text-muted-foreground shrink-0 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <p className="text-sm text-muted-foreground pb-4 pr-8 leading-relaxed">
          {a}
        </p>
      )}
    </div>
  );
}

function HelpCardComponent({ card }: { card: HelpCard }) {
  const Icon = card.icon;

  return (
    <div className="rounded-xl border bg-card p-5 space-y-3 hover:border-primary/30 transition-colors">
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="size-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{card.title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{card.description}</p>
        </div>
      </div>
      <ul className="space-y-1.5 pl-0.5">
        {card.details.map((detail, i) => (
          <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
            <span className="text-primary/60 mt-0.5 shrink-0">-</span>
            {detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CopyPromptBlock() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(CLAUDE_CODE_PROMPT).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <CodeIcon className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">
            Quick start with Claude Code
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <CheckIcon className="size-3" />
              Copied
            </>
          ) : (
            <>
              <CopyIcon className="size-3" />
              Copy
            </>
          )}
        </Button>
      </div>
      <div className="px-4 py-3">
        <p className="text-xs leading-relaxed text-muted-foreground font-mono whitespace-pre-wrap">
          {CLAUDE_CODE_PROMPT}
        </p>
      </div>
    </div>
  );
}

/* ─── Page ─── */

export function HelpPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 md:px-6 py-10 space-y-12">
        {/* Hero */}
        <div className="space-y-2">
          <h1 className="text-xl font-bold tracking-tight font-display">
            Help
          </h1>
          <p className="text-sm text-muted-foreground">
            Learn how Zero Agent works and get the most out of your projects.
          </p>
        </div>

        {/* Getting started cards */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold tracking-tight">Getting Started</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { step: "1", title: "Create a project", desc: "Set up a workspace with its own chat, files, and context." },
              { step: "2", title: "Install skills", desc: "Add platform-specific capabilities like LinkedIn or Instagram." },
              { step: "3", title: "Start chatting", desc: "Ask the agent to research, create content, or take actions." },
              { step: "4", title: "Automate", desc: "Schedule recurring tasks to run on autopilot." },
            ].map((item) => (
              <div key={item.step} className="rounded-xl border bg-card p-4 flex items-start gap-3">
                <div className="size-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 text-xs font-semibold text-primary">
                  {item.step}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Feature library */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold tracking-tight">Features</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {HELP_CARDS.map((card) => (
              <HelpCardComponent key={card.title} card={card} />
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold tracking-tight">Frequently Asked Questions</h2>
          <div className="rounded-xl border bg-card px-5">
            {FAQ_ITEMS.map((item, i) => (
              <FAQItem key={i} q={item.q} a={item.a} />
            ))}
          </div>
        </section>

        {/* Open source / Claude Code */}
        <section className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex-1 border-t" />
            <span className="text-xs text-muted-foreground font-medium">Open Source</span>
            <div className="flex-1 border-t" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { label: "Add tools", path: "api/tools/", color: "text-blue-500" },
              { label: "Change UI", path: "web/src/", color: "text-emerald-500" },
              { label: "New skills", path: "skills/", color: "text-violet-500" },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border bg-card p-4 flex items-center gap-3">
                <div className={`size-2 rounded-full ${item.color.replace("text-", "bg-")}`} />
                <div>
                  <p className="text-sm font-medium">{item.label}</p>
                  <p className="text-xs text-muted-foreground font-mono">{item.path}</p>
                </div>
              </div>
            ))}
          </div>

          <CopyPromptBlock />
        </section>

        {/* Bottom spacer */}
        <div className="h-4" />
      </div>
    </div>
  );
}
