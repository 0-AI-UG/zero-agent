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

// ── Schema ──

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS telegram_bindings (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    telegram_chat_id TEXT NOT NULL,
    chat_id          TEXT REFERENCES chats(id) ON DELETE SET NULL,
    chat_title       TEXT DEFAULT '',
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, telegram_chat_id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS models (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    provider         TEXT NOT NULL,
    description      TEXT DEFAULT '',
    context_window   INTEGER NOT NULL DEFAULT 128000,
    pricing_input    REAL NOT NULL DEFAULT 0,
    pricing_output   REAL NOT NULL DEFAULT 0,
    tags             TEXT NOT NULL DEFAULT '[]',
    is_default       INTEGER NOT NULL DEFAULT 0,
    multimodal       INTEGER NOT NULL DEFAULT 0,
    provider_routing TEXT,
    enabled          INTEGER NOT NULL DEFAULT 1,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS credentials (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    cred_type        TEXT NOT NULL CHECK (cred_type IN ('password', 'passkey')),
    label            TEXT NOT NULL,
    site_url         TEXT NOT NULL,
    domain           TEXT NOT NULL,
    username         TEXT,
    password_enc     TEXT,
    totp_secret_enc  TEXT,
    backup_codes_enc TEXT,
    credential_id    TEXT,
    private_key_enc  TEXT,
    rp_id            TEXT,
    user_handle      TEXT,
    sign_count       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS usage_logs (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id       TEXT NOT NULL,
    chat_id          TEXT REFERENCES chats(id) ON DELETE SET NULL,
    model_id         TEXT NOT NULL,
    input_tokens     INTEGER NOT NULL DEFAULT 0,
    output_tokens    INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens    INTEGER NOT NULL DEFAULT 0,
    cost_input       REAL NOT NULL DEFAULT 0,
    cost_output      REAL NOT NULL DEFAULT 0,
    duration_ms      INTEGER,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ── Durability: event log & checkpoints ──

db.run(`
  CREATE TABLE IF NOT EXISTS agent_events (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    chat_id     TEXT,
    project_id  TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    event_type  TEXT NOT NULL,
    tool_names  TEXT,
    data        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(run_id, step_number)`);

db.run(`
  CREATE TABLE IF NOT EXISTS agent_checkpoints (
    run_id      TEXT PRIMARY KEY,
    chat_id     TEXT,
    project_id  TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    messages    TEXT NOT NULL,
    metadata    TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ── Migrations (idempotent column additions) ──

for (const col of [
  "trigger_type TEXT NOT NULL DEFAULT 'schedule'",
  "trigger_event TEXT",
  "trigger_filter TEXT",
  "cooldown_seconds INTEGER NOT NULL DEFAULT 0",
  "decompose INTEGER NOT NULL DEFAULT 0",
]) {
  try { db.run(`ALTER TABLE scheduled_tasks ADD COLUMN ${col}`); } catch {}
}

// Users migrations
try { db.run(`ALTER TABLE users ADD COLUMN can_create_projects INTEGER NOT NULL DEFAULT 1`); } catch {}
try { db.run(`ALTER TABLE users ADD COLUMN companion_sharing INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.run(`ALTER TABLE users ADD COLUMN totp_secret TEXT`); } catch {}
try { db.run(`ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`); } catch {}

db.run(`
  CREATE TABLE IF NOT EXISTS totp_backup_codes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_totp_backup_user ON totp_backup_codes(user_id, used)`);

// ── Runners ──

db.run(`
  CREATE TABLE IF NOT EXISTS runners (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    api_key    TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ── Forwarded Ports ──

db.run(`
  CREATE TABLE IF NOT EXISTS forwarded_ports (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug          TEXT UNIQUE NOT NULL,
    label         TEXT NOT NULL DEFAULT '',
    port          INTEGER NOT NULL,
    container_ip  TEXT,
    status        TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'stopped')),
    pinned        INTEGER NOT NULL DEFAULT 0,
    start_command TEXT,
    working_dir   TEXT DEFAULT '/workspace',
    env_vars      TEXT DEFAULT '{}',
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migrate from deployed_apps if it exists
try {
  const hasOld = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='deployed_apps'").get();
  if (hasOld) {
    db.run(`
      INSERT OR IGNORE INTO forwarded_ports (id, project_id, user_id, slug, label, port, container_ip, status, pinned, start_command, working_dir, env_vars, error, created_at, updated_at)
      SELECT id, project_id, user_id, slug, name, internal_port, container_ip,
        CASE WHEN status = 'running' THEN 'active' ELSE 'stopped' END,
        published, start_command, working_dir, env_vars, error, created_at, updated_at
      FROM deployed_apps
    `);
    db.run("DROP TABLE IF EXISTS app_deploy_logs");
    db.run("DROP TABLE IF EXISTS deployed_apps");
  }
} catch {
  // Migration already done or table doesn't exist
}

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
db.run(`CREATE INDEX IF NOT EXISTS idx_todos_project_chat ON todos(project_id, chat_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_skills_project ON skills(project_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_companion_tokens_user ON companion_tokens(user_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_companion_tokens_project ON companion_tokens(project_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_companion_tokens_token ON companion_tokens(token)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_quick_actions_project ON quick_actions(project_id, sort_order)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_tg_bind_chat ON telegram_bindings(telegram_chat_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_trigger ON scheduled_tasks(trigger_type, trigger_event, enabled)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_usage_logs_user ON usage_logs(user_id, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_usage_logs_model ON usage_logs(model_id, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_usage_logs_project ON usage_logs(project_id, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_credentials_project ON credentials(project_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_credentials_domain ON credentials(project_id, domain)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_forwarded_ports_project ON forwarded_ports(project_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_forwarded_ports_slug ON forwarded_ports(slug)`);

// ── Seed models from JSON if table is empty ──

const modelCount = db.query<{ count: number }, []>("SELECT count(*) as count FROM models").get()!;
if (modelCount.count === 0) {
  const seedModels = require("@/config/models.json").models;
  const insertModel = db.prepare(
    `INSERT INTO models (id, name, provider, description, context_window, pricing_input, pricing_output, tags, is_default, multimodal, provider_routing, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < seedModels.length; i++) {
    const m = seedModels[i];
    insertModel.run(
      m.id, m.name, m.provider, m.description ?? "",
      m.contextWindow ?? 128000,
      m.pricing?.input ?? 0, m.pricing?.output ?? 0,
      JSON.stringify(m.tags ?? []),
      m.default ? 1 : 0,
      m.multimodal ? 1 : 0,
      m.providerRouting ? JSON.stringify(m.providerRouting) : null,
      i,
    );
  }
}

// ── Exports ──

export function generateId(): string {
  return nanoid();
}

export { db };
