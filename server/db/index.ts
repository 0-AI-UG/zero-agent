import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
const DB_PATH = process.env.DB_PATH || "./data/app.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA case_sensitive_like = ON");

// ── Schema ──

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                  TEXT PRIMARY KEY,
    username            TEXT UNIQUE NOT NULL,
    password_hash       TEXT NOT NULL,
    is_admin            INTEGER NOT NULL DEFAULT 0,
    can_create_projects INTEGER NOT NULL DEFAULT 1,
    companion_sharing   INTEGER NOT NULL DEFAULT 0,
    totp_secret         TEXT,
    totp_enabled        INTEGER NOT NULL DEFAULT 0,
    token_limit         INTEGER,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id                        TEXT PRIMARY KEY,
    user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                      TEXT NOT NULL,
    description               TEXT DEFAULT '',
    automation_enabled        INTEGER NOT NULL DEFAULT 0,
    sync_gating_enabled       INTEGER NOT NULL DEFAULT 1,
    show_skills_in_files      INTEGER NOT NULL DEFAULT 1,
    assistant_name            TEXT NOT NULL DEFAULT 'Zero Agent',
    assistant_description     TEXT NOT NULL DEFAULT 'Ask me anything - I can browse the web, manage files, run code, and automate tasks.',
    assistant_icon            TEXT NOT NULL DEFAULT 'message',
    is_starred                INTEGER NOT NULL DEFAULT 0,
    is_archived               INTEGER NOT NULL DEFAULT 0,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
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

db.exec(`
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

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    s3_key           TEXT NOT NULL,
    filename         TEXT NOT NULL,
    mime_type        TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes       INTEGER DEFAULT 0,
    folder_path      TEXT NOT NULL DEFAULT '/',
    thumbnail_s3_key TEXT,
    hash             TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, path)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    prompt           TEXT NOT NULL,
    schedule         TEXT NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    last_run_at      TEXT,
    next_run_at      TEXT NOT NULL,
    run_count        INTEGER NOT NULL DEFAULT 0,
    required_tools   TEXT,
    required_skills  TEXT,
    trigger_type     TEXT NOT NULL DEFAULT 'schedule',
    trigger_event    TEXT,
    trigger_filter   TEXT,
    cooldown_seconds INTEGER NOT NULL DEFAULT 0,
    max_steps        INTEGER,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
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

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_files USING fts5(
    file_id UNINDEXED,
    project_id UNINDEXED,
    filename,
    content,
    tokenize='unicode61'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS project_members (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, user_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS invitations (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    inviter_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_username TEXT NOT NULL,
    invitee_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    responded_at  TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_invitations (
    id                  TEXT PRIMARY KEY,
    token_hash          TEXT NOT NULL UNIQUE,
    username            TEXT NOT NULL,
    inviter_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    can_create_projects INTEGER NOT NULL DEFAULT 1,
    token_limit         INTEGER,
    expires_at          INTEGER NOT NULL,
    accepted_at         INTEGER,
    accepted_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at          INTEGER NOT NULL
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_invitations_token ON user_invitations(token_hash)`);

db.exec(`
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

db.exec(`
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

db.exec(`
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

db.exec(`
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

// The legacy per-project `telegram_bindings` table has been removed as of
// Stage 5 (Telegram rescope). Drop it if a prior install created it - zero-
// agent is not yet deployed, so no data needs preserving.
db.exec(`DROP TABLE IF EXISTS telegram_bindings`);

db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS models (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    provider           TEXT NOT NULL,
    inference_provider TEXT NOT NULL DEFAULT 'openrouter',
    description        TEXT DEFAULT '',
    context_window     INTEGER NOT NULL DEFAULT 128000,
    pricing_input      REAL NOT NULL DEFAULT 0,
    pricing_output     REAL NOT NULL DEFAULT 0,
    tags               TEXT NOT NULL DEFAULT '[]',
    is_default         INTEGER NOT NULL DEFAULT 0,
    multimodal         INTEGER NOT NULL DEFAULT 0,
    provider_config    TEXT,
    enabled            INTEGER NOT NULL DEFAULT 1,
    sort_order         INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
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

db.exec(`
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

// ── Durability: agent checkpoints ──

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_checkpoints (
    run_id      TEXT PRIMARY KEY,
    chat_id     TEXT,
    project_id  TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    messages    TEXT NOT NULL,
    metadata    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS totp_backup_codes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_totp_backup_user ON totp_backup_codes(user_id, used)`);

// ── User Passkeys (WebAuthn 2FA) ──

db.exec(`
  CREATE TABLE IF NOT EXISTS user_passkeys (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id   TEXT NOT NULL UNIQUE,
    public_key      TEXT NOT NULL,
    counter         INTEGER NOT NULL DEFAULT 0,
    transports      TEXT,
    device_name     TEXT NOT NULL DEFAULT 'Passkey',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_passkeys_user ON user_passkeys(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_passkeys_cred ON user_passkeys(credential_id)`);

// ── Runners ──

db.exec(`
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

db.exec(`
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
    working_dir   TEXT DEFAULT '/workspace', -- existing rows with '/project' are untouched; callers fall back to '/workspace' when reading
    env_vars      TEXT DEFAULT '{}',
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ── User ↔ Telegram links (one linked identity per user) ──

db.exec(`
  CREATE TABLE IF NOT EXISTS user_telegram_links (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    telegram_user_id  TEXT NOT NULL UNIQUE,
    telegram_chat_id  TEXT NOT NULL,
    telegram_username TEXT,
    active_chat_id    TEXT REFERENCES chats(id) ON DELETE SET NULL,
    active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    linked_at         TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Idempotently add active_project_id for installs that pre-date the column.
{
  const cols = db
    .prepare("PRAGMA table_info(user_telegram_links)")
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "active_project_id")) {
    db.exec(
      "ALTER TABLE user_telegram_links ADD COLUMN active_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL",
    );
  }
}

// Idempotently add max_steps for installs that pre-date the column.
{
  const cols = db
    .prepare("PRAGMA table_info(scheduled_tasks)")
    .all() as { name: string }[];
  if (!cols.some((c: any) => c.name === "max_steps")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN max_steps INTEGER");
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS user_telegram_link_codes (
    code       TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ── Notification subscriptions (delta rows; default-on) ──

db.exec(`
  CREATE TABLE IF NOT EXISTS user_notification_subscriptions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    channel    TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, kind, channel)
  )
`);

// ── Pending responses (generic two-way request plumbing) ──

db.exec(`
  CREATE TABLE IF NOT EXISTS pending_responses (
    id                TEXT PRIMARY KEY,
    group_id          TEXT,
    requester_kind    TEXT NOT NULL,
    requester_context TEXT NOT NULL,
    target_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id        TEXT REFERENCES projects(id) ON DELETE CASCADE,
    kind              TEXT NOT NULL,
    prompt            TEXT NOT NULL,
    payload           TEXT,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','resolved','expired','cancelled')),
    response_text     TEXT,
    response_via      TEXT,
    expires_at        TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at       TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sync_approval_blobs (
    pending_response_id TEXT PRIMARY KEY REFERENCES pending_responses(id) ON DELETE CASCADE,
    changes_json        TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_notification_messages (
    id                  TEXT PRIMARY KEY,
    pending_response_id TEXT NOT NULL REFERENCES pending_responses(id) ON DELETE CASCADE,
    telegram_chat_id    TEXT NOT NULL,
    telegram_message_id INTEGER NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(telegram_chat_id, telegram_message_id)
  )
`);

// Idempotently add is_starred / is_archived for installs that pre-date the columns.
{
  const cols = db
    .prepare("PRAGMA table_info(projects)")
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "is_starred")) {
    db.exec("ALTER TABLE projects ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "is_archived")) {
    db.exec("ALTER TABLE projects ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0");
  }
}

// ── Indexes ──

db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, updated_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project_id, created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_files_project_folder ON files(project_id, folder_path)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_folders_project ON folders(project_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next ON scheduled_tasks(next_run_at, enabled)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project ON scheduled_tasks(project_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_invitations_project ON invitations(project_id, status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_invitations_username ON invitations(invitee_username, status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_project_chat ON todos(project_id, chat_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_skills_project ON skills(project_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_companion_tokens_user ON companion_tokens(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_companion_tokens_project ON companion_tokens(project_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_companion_tokens_token ON companion_tokens(token)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_quick_actions_project ON quick_actions(project_id, sort_order)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_trigger ON scheduled_tasks(trigger_type, trigger_event, enabled)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_logs_user ON usage_logs(user_id, created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_logs_model ON usage_logs(model_id, created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_logs_project ON usage_logs(project_id, created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_credentials_project ON credentials(project_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_credentials_domain ON credentials(project_id, domain)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_forwarded_ports_project ON forwarded_ports(project_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_forwarded_ports_slug ON forwarded_ports(slug)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_tg_links_tg_user ON user_telegram_links(telegram_user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_tg_link_codes_expires ON user_telegram_link_codes(expires_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_notif_subs_user ON user_notification_subscriptions(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_responses_target ON pending_responses(target_user_id, status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_responses_expires ON pending_responses(status, expires_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_responses_group ON pending_responses(group_id, status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tg_notif_msgs_pending ON telegram_notification_messages(pending_response_id)`);

// ── Seed models from JSON if table is empty ──

const modelCount = db.prepare("SELECT count(*) as count FROM models").get() as { count: number };
if (modelCount.count === 0) {
  const { default: modelsJson } = await import("@/config/models.json", { with: { type: "json" } });
  const seedModels = (modelsJson as any).models;
  const insertModel = db.prepare(
    `INSERT INTO models (id, name, provider, inference_provider, description, context_window, pricing_input, pricing_output, tags, is_default, multimodal, provider_config, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < seedModels.length; i++) {
    const m = seedModels[i];
    insertModel.run(
      m.id, m.name, m.provider,
      m.inferenceProvider ?? "openrouter",
      m.description ?? "",
      m.contextWindow ?? 128000,
      m.pricing?.input ?? 0, m.pricing?.output ?? 0,
      JSON.stringify(m.tags ?? []),
      m.default ? 1 : 0,
      m.multimodal ? 1 : 0,
      m.providerConfig ? JSON.stringify(m.providerConfig) : null,
      i,
    );
  }
}

// ── Exports ──

export function generateId(): string {
  return nanoid();
}

export { db };
