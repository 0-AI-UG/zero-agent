import { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BUILTIN_SKILLS, BUILTIN_TEMPLATES } from "./seed-data.ts";

const DB_PATH = process.env.DB_PATH || "./data/app.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");
db.run("PRAGMA case_sensitive_like = ON");

// ── Schema ──

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
    id                        TEXT PRIMARY KEY,
    user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                      TEXT NOT NULL,
    description               TEXT DEFAULT '',
    automation_enabled        INTEGER NOT NULL DEFAULT 0,
    browser_search_fallback   INTEGER NOT NULL DEFAULT 0,
    code_execution_enabled    INTEGER NOT NULL DEFAULT 0,
    browser_automation_enabled INTEGER NOT NULL DEFAULT 1,
    show_skills_in_files      INTEGER NOT NULL DEFAULT 1,
    assistant_name            TEXT NOT NULL DEFAULT 'Zero Agent',
    assistant_description     TEXT NOT NULL DEFAULT 'Ask me anything — I can browse the web, manage files, run code, and automate tasks.',
    assistant_icon            TEXT NOT NULL DEFAULT 'message',
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS chats (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title         TEXT NOT NULL DEFAULT 'New Chat',
    is_autonomous INTEGER NOT NULL DEFAULT 0,
    created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
    source        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chat_id    TEXT REFERENCES chats(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS files (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    s3_key          TEXT NOT NULL,
    filename        TEXT NOT NULL,
    mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes      INTEGER DEFAULT 0,
    folder_path     TEXT NOT NULL DEFAULT '/',
    thumbnail_s3_key TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
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

db.run(`
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    prompt          TEXT NOT NULL,
    schedule        TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    last_run_at     TEXT,
    next_run_at     TEXT NOT NULL,
    run_count       INTEGER NOT NULL DEFAULT 0,
    required_tools  TEXT,
    required_skills TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS task_runs (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    project_id  TEXT NOT NULL,
    chat_id     TEXT,
    status      TEXT NOT NULL DEFAULT 'running',
    summary     TEXT DEFAULT '',
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    error       TEXT
  )
`);

db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_files USING fts5(
    file_id UNINDEXED,
    project_id UNINDEXED,
    filename,
    content,
    tokenize='unicode61'
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS project_members (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, user_id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS invitations (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    inviter_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_email TEXT NOT NULL,
    invitee_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    responded_at  TEXT
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('invite', 'invite_accepted', 'member_removed', 'task_completed', 'task_failed')),
    data       TEXT NOT NULL DEFAULT '{}',
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

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

db.run(`
  CREATE TABLE IF NOT EXISTS skills (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    s3_key       TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1,
    metadata     TEXT,
    source       TEXT NOT NULL DEFAULT 'user',
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, name)
  )
`);

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

db.run(`
  CREATE TABLE IF NOT EXISTS marketplace_items (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL CHECK (type IN ('skill', 'template')),
    name         TEXT UNIQUE NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    s3_key       TEXT,
    metadata     TEXT,
    prompt       TEXT,
    schedule     TEXT,
    required_tools TEXT,
    category     TEXT NOT NULL DEFAULT 'general',
    publisher_id TEXT NOT NULL,
    project_id   TEXT NOT NULL DEFAULT '',
    downloads    INTEGER NOT NULL DEFAULT 0,
    published_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS marketplace_references (
    source_id      TEXT NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
    target_id      TEXT NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
    reference_type TEXT NOT NULL CHECK (reference_type IN ('mandatory', 'recommendation')),
    PRIMARY KEY (source_id, target_id),
    CHECK (source_id != target_id)
  )
`);

// ── Indexes ──

db.run(`CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, updated_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project_id, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_files_project_folder ON files(project_id, folder_path)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_folders_project ON folders(project_id)`);
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
db.run(`CREATE INDEX IF NOT EXISTS idx_quick_actions_project ON quick_actions(project_id, sort_order)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_marketplace_items_type ON marketplace_items(type)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_marketplace_items_name ON marketplace_items(name)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_marketplace_items_downloads ON marketplace_items(downloads DESC)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_marketplace_items_category ON marketplace_items(category)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_marketplace_refs_source ON marketplace_references(source_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_marketplace_refs_target ON marketplace_references(target_id)`);

// ── Seed built-in marketplace data ──

// Re-seed on every startup: upsert skills and templates (preserves download counts)
{
  for (const skill of BUILTIN_SKILLS) {
    db.run(
      `INSERT INTO marketplace_items (id, type, name, description, s3_key, publisher_id, project_id)
       VALUES (?, 'skill', ?, ?, 'built-in', 'system', 'system')
       ON CONFLICT(name) DO UPDATE SET description = excluded.description`,
      [skill.id, skill.name, skill.description],
    );
  }

  for (const t of BUILTIN_TEMPLATES) {
    db.run(
      `INSERT INTO marketplace_items (id, type, name, description, prompt, schedule, category, publisher_id, project_id)
       VALUES (?, 'template', ?, ?, ?, ?, ?, 'system', 'system')
       ON CONFLICT(name) DO UPDATE SET
         description = excluded.description,
         prompt = excluded.prompt,
         schedule = excluded.schedule,
         category = excluded.category`,
      [t.id, t.name, t.description, t.prompt, t.schedule, t.category],
    );
    for (const targetId of t.requiredSkillIds) {
      db.run(
        "INSERT OR IGNORE INTO marketplace_references (source_id, target_id, reference_type) VALUES (?, ?, 'mandatory')",
        [t.id, targetId],
      );
    }
  }
}

// ── Exports ──

export function generateId(): string {
  return nanoid();
}

export { db };
