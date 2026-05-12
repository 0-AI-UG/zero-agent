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
    token_limit         INTEGER,
    token_version       INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: drop legacy TOTP columns and add token_version on existing DBs.
{
  const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (cols.some((c) => c.name === "totp_secret")) {
    db.exec("ALTER TABLE users DROP COLUMN totp_secret");
  }
  if (cols.some((c) => c.name === "totp_enabled")) {
    db.exec("ALTER TABLE users DROP COLUMN totp_enabled");
  }
  if (!cols.some((c) => c.name === "token_version")) {
    db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0");
  }
}
db.exec(`DROP TABLE IF EXISTS totp_backup_codes`);

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

// Pi JSONL is the canonical conversation history; the legacy messages
// table is dropped wholesale. zero-agent has no production data to preserve.
db.exec(`DROP TABLE IF EXISTS messages`);

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename         TEXT NOT NULL,
    mime_type        TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes       INTEGER DEFAULT 0,
    folder_path      TEXT NOT NULL DEFAULT '/',
    hash             TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Phase 5: drop s3_key and thumbnail_s3_key columns if present (existing installs).
{
  const cols = db.prepare("PRAGMA table_info(files)").all() as { name: string }[];
  if (cols.some((c) => c.name === "s3_key")) {
    db.exec("ALTER TABLE files DROP COLUMN s3_key");
  }
  if (cols.some((c) => c.name === "thumbnail_s3_key")) {
    db.exec("ALTER TABLE files DROP COLUMN thumbnail_s3_key");
  }
}

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
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    provider    TEXT NOT NULL,
    is_default  INTEGER NOT NULL DEFAULT 0,
    multimodal  INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Drop legacy columns if upgrading from a pre-cutover DB. SQLite supports
// ALTER TABLE DROP COLUMN since 3.35; older runtimes will no-op via the try.
for (const col of [
  "inference_provider",
  "description",
  "context_window",
  "pricing_input",
  "pricing_output",
  "tags",
  "provider_config",
]) {
  try {
    db.exec(`ALTER TABLE models DROP COLUMN ${col}`);
  } catch {
    // column already absent on freshly created tables
  }
}

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

// Pi owns turn resume; the durability checkpoint table is gone.
db.exec(`DROP TABLE IF EXISTS agent_checkpoints`);

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

// Runner backend deleted with the Pi cutover; drop the table.
db.exec(`DROP TABLE IF EXISTS runners`);

// ── Apps ──
//
// Each row is a permanent reverse-proxy mapping for a project: slug ↔ port.
// The platform allocates the port (so two projects never collide on loopback);
// the user's process binds to it. Nothing here tracks the process — if no one
// is listening on the port, the proxy returns 502.

db.exec(`DROP TABLE IF EXISTS forwarded_ports`);

db.exec(`
  CREATE TABLE IF NOT EXISTS apps (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    port        INTEGER UNIQUE NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, name)
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
  if (!cols.some((c: any) => c.name === "script_path")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN script_path TEXT");
  }
}

// ── Trigger state (per-task persistent JSON key/value for script triggers) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS trigger_state (
    task_id    TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (task_id, key)
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_trigger_state_task ON trigger_state(task_id)`);

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

// Legacy blob storage removed; drop if present for existing installs.
db.exec(`DROP TABLE IF EXISTS sync_approval_blobs`);

// ── Turn snapshots (per-turn git snapshots; Phase 3) ──

db.exec(`
  CREATE TABLE IF NOT EXISTS turn_snapshots (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chat_id             TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    run_id              TEXT NOT NULL,
    turn_index          INTEGER NOT NULL,
    parent_snapshot_id  TEXT REFERENCES turn_snapshots(id) ON DELETE SET NULL,
    commit_sha          TEXT NOT NULL,
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
db.exec(`CREATE INDEX IF NOT EXISTS idx_files_project_folder ON files(project_id, folder_path)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_folders_project ON folders(project_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next ON scheduled_tasks(next_run_at, enabled)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project ON scheduled_tasks(project_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_invitations_project ON invitations(project_id, status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_snapshots_chat ON turn_snapshots(chat_id, turn_index)`);
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
db.exec(`CREATE INDEX IF NOT EXISTS idx_apps_project ON apps(project_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_apps_slug ON apps(slug)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_tg_links_tg_user ON user_telegram_links(telegram_user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_tg_link_codes_expires ON user_telegram_link_codes(expires_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_user_notif_subs_user ON user_notification_subscriptions(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_responses_target ON pending_responses(target_user_id, status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_responses_expires ON pending_responses(status, expires_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_responses_group ON pending_responses(group_id, status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tg_notif_msgs_pending ON telegram_notification_messages(pending_response_id)`);

// ── Sync models from JSON on startup (idempotent) ──

{
  const { default: modelsJson } = await import("@/config/models.json", { with: { type: "json" } });
  const seedModels = (modelsJson as any).models as Array<{
    id: string; name: string; provider: string;
    default?: boolean; multimodal?: boolean;
  }>;
  const upsertModel = db.prepare(
    `INSERT INTO models (id, name, provider, is_default, multimodal, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       provider = excluded.provider,
       is_default = excluded.is_default,
       multimodal = excluded.multimodal,
       sort_order = excluded.sort_order,
       updated_at = datetime('now')`
  );
  for (let i = 0; i < seedModels.length; i++) {
    const m = seedModels[i]!;
    upsertModel.run(
      m.id, m.name, m.provider,
      m.default ? 1 : 0,
      m.multimodal ? 1 : 0,
      i,
    );
  }
  const seedIds = seedModels.map((m) => m.id);
  const placeholders = seedIds.map(() => "?").join(",");
  db.prepare(`DELETE FROM models WHERE id NOT IN (${placeholders})`).run(...seedIds);
}

// ── Exports ──

export function generateId(): string {
  return nanoid();
}

export { db };
