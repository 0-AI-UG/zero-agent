export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  is_admin?: number;
  can_create_projects?: number;
  companion_sharing?: number;
  token_limit?: number | null;
  token_version: number;
  created_at: string;
}

export interface UserPasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_name: string;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  automation_enabled: number;
  sync_gating_enabled: number;
  show_skills_in_files: number;
  assistant_name: string;
  assistant_description: string;
  assistant_icon: string;
  is_starred: number;
  is_archived: number;
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

export interface FileRow {
  id: string;
  project_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  folder_path: string;
  hash: string;
  created_at: string;
}

export interface FolderRow {
  id: string;
  project_id: string;
  path: string;
  name: string;
  created_at: string;
}

export interface TurnSnapshotRow {
  id: string;
  project_id: string;
  chat_id: string;
  run_id: string;
  turn_index: number;
  parent_snapshot_id: string | null;
  commit_sha: string;
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
  max_steps: number | null;
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
  invitee_username: string;
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

export interface ModelRow {
  id: string;
  name: string;
  provider: string;
  is_default: number;
  multimodal: number;
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

export interface AppRow {
  id: string;
  project_id: string;
  user_id: string;
  slug: string;
  name: string;
  port: number;
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

export interface UserTelegramLinkRow {
  id: string;
  user_id: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  telegram_username: string | null;
  active_chat_id: string | null;
  active_project_id: string | null;
  linked_at: string;
}

export interface UserTelegramLinkCodeRow {
  code: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

export interface UserNotificationSubscriptionRow {
  id: string;
  user_id: string;
  kind: string;
  channel: "ws" | "push" | "telegram";
  enabled: number;
  created_at: string;
}

export type PendingResponseStatus =
  | "pending"
  | "resolved"
  | "expired"
  | "cancelled";

export interface PendingResponseRow {
  id: string;
  group_id: string | null;
  requester_kind: string;
  requester_context: string;
  target_user_id: string;
  project_id: string | null;
  kind: string;
  prompt: string;
  payload: string | null;
  status: PendingResponseStatus;
  response_text: string | null;
  response_via: string | null;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
}

export interface TelegramNotificationMessageRow {
  id: string;
  pending_response_id: string;
  telegram_chat_id: string;
  telegram_message_id: number;
  created_at: string;
}

