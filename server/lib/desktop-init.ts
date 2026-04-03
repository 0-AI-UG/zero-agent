import { db, generateId } from "@/db/index.ts";
import { DESKTOP_MODE } from "@/lib/auth.ts";
import { insertProjectMember } from "@/db/queries/members.ts";
import { insertFile } from "@/db/queries/files.ts";
import { indexFileContent } from "@/db/queries/search.ts";
import { insertChat } from "@/db/queries/chats.ts";
import { insertChatMessage } from "@/db/queries/messages.ts";
import { writeToS3 } from "@/lib/s3.ts";
import { createHeartbeatTask } from "@/lib/heartbeat.ts";
import { createDefaultTasks } from "@/lib/default-tasks.ts";
import { log } from "@/lib/logger.ts";

const initLog = log.child({ module: "desktop-init" });

export async function initDesktopUser() {
  if (!DESKTOP_MODE) return;

  const existing = db.query<{ id: string }, [string]>(
    "SELECT id FROM users WHERE id = ?",
  ).get("desktop-user");

  if (!existing) {
    const hash = await Bun.password.hash(crypto.randomUUID(), "bcrypt");
    db.run(
      "INSERT INTO users (id, email, password_hash, is_admin) VALUES (?, ?, ?, 1)",
      ["desktop-user", "desktop@local", hash],
    );
    initLog.info("created desktop user");
  }

  const projectCount = db.query<{ count: number }, []>(
    "SELECT COUNT(*) as count FROM projects",
  ).get();

  if ((projectCount?.count ?? 0) === 0) {
    const projectId = generateId();
    const projectName = "My Project";
    db.run(
      "INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)",
      [projectId, "desktop-user", projectName],
    );
    insertProjectMember(projectId, "desktop-user", "owner");

    await createDefaultProjectFiles(projectId, projectName);

    const chat = insertChat(projectId, "Getting Started", "desktop-user");
    const onboardingMessage = {
      id: generateId(),
      role: "assistant",
      parts: [
        {
          type: "text",
          text: `Welcome to ${projectName}! I'm your AI assistant — I can browse the web, manage files, run code, and automate tasks for you.\n\nTo help me be most useful, tell me a bit about this project:\n\n1. **What are you working on?** A brief description of the project or goal.\n2. **How can I help?** What kind of tasks do you see me handling — research, writing, coding, organizing, something else?\n3. **Any preferences?** For example: keep responses short, always cite sources, be proactive with suggestions, etc.\n\nYou can answer all at once or just start with what matters most — I'll learn as we go.`,
        },
      ],
      metadata: {
        onboardingSuggestions: [
          { text: "Here's what this project is about", icon: "package", description: "Describe your project so I can tailor my help" },
          { text: "Help me research something", icon: "search", description: "Find and summarize information on a topic" },
          { text: "Set up my preferences", icon: "target", description: "Tell me how you like to work" },
        ],
      },
    };
    insertChatMessage(
      onboardingMessage.id,
      projectId,
      chat.id,
      "assistant",
      JSON.stringify(onboardingMessage),
    );

    createHeartbeatTask(projectId, "desktop-user");
    createDefaultTasks(projectId, "desktop-user");
    initLog.info("created default project", { projectId });
  }
}

async function createDefaultProjectFiles(projectId: string, projectName: string): Promise<void> {
  const memoryMd = `# Memory

## Facts

_No entries yet._

## Preferences

_No entries yet._

## Decisions

_No entries yet._
`;
  const heartbeatMd = `# Heartbeat Checklist

Items the assistant checks during each automatic heartbeat run.
Edit this file to add or remove checks.

- [ ] Check for any pending tasks or updates
`;

  const soulMd = `# Soul

## Name & Role
You are a helpful AI assistant.

## Personality
- Friendly and professional
- Concise and clear communicator
- Proactive in suggesting next steps

## Rules
- Always be honest about limitations
- Never fabricate information
- Ask for clarification when the request is ambiguous

## Output Format
- Use markdown formatting for structured content
- Keep responses focused and actionable
`;

  const files = [
    { path: "soul.md", content: soulMd },
    { path: "memory.md", content: memoryMd },
    { path: "heartbeat.md", content: heartbeatMd },
  ];

  for (const file of files) {
    const s3Key = `projects/${projectId}/${file.path}`;
    const buffer = Buffer.from(file.content, "utf-8");
    await writeToS3(s3Key, buffer);
    const fileRow = insertFile(projectId, s3Key, file.path, "text/markdown", buffer.length, "/");
    indexFileContent(fileRow.id, projectId, file.path, file.content);
  }
}
