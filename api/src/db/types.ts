export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  is_admin?: number;
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

export type NotificationType = "invite" | "invite_accepted" | "member_removed" | "task_completed" | "task_failed";

export interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  data: string;
  read: number;
  created_at: string;
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

export interface CompanionTokenRow {
  id: string;
  user_id: string;
  project_id: string;
  token: string;
  name: string;
  last_connected_at: string | null;
  expires_at: string;
  created_at: string;
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

