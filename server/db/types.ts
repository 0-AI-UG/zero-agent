export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  is_admin?: number;
  can_create_projects?: number;
  companion_sharing?: number;
  totp_secret?: string | null;
  totp_enabled?: number;
  created_at: string;
}

export interface TotpBackupCodeRow {
  id: string;
  user_id: string;
  code_hash: string;
  used: number;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  automation_enabled: number;
  browser_search_fallback: number;
  code_execution_enabled: number;
  browser_automation_enabled: number;
  show_skills_in_files: number;
  assistant_name: string;
  assistant_description: string;
  assistant_icon: string;
  created_at: string;
  updated_at: string;
}

export interface ChatRow {
  id: string;
  project_id: string;
  title: string;
  is_autonomous: number;
  created_by: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  project_id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  user_id: string | null;
  created_at: string;
}

export interface FileRow {
  id: string;
  project_id: string;
  s3_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  folder_path: string;
  thumbnail_s3_key: string | null;
  created_at: string;
}

export interface FolderRow {
  id: string;
  project_id: string;
  path: string;
  name: string;
  created_at: string;
}

export interface ScheduledTaskRow {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string;
  run_count: number;
  required_tools: string | null;
  required_skills: string | null;
  trigger_type: "schedule" | "event";
  trigger_event: string | null;
  trigger_filter: string | null;
  cooldown_seconds: number;
  decompose: number;
  created_at: string;
  updated_at: string;
}

export interface TaskRunRow {
  id: string;
  task_id: string;
  project_id: string;
  chat_id: string | null;
  status: "running" | "completed" | "failed";
  summary: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface ProjectMemberRow {
  id: string;
  project_id: string;
  user_id: string;
  role: "owner" | "member";
  created_at: string;
}

export interface InvitationRow {
  id: string;
  project_id: string;
  inviter_id: string;
  invitee_email: string;
  invitee_id: string | null;
  status: "pending" | "accepted" | "declined";
  created_at: string;
  responded_at: string | null;
}

export interface TodoRow {
  id: string;
  project_id: string;
  chat_id: string | null;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  created_at: string;
  updated_at: string;
}

export interface SkillRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  s3_key: string;
  enabled: number;
  metadata: string | null;
  source: string;
  installed_at: string;
  updated_at: string;
}

export interface QuickActionRow {
  id: string;
  project_id: string;
  text: string;
  icon: string;
  description: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
}

export interface TelegramBindingRow {
  id: string;
  project_id: string;
  telegram_chat_id: string;
  chat_id: string | null;
  chat_title: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ModelRow {
  id: string;
  name: string;
  provider: string;
  description: string;
  context_window: number;
  pricing_input: number;
  pricing_output: number;
  tags: string;
  is_default: number;
  multimodal: number;
  provider_routing: string | null;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CredentialRow {
  id: string;
  project_id: string;
  cred_type: "password" | "passkey";
  label: string;
  site_url: string;
  domain: string;
  username: string | null;
  password_enc: string | null;
  totp_secret_enc: string | null;
  backup_codes_enc: string | null;
  credential_id: string | null;
  private_key_enc: string | null;
  rp_id: string | null;
  user_handle: string | null;
  sign_count: number;
  created_at: string;
  updated_at: string;
}

export interface ForwardedPortRow {
  id: string;
  project_id: string;
  user_id: string;
  slug: string;
  label: string;
  port: number;
  container_ip: string | null;
  status: "active" | "stopped";
  pinned: number;
  start_command: string | null;
  working_dir: string;
  env_vars: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface UsageLogRow {
  id: string;
  user_id: string;
  project_id: string;
  chat_id: string | null;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cost_input: number;
  cost_output: number;
  duration_ms: number | null;
  created_at: string;
}

