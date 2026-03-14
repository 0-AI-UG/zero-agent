import { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/app.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");
db.run("PRAGMA case_sensitive_like = ON");

// Schema
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS chats (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT 'New Chat',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chat_id    TEXT REFERENCES chats(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: add chat_id column if it doesn't exist (existing DBs)
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('messages')",
  ).all();
  if (!cols.some((c) => c.name === "chat_id")) {
    db.run("ALTER TABLE messages ADD COLUMN chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE");
  }
}

// Migration: assign orphaned messages (no chat_id) to auto-created chats
{
  const orphanedProjects = db.query<{ project_id: string }, []>(
    "SELECT DISTINCT project_id FROM messages WHERE chat_id IS NULL",
  ).all();
  if (orphanedProjects.length > 0) {
    const insertChat = db.query<void, [string, string]>(
      "INSERT INTO chats (id, project_id, title) VALUES (?, ?, 'General')",
    );
    const assignMessages = db.query<void, [string, string]>(
      "UPDATE messages SET chat_id = ? WHERE project_id = ? AND chat_id IS NULL",
    );
    db.transaction(() => {
      for (const { project_id } of orphanedProjects) {
        const chatId = nanoid();
        insertChat.run(chatId, project_id);
        assignMessages.run(chatId, project_id);
      }
    })();
  }
}

db.run(`
  CREATE TABLE IF NOT EXISTS files (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    s3_key      TEXT NOT NULL,
    filename    TEXT NOT NULL,
    mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes  INTEGER DEFAULT 0,
    folder_path TEXT NOT NULL DEFAULT '/',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS folders (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, path)
  )
`);

// Migration: drop category column from files if it exists
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('files')",
  ).all();
  if (cols.some((c) => c.name === "category")) {
    db.transaction(() => {
      db.run(`CREATE TABLE files_new (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        s3_key      TEXT NOT NULL,
        filename    TEXT NOT NULL,
        mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes  INTEGER DEFAULT 0,
        folder_path TEXT NOT NULL DEFAULT '/',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run("INSERT INTO files_new (id, project_id, s3_key, filename, mime_type, size_bytes, folder_path, created_at) SELECT id, project_id, s3_key, filename, mime_type, size_bytes, folder_path, created_at FROM files");
      db.run("DROP TABLE files");
      db.run("ALTER TABLE files_new RENAME TO files");
      db.run("CREATE INDEX IF NOT EXISTS idx_files_project_folder ON files(project_id, folder_path)");
    })();
  }
}


db.run(`
  CREATE TABLE IF NOT EXISTS leads (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    source         TEXT DEFAULT '',
    notes          TEXT DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'replied', 'converted', 'dropped')),
    follow_up_date TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: add new columns to leads table
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('leads')",
  ).all();
  const colNames = cols.map((c) => c.name);
  const newCols: [string, string][] = [
    ["rednote_handle", "TEXT DEFAULT ''"],
    ["profile_url", "TEXT DEFAULT ''"],
    ["interest", "TEXT DEFAULT ''"],
    ["priority", "TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high'))"],
    ["last_interaction", "TEXT"],
    ["tags", "TEXT DEFAULT ''"],
    ["score", "INTEGER"],
    ["platform", "TEXT"],
    ["platform_handle", "TEXT"],
    ["email", "TEXT DEFAULT ''"],
  ];
  for (const [name, def] of newCols) {
    if (!colNames.includes(name)) {
      db.run(`ALTER TABLE leads ADD COLUMN ${name} ${def}`);
    }
  }
}

// Migration: populate platform/platform_handle from rednote_handle
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('leads')",
  ).all();
  const colNames = cols.map((c) => c.name);
  if (colNames.includes("platform") && colNames.includes("rednote_handle")) {
    db.run("UPDATE leads SET platform = 'rednote', platform_handle = rednote_handle WHERE rednote_handle IS NOT NULL AND rednote_handle != '' AND (platform IS NULL OR platform = '')");
  }
}

// Migration: normalize outreach_messages channels
{
  db.run("UPDATE outreach_messages SET channel = 'direct_message' WHERE channel = 'rednote_dm'");
  db.run("UPDATE outreach_messages SET channel = 'comment' WHERE channel = 'rednote_comment'");
}

// Migration: add automation_enabled column to projects
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('projects')",
  ).all();
  if (!cols.some((c) => c.name === "automation_enabled")) {
    db.run("ALTER TABLE projects ADD COLUMN automation_enabled INTEGER NOT NULL DEFAULT 0");
  }
}

// Migration: add rednote_cookies column to projects
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('projects')",
  ).all();
  if (!cols.some((c) => c.name === "rednote_cookies")) {
    db.run("ALTER TABLE projects ADD COLUMN rednote_cookies TEXT DEFAULT ''");
  }
}

// Scheduled tasks
db.run(`
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    prompt        TEXT NOT NULL,
    schedule      TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    last_run_at   TEXT,
    next_run_at   TEXT NOT NULL,
    run_count     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS task_runs (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    project_id    TEXT NOT NULL,
    chat_id       TEXT,
    status        TEXT NOT NULL DEFAULT 'running',
    summary       TEXT DEFAULT '',
    started_at    TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at   TEXT,
    error         TEXT
  )
`);

// Migration: add is_autonomous column to chats
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('chats')",
  ).all();
  if (!cols.some((c) => c.name === "is_autonomous")) {
    db.run("ALTER TABLE chats ADD COLUMN is_autonomous INTEGER NOT NULL DEFAULT 0");
  }
}

// FTS5 full-text search index for file content
db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_files USING fts5(
    file_id UNINDEXED,
    project_id UNINDEXED,
    filename,
    content,
    tokenize='unicode61'
  )
`);

// Migration: add outreach columns to projects
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('projects')",
  ).all();
  if (!cols.some((c) => c.name === "outreach_enabled")) {
    db.run("ALTER TABLE projects ADD COLUMN outreach_enabled INTEGER NOT NULL DEFAULT 1");
  }
  if (!cols.some((c) => c.name === "default_outreach_channel")) {
    db.run("ALTER TABLE projects ADD COLUMN default_outreach_channel TEXT NOT NULL DEFAULT 'manual'");
  }
  if (!cols.some((c) => c.name === "outreach_approval_required")) {
    db.run("ALTER TABLE projects ADD COLUMN outreach_approval_required INTEGER NOT NULL DEFAULT 1");
  }
  if (!cols.some((c) => c.name === "browser_search_fallback")) {
    db.run("ALTER TABLE projects ADD COLUMN browser_search_fallback INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "code_execution_enabled")) {
    db.run("ALTER TABLE projects ADD COLUMN code_execution_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "browser_automation_enabled")) {
    db.run("ALTER TABLE projects ADD COLUMN browser_automation_enabled INTEGER NOT NULL DEFAULT 1");
  }
}

// Migration: outreach_approval_required defaults to true (was false before)
db.run("UPDATE projects SET outreach_approval_required = 1 WHERE outreach_approval_required = 0");

// Migration: drop old outreach tables (sequences, steps, enrollments, templates)
db.run("DROP TABLE IF EXISTS outreach_templates");
db.run("DROP TABLE IF EXISTS sequence_enrollments");
db.run("DROP TABLE IF EXISTS sequence_steps");
db.run("DROP TABLE IF EXISTS outreach_sequences");

// Migration: recreate outreach_messages without enrollment_id/step_id, add 'rejected' status
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('outreach_messages')",
  ).all();
  if (cols.some((c) => c.name === "enrollment_id")) {
    db.transaction(() => {
      db.run(`CREATE TABLE outreach_messages_new (
        id         TEXT PRIMARY KEY,
        lead_id    TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        channel    TEXT NOT NULL DEFAULT 'manual',
        subject    TEXT DEFAULT '',
        body       TEXT NOT NULL DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'sent', 'delivered', 'failed', 'replied', 'rejected')),
        sent_at    TEXT,
        replied_at TEXT,
        error      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run("INSERT INTO outreach_messages_new (id, lead_id, project_id, channel, subject, body, status, sent_at, replied_at, error, created_at) SELECT id, lead_id, project_id, channel, subject, body, status, sent_at, replied_at, error, created_at FROM outreach_messages");
      db.run("DROP TABLE outreach_messages");
      db.run("ALTER TABLE outreach_messages_new RENAME TO outreach_messages");
    })();
  }
}

// Outreach messages table (for fresh DBs)
db.run(`
  CREATE TABLE IF NOT EXISTS outreach_messages (
    id         TEXT PRIMARY KEY,
    lead_id    TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    channel    TEXT NOT NULL DEFAULT 'manual',
    subject    TEXT DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'sent', 'delivered', 'failed', 'replied', 'rejected')),
    sent_at    TEXT,
    replied_at TEXT,
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: add 'approved' to outreach_messages status CHECK constraint
{
  // Check if the CHECK constraint already includes 'approved' by trying an insert
  // Simpler: just rebuild the table to ensure the constraint is up to date
  const sql = db.query<{ sql: string }, [string]>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
  ).get("outreach_messages");
  if (sql && !sql.sql.includes("'approved'")) {
    db.transaction(() => {
      db.run(`CREATE TABLE outreach_messages_new (
        id         TEXT PRIMARY KEY,
        lead_id    TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        channel    TEXT NOT NULL DEFAULT 'manual',
        subject    TEXT DEFAULT '',
        body       TEXT NOT NULL DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'sent', 'delivered', 'failed', 'replied', 'rejected')),
        sent_at    TEXT,
        replied_at TEXT,
        error      TEXT,
        reply_body TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.run("INSERT INTO outreach_messages_new (id, lead_id, project_id, channel, subject, body, status, sent_at, replied_at, error, reply_body, created_at) SELECT id, lead_id, project_id, channel, subject, body, status, sent_at, replied_at, error, reply_body, created_at FROM outreach_messages");
      db.run("DROP TABLE outreach_messages");
      db.run("ALTER TABLE outreach_messages_new RENAME TO outreach_messages");
    })();
  }
}

// Migration: add reply_body column to outreach_messages
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('outreach_messages')",
  ).all();
  if (!cols.some((c) => c.name === "reply_body")) {
    db.run("ALTER TABLE outreach_messages ADD COLUMN reply_body TEXT");
  }
}

// Migration: add thumbnail_s3_key column to files
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('files')",
  ).all();
  if (!cols.some((c) => c.name === "thumbnail_s3_key")) {
    db.run("ALTER TABLE files ADD COLUMN thumbnail_s3_key TEXT");
  }
}

// Project members
db.run(`
  CREATE TABLE IF NOT EXISTS project_members (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, user_id)
  )
`);

// Invitations
db.run(`
  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_email TEXT NOT NULL,
    invitee_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    responded_at TEXT
  )
`);

// Notifications
db.run(`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('invite', 'invite_accepted', 'member_removed')),
    data TEXT NOT NULL DEFAULT '{}',
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: add created_by column to chats
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('chats')",
  ).all();
  if (!cols.some((c) => c.name === "created_by")) {
    db.run("ALTER TABLE chats ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL");
  }
}

// Migration: add user_id column to messages
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('messages')",
  ).all();
  if (!cols.some((c) => c.name === "user_id")) {
    db.run("ALTER TABLE messages ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL");
  }
}

// Migration: seed project_members from existing projects (owner role)
{
  const unseeded = db.query<{ id: string; user_id: string }, []>(
    "SELECT p.id, p.user_id FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.role = 'owner' WHERE pm.id IS NULL",
  ).all();
  if (unseeded.length > 0) {
    const insertMember = db.query<void, [string, string, string]>(
      "INSERT OR IGNORE INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'owner')",
    );
    db.transaction(() => {
      for (const { id: projectId, user_id: userId } of unseeded) {
        insertMember.run(nanoid(), projectId, userId);
      }
    })();
  }
}

// Todos (agent-managed within-conversation progress tracking)
db.run(`
  CREATE TABLE IF NOT EXISTS todos (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chat_id     TEXT REFERENCES chats(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Skills
db.run(`
  CREATE TABLE IF NOT EXISTS skills (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    s3_key       TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    metadata     TEXT,
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, name)
  )
`);

// Published skills (community marketplace)
db.run(`
  CREATE TABLE IF NOT EXISTS published_skills (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    description  TEXT DEFAULT '',
    s3_key       TEXT NOT NULL,
    metadata     TEXT,
    publisher_id TEXT NOT NULL,
    project_id   TEXT NOT NULL,
    downloads    INTEGER NOT NULL DEFAULT 0,
    published_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Companion tokens
db.run(`
  CREATE TABLE IF NOT EXISTS companion_tokens (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    token             TEXT UNIQUE NOT NULL,
    name              TEXT NOT NULL DEFAULT 'default',
    last_connected_at TEXT,
    expires_at        TEXT NOT NULL DEFAULT (datetime('now', '+30 days')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: add expires_at column to companion_tokens
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('companion_tokens')",
  ).all();
  if (!cols.some((c) => c.name === "expires_at")) {
    db.run("ALTER TABLE companion_tokens ADD COLUMN expires_at TEXT NOT NULL DEFAULT (datetime('now', '+30 days'))");
    // Set expiry for existing tokens to 30 days from now
    db.run("UPDATE companion_tokens SET expires_at = datetime('now', '+30 days') WHERE expires_at IS NULL OR expires_at = ''");
  }
}

// Migration: add project_id column to companion_tokens
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('companion_tokens')",
  ).all();
  if (!cols.some((c) => c.name === "project_id")) {
    // Drop all existing tokens since they have no project association
    db.run("DELETE FROM companion_tokens");
    db.run("ALTER TABLE companion_tokens ADD COLUMN project_id TEXT NOT NULL DEFAULT '' REFERENCES projects(id) ON DELETE CASCADE");
  }
}

// Migration: add source column to skills
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('skills')",
  ).all();
  if (!cols.some((c) => c.name === "source")) {
    db.run("ALTER TABLE skills ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
  }
}

// Migration: add required_tools column to scheduled_tasks
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('scheduled_tasks')",
  ).all();
  if (!cols.some((c) => c.name === "required_tools")) {
    db.run("ALTER TABLE scheduled_tasks ADD COLUMN required_tools TEXT");
  }
}

// Migration: add show_skills_in_files column to projects
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('projects')",
  ).all();
  if (!cols.some((c) => c.name === "show_skills_in_files")) {
    db.run("ALTER TABLE projects ADD COLUMN show_skills_in_files INTEGER NOT NULL DEFAULT 1");
  }
}

// Migration: add assistant customization columns to projects
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('projects')",
  ).all();
  if (!cols.some((c) => c.name === "assistant_name")) {
    db.run("ALTER TABLE projects ADD COLUMN assistant_name TEXT NOT NULL DEFAULT 'Sales Assistant'");
  }
  if (!cols.some((c) => c.name === "assistant_description")) {
    db.run("ALTER TABLE projects ADD COLUMN assistant_description TEXT NOT NULL DEFAULT 'Ask me anything about your leads, messages, or sales strategy.'");
  }
  if (!cols.some((c) => c.name === "assistant_icon")) {
    db.run("ALTER TABLE projects ADD COLUMN assistant_icon TEXT NOT NULL DEFAULT 'message'");
  }
}

// Quick actions (user-managed starter suggestions)
db.run(`
  CREATE TABLE IF NOT EXISTS quick_actions (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT 'sparkles',
    description TEXT DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Channels (messaging platform integrations)
db.run(`
  CREATE TABLE IF NOT EXISTS channels (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    platform         TEXT NOT NULL CHECK (platform IN ('telegram', 'whatsapp', 'signal')),
    name             TEXT NOT NULL,
    credentials      TEXT NOT NULL DEFAULT '{}',
    allowed_senders  TEXT NOT NULL DEFAULT '[]',
    enabled          INTEGER NOT NULL DEFAULT 0,
    last_message_at  TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, platform)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS channel_messages (
    id                  TEXT PRIMARY KEY,
    channel_id          TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chat_id             TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    external_chat_id    TEXT NOT NULL,
    external_message_id TEXT,
    sender_identifier   TEXT NOT NULL,
    direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    content_text        TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: add source column to chats (for channel-created chats)
{
  const cols = db.query<{ name: string }, []>(
    "SELECT name FROM pragma_table_info('chats')",
  ).all();
  if (!cols.some((c) => c.name === "source")) {
    db.run("ALTER TABLE chats ADD COLUMN source TEXT");
  }
}

// Indexes
db.run(`CREATE INDEX IF NOT EXISTS idx_outreach_messages_status ON outreach_messages(project_id, status)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_outreach_messages_lead ON outreach_messages(lead_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_outreach_messages_project ON outreach_messages(project_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, updated_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project_id, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_files_project_folder ON files(project_id, folder_path)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_folders_project ON folders(project_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_leads_project_status ON leads(project_id, status)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads(project_id, follow_up_date)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(project_id, score)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next ON scheduled_tasks(next_run_at, enabled)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project ON scheduled_tasks(project_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_invitations_project ON invitations(project_id, status)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(invitee_email, status)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_todos_project_chat ON todos(project_id, chat_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_skills_project ON skills(project_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_companion_tokens_user ON companion_tokens(user_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_companion_tokens_project ON companion_tokens(project_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_companion_tokens_token ON companion_tokens(token)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_published_skills_name ON published_skills(name)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_published_skills_downloads ON published_skills(downloads DESC)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_quick_actions_project ON quick_actions(project_id, sort_order)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_channels_project ON channels(project_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels(enabled)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel_id, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_channel_messages_chat ON channel_messages(chat_id, created_at)`);

export function generateId(): string {
  return nanoid();
}

export { db };
