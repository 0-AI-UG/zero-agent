import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { ArrowLeftIcon, CheckIcon, CopyIcon } from "lucide-react";

/* ─── tiny palette refs for mockup SVGs ─── */
const C = {
  bg: "var(--background)",
  fg: "var(--foreground)",
  muted: "var(--muted)",
  mutedFg: "var(--muted-foreground)",
  border: "var(--border)",
  primary: "var(--primary)",
  primaryFg: "var(--primary-foreground)",
  card: "var(--card)",
  accent: "var(--accent)",
};

/* ─── Section wrapper ─── */
function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5">
      <div className="text-center max-w-md mx-auto">
        <h2 className="text-base font-semibold tracking-tight font-display">
          {title}
        </h2>
        <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
      </div>
      <div className="flex justify-center">{children}</div>
    </section>
  );
}

/* ─── Mockup frame ─── */
function MockupFrame({
  children,
  width = 520,
  height = 320,
}: {
  children: React.ReactNode;
  width?: number;
  height?: number;
}) {
  return (
    <div
      className="rounded-xl border shadow-sm overflow-hidden bg-card"
      style={{ width: "100%", maxWidth: width }}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ display: "block" }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <style>{`
          .t-xs { font: 500 9px 'DM Sans', system-ui, sans-serif; }
          .t-sm { font: 400 10px 'DM Sans', system-ui, sans-serif; }
          .t-base { font: 600 11px 'DM Sans', system-ui, sans-serif; }
          .t-lg { font: 700 13px 'Bricolage Grotesque', 'DM Sans', system-ui, sans-serif; }
          .t-muted { fill: ${C.mutedFg}; }
          .t-fg { fill: ${C.fg}; }
          .t-primary { fill: ${C.primary}; }
          .t-primaryFg { fill: ${C.primaryFg}; }
        `}</style>
        {/* Background */}
        <rect width={width} height={height} fill={C.bg} />
        {children}
      </svg>
    </div>
  );
}

/* ────────────────────────────────────────────────────────
   MOCKUP: Project Dashboard
   ──────────────────────────────────────────────────────── */
function MockupDashboard() {
  return (
    <MockupFrame width={520} height={280}>
      {/* Header bar */}
      <rect y={0} width={520} height={40} fill={C.bg} />
      <line x1={0} y1={40} x2={520} y2={40} stroke={C.border} strokeWidth={1} />
      <text x={20} y={26} className="t-lg t-fg">Projects</text>
      {/* + button */}
      <rect x={440} y={11} width={60} height={22} rx={6} fill={C.primary} />
      <text x={455} y={26} className="t-xs t-primaryFg">+ New</text>

      {/* Search */}
      <rect x={20} y={54} width={160} height={28} rx={7} fill={C.muted} />
      <text x={36} y={72} className="t-sm t-muted">Search projects...</text>

      {/* Project cards grid (3 cols) */}
      {[0, 1, 2].map((col) => {
        const x = 20 + col * 166;
        const colors = ["oklch(0.65 0.15 220)", "oklch(0.65 0.15 140)", "oklch(0.65 0.15 30)"];
        const names = ["Marketing AI", "Sales Pipeline", "Product Launch"];
        const descs = ["Content strategy & scheduling", "Lead research & outreach", "Launch campaign planning"];
        return (
          <g key={col}>
            <rect x={x} y={100} width={154} height={90} rx={10} fill={C.card} stroke={C.border} strokeWidth={1} />
            {/* Color accent dot */}
            <circle cx={x + 16} cy={120} r={5} fill={colors[col]} />
            <text x={x + 28} y={124} className="t-base t-fg">{names[col]}</text>
            <text x={x + 14} y={142} className="t-xs t-muted">{descs[col]}</text>
            <text x={x + 14} y={176} className="t-xs t-muted">Updated 2h ago</text>
          </g>
        );
      })}

      {/* Annotation arrow + label */}
      <line x1={460} y1={55} x2={460} y2={24} stroke={C.primary} strokeWidth={1.5} markerEnd="url(#arrowP)" opacity={0.7} />
      <text x={390} y={68} className="t-xs t-primary">Create project</text>
      <defs>
        <marker id="arrowP" viewBox="0 0 10 10" refX={8} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={C.primary} />
        </marker>
      </defs>

      {/* Bottom hint */}
      <text x={260} y={240} textAnchor="middle" className="t-xs t-muted">
        Each project has its own chat, files, tasks, and skills
      </text>
    </MockupFrame>
  );
}

/* ────────────────────────────────────────────────────────
   MOCKUP: Chat Interface
   ──────────────────────────────────────────────────────── */
function MockupChat() {
  return (
    <MockupFrame width={520} height={360}>
      {/* Left nav rail */}
      <rect x={0} y={0} width={44} height={360} fill={C.muted} />
      <line x1={44} y1={0} x2={44} y2={360} stroke={C.border} strokeWidth={1} />
      {/* Nav rail items */}
      {[
        { y: 16, label: "M", emoji: "💬" },
        { y: 56, label: "F", emoji: "📁" },
        { y: 96, label: "T", emoji: "⏰" },
        { y: 136, label: "S", emoji: "🧩" },
        { y: 176, label: "⚙", emoji: "⚙️" },
      ].map((item, i) => (
        <g key={i}>
          <rect
            x={6}
            y={item.y}
            width={32}
            height={32}
            rx={8}
            fill={i === 0 ? C.accent : "transparent"}
          />
          {i === 0 && (
            <rect x={2} y={item.y + 8} width={2} height={16} rx={1} fill={C.primary} />
          )}
          <text x={22} y={item.y + 20} textAnchor="middle" className="t-xs t-muted">
            {["Chat", "Files", "Tasks", "Skills", "Set."][i]}
          </text>
        </g>
      ))}

      {/* Chat area */}
      {/* User message */}
      <rect x={280} y={30} width={210} height={36} rx={10} fill={C.muted} />
      <text x={296} y={52} className="t-sm t-fg">
        Find AI startups in healthcare
      </text>

      {/* Assistant response */}
      <text x={64} y={92} className="t-sm t-fg">I found 12 relevant startups. Here are the</text>
      <text x={64} y={106} className="t-sm t-fg">top results based on funding and relevance:</text>
      {/* Result cards */}
      {[0, 1, 2].map((i) => {
        const y = 120 + i * 34;
        const items = [
          { name: "MedAI Corp", desc: "AI diagnostics — Series B" },
          { name: "HealthBot", desc: "Patient triage assistant — Seed" },
          { name: "CareStack", desc: "Clinical workflow AI — Series A" },
        ];
        const item = items[i]!;
        return (
          <g key={i}>
            <rect x={64} y={y} width={380} height={28} rx={6} fill={C.card} stroke={C.border} strokeWidth={0.5} />
            <text x={78} y={y + 17} className="t-xs t-fg">{item.name}</text>
            <text x={160} y={y + 17} className="t-xs t-muted">{item.desc}</text>
          </g>
        );
      })}

      {/* Tool activity indicator */}
      <rect x={64} y={230} width={160} height={20} rx={5} fill={C.muted} opacity={0.6} />
      <circle cx={76} cy={240} r={3} fill="oklch(0.65 0.18 140)" />
      <text x={84} y={244} className="t-xs t-muted">Searching the web...</text>

      {/* Input area */}
      <line x1={44} y1={290} x2={520} y2={290} stroke={C.border} strokeWidth={1} />
      <rect x={60} y={300} width={400} height={36} rx={10} fill={C.muted} />
      <text x={78} y={322} className="t-sm t-muted">Ask your assistant...</text>
      {/* Send button */}
      <rect x={468} y={304} width={28} height={28} rx={7} fill={C.primary} />
      <text x={478} y={322} className="t-xs t-primaryFg">↵</text>

      {/* Toolbar below input */}
      <g transform="translate(64, 344)">
        {["Tools", "Model", "Files"].map((label, i) => (
          <g key={i}>
            <rect x={i * 56} y={0} width={50} height={16} rx={4} fill={C.muted} />
            <text x={i * 56 + 25} y={11} textAnchor="middle" className="t-xs t-muted">{label}</text>
          </g>
        ))}
      </g>
    </MockupFrame>
  );
}

/* ────────────────────────────────────────────────────────
   MOCKUP: Tool Toggles
   ──────────────────────────────────────────────────────── */
function MockupToolToggles() {
  return (
    <MockupFrame width={340} height={230}>
      {/* Popover-like container */}
      <rect x={20} y={16} width={300} height={198} rx={10} fill={C.card} stroke={C.border} strokeWidth={1} />
      <text x={36} y={40} className="t-base t-fg">Tool Groups</text>
      <text x={36} y={54} className="t-xs t-muted">Toggle capabilities on or off</text>

      {/* Toggle rows */}
      {[
        { label: "Sub Agents", desc: "Background workers", on: true },
        { label: "File Operations", desc: "Create, edit, search", on: true },
        { label: "Web & Browse", desc: "Search & interact", on: true },
        { label: "Image Generation", desc: "Cover images", on: false },
        { label: "Scheduling", desc: "Automated tasks", on: true },
      ].map((tool, i) => {
        const y = 68 + i * 28;
        return (
          <g key={i}>
            <text x={36} y={y + 12} className="t-xs t-fg">{tool.label}</text>
            <text x={160} y={y + 12} className="t-xs t-muted">{tool.desc}</text>
            {/* Toggle switch */}
            <rect
              x={284}
              y={y}
              width={24}
              height={14}
              rx={7}
              fill={tool.on ? C.primary : C.muted}
            />
            <circle
              cx={tool.on ? 302 : 290}
              cy={y + 7}
              r={5}
              fill={tool.on ? C.primaryFg : C.mutedFg}
            />
          </g>
        );
      })}
    </MockupFrame>
  );
}

/* ────────────────────────────────────────────────────────
   MOCKUP: Files Page
   ──────────────────────────────────────────────────────── */
function MockupFiles() {
  return (
    <MockupFrame width={520} height={280}>
      {/* Split layout line */}
      <line x1={240} y1={0} x2={240} y2={280} stroke={C.border} strokeWidth={1} />

      {/* Left panel - file list */}
      <text x={16} y={28} className="t-lg t-fg">Files</text>
      {/* Action buttons */}
      <rect x={160} y={12} width={22} height={22} rx={5} fill={C.muted} />
      <text x={167} y={27} className="t-xs t-muted">+</text>
      <rect x={186} y={12} width={22} height={22} rx={5} fill={C.muted} />
      <text x={191} y={27} className="t-xs t-muted">↑</text>

      {/* Storage info */}
      <text x={16} y={48} className="t-xs t-muted">8 files · 2.4 MB</text>

      {/* Search */}
      <rect x={16} y={56} width={210} height={24} rx={6} fill={C.muted} />
      <text x={30} y={72} className="t-xs t-muted">Search files...</text>

      {/* File list */}
      {[
        { icon: "📄", name: "soul.md", size: "2.1 KB", selected: false },
        { icon: "📄", name: "memory.md", size: "1.8 KB", selected: false },
        { icon: "📄", name: "heartbeat.md", size: "0.9 KB", selected: true },
        { icon: "📁", name: "research/", size: "3 files", selected: false },
        { icon: "🖼", name: "cover.png", size: "340 KB", selected: false },
      ].map((file, i) => {
        const y = 90 + i * 30;
        return (
          <g key={i}>
            {file.selected && <rect x={4} y={y - 2} width={232} height={26} rx={5} fill={C.accent} />}
            <text x={16} y={y + 14} className="t-xs">{file.icon}</text>
            <text x={34} y={y + 14} className={`t-xs ${file.selected ? "t-fg" : "t-fg"}`}>
              {file.name}
            </text>
            <text x={180} y={y + 14} className="t-xs t-muted">{file.size}</text>
          </g>
        );
      })}

      {/* Right panel - preview */}
      <text x={256} y={28} className="t-base t-fg">heartbeat.md</text>
      <line x1={240} y1={40} x2={520} y2={40} stroke={C.border} strokeWidth={0.5} />
      {/* Markdown preview content */}
      {[
        "# Project Heartbeat",
        "",
        "## Check every 2 hours:",
        "- [ ] Review pending tasks",
        "- [ ] Check for new mentions",
        "- [x] Monitor competitor activity",
        "",
        "## Alert when:",
        "- Tasks overdue > 3 days",
        "- New high-priority items found",
      ].map((line, i) => (
        <text key={i} x={256} y={58 + i * 16} className="t-xs t-fg" opacity={line.startsWith("#") ? 1 : 0.7}>
          {line}
        </text>
      ))}

      {/* Annotation */}
      <text x={380} y={270} textAnchor="middle" className="t-xs t-primary">
        Preview & edit files in-browser
      </text>
    </MockupFrame>
  );
}

/* ────────────────────────────────────────────────────────
   MOCKUP: Automation / Tasks
   ──────────────────────────────────────────────────────── */
function MockupAutomation() {
  return (
    <MockupFrame width={480} height={300}>
      {/* Header */}
      <text x={20} y={28} className="t-lg t-fg">Automation</text>
      <rect x={390} y={10} width={72} height={24} rx={6} fill={C.primary} />
      <text x={406} y={26} className="t-xs t-primaryFg">+ New Task</text>

      {/* Task card 1 */}
      <rect x={20} y={48} width={440} height={80} rx={8} fill={C.card} stroke={C.border} strokeWidth={1} />
      {/* Active indicator */}
      <circle cx={36} cy={68} r={4} fill="oklch(0.65 0.18 140)" />
      <text x={46} y={72} className="t-base t-fg">Daily Status Report</text>
      <rect x={190} y={60} width={56} height={16} rx={4} fill={C.muted} />
      <text x={200} y={72} className="t-xs t-muted">every 1d</text>
      <text x={36} y={92} className="t-xs t-muted">Summarize project activity and alert on overdue tasks</text>
      <text x={36} y={112} className="t-xs t-muted">Last: 3h ago · Next: 21h · 14 runs</text>
      {/* Toggle */}
      <rect x={424} y={58} width={24} height={14} rx={7} fill={C.primary} />
      <circle cx={442} cy={65} r={5} fill={C.primaryFg} />

      {/* Task card 2 */}
      <rect x={20} y={140} width={440} height={80} rx={8} fill={C.card} stroke={C.border} strokeWidth={1} />
      <circle cx={36} cy={160} r={4} fill="oklch(0.65 0.18 140)" />
      <text x={46} y={164} className="t-base t-fg">Project Heartbeat</text>
      <rect x={180} y={152} width={56} height={16} rx={4} fill={C.muted} />
      <text x={190} y={164} className="t-xs t-muted">every 2h</text>
      <text x={36} y={184} className="t-xs t-muted">Monitor tasks and follow-ups, notify when attention needed</text>
      <text x={36} y={204} className="t-xs t-muted">Last: 45m ago · Next: 1h 15m · 48 runs</text>
      {/* Toggle */}
      <rect x={424} y={150} width={24} height={14} rx={7} fill={C.primary} />
      <circle cx={442} cy={157} r={5} fill={C.primaryFg} />

      {/* Run history hint */}
      <rect x={20} y={234} width={440} height={44} rx={8} fill={C.muted} opacity={0.5} />
      <text x={36} y={256} className="t-xs t-muted">▶ Run history — view past results, errors, and chat links</text>
      <text x={36} y={270} className="t-xs t-muted">Use cron expressions or presets: 30m, 1h, 2h, 6h, 12h, 1d</text>
    </MockupFrame>
  );
}

/* ────────────────────────────────────────────────────────
   MOCKUP: Skills
   ──────────────────────────────────────────────────────── */
function MockupSkills() {
  return (
    <MockupFrame width={520} height={260}>
      {/* Header */}
      <text x={20} y={28} className="t-lg t-fg">Skills</text>
      <text x={20} y={44} className="t-xs t-muted">Install platform-specific capabilities</text>
      {/* Import button */}
      <rect x={420} y={10} width={80} height={24} rx={6} fill={C.card} stroke={C.border} strokeWidth={1} />
      <text x={440} y={26} className="t-xs t-fg">⬇ Import</text>

      {/* Section label */}
      <text x={20} y={66} className="t-xs t-muted">INSTALLED</text>

      {/* Skill cards (3 col grid) */}
      {[
        { name: "LinkedIn", desc: "Search profiles, send messages", caps: ["Search", "Post", "Browse"], installed: true },
        { name: "Instagram", desc: "Content publishing, analytics", caps: ["Post", "Stories", "Browse"], installed: true },
        { name: "Twitter / X", desc: "Post, search, monitor trends", caps: ["Post", "Search", "DM"], installed: false },
      ].map((skill, i) => {
        const x = 20 + i * 166;
        return (
          <g key={i} opacity={skill.installed ? 1 : 0.5}>
            <rect x={x} y={78} width={154} height={100} rx={8} fill={C.card} stroke={C.border} strokeWidth={1} />
            {/* Status dot */}
            {skill.installed && <circle cx={x + 14} cy={96} r={3} fill="oklch(0.65 0.18 140)" />}
            <text x={x + (skill.installed ? 22 : 14)} y={100} className="t-xs t-muted">
              {skill.name.toUpperCase()}
            </text>
            <text x={x + 14} y={118} className="t-base t-fg">{skill.name}</text>
            <text x={x + 14} y={132} className="t-xs t-muted">{skill.desc}</text>
            {/* Capability badges */}
            {skill.caps.map((cap, j) => (
              <g key={j}>
                <rect x={x + 14 + j * 42} y={142} width={38} height={14} rx={4} fill={C.muted} />
                <text x={x + 14 + j * 42 + 19} y={152} textAnchor="middle" className="t-xs t-muted">{cap}</text>
              </g>
            ))}
            {/* Action */}
            {!skill.installed && (
              <g>
                <rect x={x + 14} y={162} width={50} height={14} rx={4} fill={C.primary} />
                <text x={x + 39} y={172} textAnchor="middle" className="t-xs t-primaryFg">Install</text>
              </g>
            )}
          </g>
        );
      })}

      {/* Annotation */}
      <text x={260} y={210} textAnchor="middle" className="t-xs t-muted">
        Skills add platform-specific tools and capabilities
      </text>
    </MockupFrame>
  );
}

/* ────────────────────────────────────────────────────────
   MOCKUP: Knowledge Files
   ──────────────────────────────────────────────────────── */
function MockupKnowledge() {
  return (
    <MockupFrame width={480} height={190}>
      {/* Three file cards side by side */}
      {[
        {
          name: "soul.md",
          desc: "Identity & personality",
          lines: ["# My Assistant", "Tone: professional", "Style: concise"],
        },
        {
          name: "memory.md",
          desc: "Facts & preferences",
          lines: ["Timezone: PST", "Focus: AI tools", "Prefers: dark mode"],
        },
        {
          name: "heartbeat.md",
          desc: "Monitoring checklist",
          lines: ["Check tasks daily", "Alert if overdue", "Track mentions"],
        },
      ].map((file, i) => {
        const x = 16 + i * 156;
        return (
          <g key={i}>
            <rect x={x} y={16} width={144} height={140} rx={8} fill={C.card} stroke={C.border} strokeWidth={1} />
            {/* File icon */}
            <rect x={x + 12} y={28} width={28} height={32} rx={4} fill={C.muted} />
            <text x={x + 26} y={48} textAnchor="middle" className="t-xs t-muted">📄</text>
            <text x={x + 48} y={42} className="t-base t-fg">{file.name}</text>
            <text x={x + 48} y={56} className="t-xs t-muted">{file.desc}</text>
            {/* Preview lines */}
            {file.lines.map((line, j) => (
              <text key={j} x={x + 12} y={80 + j * 16} className="t-xs t-muted" opacity={0.7}>
                {line}
              </text>
            ))}
            {/* Auto-created badge */}
            <rect x={x + 12} y={132} width={60} height={14} rx={4} fill={C.muted} />
            <text x={x + 42} y={142} textAnchor="middle" className="t-xs t-muted">auto-created</text>
          </g>
        );
      })}

      {/* Bottom note */}
      <text x={240} y={178} textAnchor="middle" className="t-xs t-muted">
        Created with each project · Editable on the Files page
      </text>
    </MockupFrame>
  );
}

/* ────────────────────────────────────────────────────────
   MOCKUP: Getting Started Flow
   ──────────────────────────────────────────────────────── */
function MockupGettingStarted() {
  return (
    <MockupFrame width={520} height={140}>
      {/* Horizontal flow: 4 steps connected by arrows */}
      {[
        { n: "1", label: "Create project", icon: "📁" },
        { n: "2", label: "Install skills", icon: "🧩" },
        { n: "3", label: "Start chatting", icon: "💬" },
        { n: "4", label: "Automate", icon: "⏰" },
      ].map((step, i) => {
        const x = 28 + i * 124;
        return (
          <g key={i}>
            {/* Step circle */}
            <rect x={x} y={24} width={96} height={80} rx={10} fill={C.card} stroke={C.border} strokeWidth={1} />
            <text x={x + 48} y={56} textAnchor="middle" style={{ fontSize: 22 }}>{step.icon}</text>
            <text x={x + 48} y={78} textAnchor="middle" className="t-xs t-fg">{step.label}</text>
            {/* Step number */}
            <circle cx={x + 48} cy={16} r={10} fill={C.primary} />
            <text x={x + 48} y={20} textAnchor="middle" className="t-xs t-primaryFg">{step.n}</text>
            {/* Arrow to next */}
            {i < 3 && (
              <line x1={x + 100} y1={64} x2={x + 120} y2={64} stroke={C.border} strokeWidth={1.5} markerEnd="url(#arrowS)" />
            )}
          </g>
        );
      })}
      <defs>
        <marker id="arrowS" viewBox="0 0 10 10" refX={8} refY={5} markerWidth={5} markerHeight={5} orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={C.border} />
        </marker>
      </defs>

      <text x={260} y={130} textAnchor="middle" className="t-xs t-muted">
        Set up your project profile early — it shapes all content and actions
      </text>
    </MockupFrame>
  );
}


/* ────────────────────────────────────────────────────────
   MOCKUP: Make It Yours (open source / Claude Code)
   ──────────────────────────────────────────────────────── */
function MockupMakeItYours() {
  return (
    <MockupFrame width={520} height={420}>
      {/* Terminal window */}
      <rect x={16} y={16} width={488} height={388} rx={10} fill="oklch(0.16 0 0)" stroke={C.border} strokeWidth={1} />
      {/* Title bar */}
      <rect x={16} y={16} width={488} height={28} rx={10} fill="oklch(0.2 0 0)" />
      <rect x={16} y={36} width={488} height={8} fill="oklch(0.2 0 0)" />
      <circle cx={32} cy={30} r={5} fill="oklch(0.65 0.18 25)" />
      <circle cx={48} cy={30} r={5} fill="oklch(0.75 0.15 90)" />
      <circle cx={64} cy={30} r={5} fill="oklch(0.65 0.15 140)" />
      <text x={260} y={34} textAnchor="middle" style={{ font: "500 10px 'DM Sans', monospace", fill: "oklch(0.5 0 0)" }}>Terminal</text>

      {/* Terminal content */}
      <g style={{ font: "400 10px 'SF Mono', 'Fira Code', monospace" }}>
        {/* Clone */}
        <text x={30} y={62} fill="oklch(0.65 0.18 140)">$</text>
        <text x={42} y={62} fill="oklch(0.85 0 0)">git clone https://github.com/0-AI-UG/zero-agent.git</text>
        <text x={30} y={78} fill="oklch(0.5 0 0)">Cloning into 'zero-agent'...</text>

        {/* cd */}
        <text x={30} y={100} fill="oklch(0.65 0.18 140)">$</text>
        <text x={42} y={100} fill="oklch(0.85 0 0)">cd zero-agent</text>

        {/* Install */}
        <text x={30} y={122} fill="oklch(0.65 0.18 140)">$</text>
        <text x={42} y={122} fill="oklch(0.85 0 0)">bun install</text>
        <text x={30} y={138} fill="oklch(0.5 0 0)">Installed 247 packages</text>

        {/* Env */}
        <text x={30} y={160} fill="oklch(0.65 0.18 140)">$</text>
        <text x={42} y={160} fill="oklch(0.85 0 0)">cp .env.example .env</text>
        <text x={30} y={176} fill="oklch(0.5 0 0)"># add your OPENROUTER_API_KEY</text>

        {/* Dev server */}
        <text x={30} y={198} fill="oklch(0.65 0.18 140)">$</text>
        <text x={42} y={198} fill="oklch(0.85 0 0)">bun run dev</text>
        <text x={30} y={214} fill="oklch(0.65 0.15 250)">API</text>
        <text x={56} y={214} fill="oklch(0.5 0 0)">listening on http://localhost:3001</text>
        <text x={30} y={230} fill="oklch(0.65 0.15 250)">WEB</text>
        <text x={56} y={230} fill="oklch(0.5 0 0)">listening on http://localhost:3000</text>

        {/* Divider */}
        <line x1={30} y1={246} x2={490} y2={246} stroke="oklch(0.3 0 0)" strokeWidth={0.5} />

        {/* Claude Code section */}
        <text x={30} y={266} fill="oklch(0.65 0.18 140)">$</text>
        <text x={42} y={266} fill="oklch(0.85 0 0)">claude</text>
        <text x={30} y={286} fill="oklch(0.75 0.12 280)">Claude Code</text>
        <text x={110} y={286} fill="oklch(0.5 0 0)">ready in zero-agent/</text>

        {/* User prompt */}
        <text x={30} y={310} fill="oklch(0.65 0.18 250)">&gt;</text>
        <text x={42} y={310} fill="oklch(0.85 0 0)">Add a Slack notification skill that alerts</text>
        <text x={42} y={326} fill="oklch(0.85 0 0)">me when automation tasks complete</text>

        {/* Claude response */}
        <text x={30} y={350} fill="oklch(0.75 0.12 280)">I'll create a new skill in skills/ that...</text>
        <rect x={30} y={360} width={120} height={6} rx={2} fill="oklch(0.75 0.12 280)" opacity={0.3} />
        <rect x={30} y={370} width={200} height={6} rx={2} fill="oklch(0.75 0.12 280)" opacity={0.2} />
        <rect x={30} y={380} width={160} height={6} rx={2} fill="oklch(0.75 0.12 280)" opacity={0.1} />
      </g>
    </MockupFrame>
  );
}

/* ────────────────────────────────────────────────────────
   MOCKUP: Project Structure
   ──────────────────────────────────────────────────────── */
function MockupProjectStructure() {
  return (
    <MockupFrame width={520} height={220}>
      {/* Folder tree */}
      <g style={{ font: "400 10px 'SF Mono', 'Fira Code', monospace" }}>
        <text x={30} y={30} fill={C.fg} style={{ fontWeight: 700 }}>zero-agent/</text>

        {[
          { indent: 1, name: "api/", desc: "Backend — Bun server, SQLite, routes", color: "oklch(0.65 0.18 250)" },
          { indent: 1, name: "web/", desc: "Frontend — React, Tailwind, shadcn/ui", color: "oklch(0.65 0.18 140)" },
          { indent: 1, name: "skills/", desc: "Extensions — add your own here", color: "oklch(0.65 0.18 300)" },
          { indent: 1, name: ".env", desc: "Your API keys (from .env.example)", color: "oklch(0.5 0 0)" },
          { indent: 1, name: "CLAUDE.md", desc: "Instructions for Claude Code", color: "oklch(0.5 0 0)" },
        ].map((item, i) => {
          const y = 52 + i * 26;
          const isFolder = item.name.endsWith("/");
          return (
            <g key={i}>
              {/* Tree line */}
              <text x={30} y={y} fill="oklch(0.4 0 0)">├─</text>
              {/* Folder/file icon */}
              <rect x={52} y={y - 12} width={14} height={14} rx={3} fill={item.color} opacity={0.15} />
              <text x={59} y={y} textAnchor="middle" style={{ fontSize: 8 }} fill={item.color}>
                {isFolder ? "D" : "F"}
              </text>
              {/* Name */}
              <text x={72} y={y} fill={C.fg} style={{ fontWeight: isFolder ? 600 : 400 }}>{item.name}</text>
              {/* Description */}
              <text x={200} y={y} fill={C.mutedFg}>{item.desc}</text>
            </g>
          );
        })}
      </g>

      {/* Bottom callout boxes */}
      <g transform="translate(0, 12)">
        {[
          { x: 30, label: "Add tools", desc: "api/tools/", color: "oklch(0.65 0.18 250)" },
          { x: 196, label: "Change UI", desc: "web/src/", color: "oklch(0.65 0.18 140)" },
          { x: 362, label: "New skills", desc: "skills/", color: "oklch(0.65 0.18 300)" },
        ].map((box, i) => (
          <g key={i}>
            <rect x={box.x} y={202 - 12} width={140} height={20} rx={6} fill={box.color} opacity={0.1} />
            <circle cx={box.x + 12} cy={202 - 2} r={3} fill={box.color} />
            <text x={box.x + 20} y={202 + 2} style={{ font: "600 9px 'DM Sans', sans-serif" }} fill={C.fg}>{box.label}</text>
            <text x={box.x + 80} y={202 + 2} style={{ font: "400 9px 'SF Mono', monospace" }} fill={C.mutedFg}>{box.desc}</text>
          </g>
        ))}
      </g>
    </MockupFrame>
  );
}

/* ────────────────────────────────────────────────────────
   Quick Start Prompt (copy to clipboard)
   ──────────────────────────────────────────────────────── */
const CLAUDE_CODE_PROMPT = `Clone the zero-agent repo from https://github.com/0-AI-UG/zero-agent.git and set it up for local development:

1. git clone https://github.com/0-AI-UG/zero-agent.git && cd zero-agent
2. Run bun install to install all dependencies (this is a monorepo with api/ and web/ workspaces)
3. Copy .env.example to .env — the only required key is OPENROUTER_API_KEY from https://openrouter.ai
4. Start the dev server with bun run dev (this runs the API on :3001 and the web app on :3000 concurrently with HMR)
5. Open http://localhost:3000/setup in the browser to create an admin account and configure the LLM

The project structure:
- api/ — Backend server (Bun, SQLite, S3-compatible file storage, all API routes and AI tool definitions)
- web/ — Frontend (React 19, Tailwind, shadcn/ui components, React Router)
- skills/ — Installable extensions that add platform-specific capabilities (each skill is a self-contained module)
Once setup is complete, read through the CLAUDE.md files in the root, api/, and web/ directories to understand the project conventions (Bun over Node, no Express, HTML imports, etc.).

Then ask me what I'd like to customize, add, or change about the agent. Wait for my response before making any changes.`;

function CopyPromptBlock() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(CLAUDE_CODE_PROMPT).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="w-full max-w-[520px]">
      <div className="rounded-xl border bg-card overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b bg-muted/30">
          <span className="text-xs font-medium text-muted-foreground">
            Paste this into Claude Code
          </span>
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
        {/* Prompt content */}
        <div className="px-4 py-3">
          <p className="text-[13px] leading-relaxed text-foreground">
            {CLAUDE_CODE_PROMPT}
          </p>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground text-center mt-3">
        Claude Code will set up the project and ask what you want to build
      </p>
    </div>
  );
}

/* ════════════════════════════════════════════════════════
   HELP PAGE
   ════════════════════════════════════════════════════════ */
export function HelpPage() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="shrink-0 border-b bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center h-14 px-6 max-w-5xl mx-auto w-full gap-3">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => navigate("/")}
            aria-label="Back to projects"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <h1 className="text-sm font-semibold tracking-tight font-display">
            How Zero Agent Works
          </h1>
        </div>
      </header>

      {/* Scrollable content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-10 space-y-16">
          {/* Hero */}
          <div className="text-center space-y-2">
            <h1 className="text-xl font-bold tracking-tight font-display">
              Zero Agent
            </h1>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              An AI agent for research, content creation, automation, and project management.
            </p>
          </div>

          {/* Getting Started */}
          <Section
            title="Getting Started"
            subtitle="Four steps to get up and running"
          >
            <MockupGettingStarted />
          </Section>

          {/* Projects */}
          <Section
            title="Projects"
            subtitle="Organize your work into separate projects, each with its own context"
          >
            <MockupDashboard />
          </Section>

          {/* Chat */}
          <Section
            title="Chat"
            subtitle="Your primary interface — ask the agent to research, create, and act"
          >
            <MockupChat />
          </Section>

          {/* Tool Toggles */}
          <Section
            title="Tool Groups"
            subtitle="Control which capabilities the agent can use per conversation"
          >
            <MockupToolToggles />
          </Section>

          {/* Files */}
          <Section
            title="Files"
            subtitle="Manage project files with drag-and-drop, search, and in-browser preview"
          >
            <MockupFiles />
          </Section>

          {/* Knowledge */}
          <Section
            title="Knowledge Files"
            subtitle="Auto-created files that persist context across conversations"
          >
            <MockupKnowledge />
          </Section>

          {/* Automation */}
          <Section
            title="Automation"
            subtitle="Schedule the agent to run tasks on autopilot with cron or presets"
          >
            <MockupAutomation />
          </Section>

          {/* Skills */}
          <Section
            title="Skills"
            subtitle="Add platform-specific capabilities via installable extensions"
          >
            <MockupSkills />
          </Section>

          {/* Divider */}
          <div className="flex items-center gap-4">
            <div className="flex-1 border-t" />
            <span className="text-xs text-muted-foreground font-medium">Open Source</span>
            <div className="flex-1 border-t" />
          </div>

          {/* Make it yours */}
          <Section
            title="Make It Yours"
            subtitle="Zero Agent is open source — clone, customize, and add the features you need"
          >
            <MockupMakeItYours />
          </Section>

          {/* Project structure */}
          <Section
            title="Project Structure"
            subtitle="Know where to look when adding tools, changing the UI, or building new skills"
          >
            <MockupProjectStructure />
          </Section>

          {/* Copy prompt */}
          <Section
            title="Quick Start with Claude Code"
            subtitle="Copy this prompt, paste it into Claude Code, and start building"
          >
            <CopyPromptBlock />
          </Section>

          {/* Footer spacer */}
          <div className="h-8" />
        </div>
      </main>
    </div>
  );
}
