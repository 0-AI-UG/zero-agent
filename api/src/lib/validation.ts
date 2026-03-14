import { z } from "zod";
import { ValidationError } from "@/lib/errors.ts";

// Auth
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number");

export const registerSchema = z.object({
  email: z.string().email("Invalid email"),
  password: passwordSchema,
  inviteToken: z.string().min(1, "Invite token is required"),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

// Projects
export const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  description: z.string().max(500).optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  automationEnabled: z.boolean().optional(),
  codeExecutionEnabled: z.boolean().optional(),
  browserAutomationEnabled: z.boolean().optional(),
  showSkillsInFiles: z.boolean().optional(),
  assistantName: z.string().min(1).max(100).optional(),
  assistantDescription: z.string().max(500).optional(),
  assistantIcon: z.string().min(1).max(50).optional(),
});

// Files
export const folderPathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^\/([a-zA-Z0-9_\- ]+\/)*$/, "Invalid folder path");

export const createFolderSchema = z.object({
  path: folderPathSchema,
  name: z.string().min(1, "Name is required").max(100),
});

export const moveFileSchema = z.object({
  destinationPath: folderPathSchema,
});

export const moveFolderSchema = z.object({
  destinationPath: folderPathSchema,
});

export const uploadRequestSchema = z.object({
  filename: z
    .string()
    .min(1, "Filename is required")
    .refine((v) => !v.includes("/") && !v.includes("\\") && !v.includes("\0") && v !== ".." && v !== ".", {
      message: "Filename must not contain path separators or traversal sequences",
    }),
  mimeType: z.string().min(1, "MIME type is required"),
  folderPath: folderPathSchema,
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024, "File too large (max 50 MB)"),
});

// Companion tokens
export const createCompanionTokenSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
});

// Skills
export const installSkillSchema = z.union([
  z.object({ content: z.string().min(1, "Skill content is required") }),
  z.object({ builtIn: z.string().min(1, "Built-in skill name is required") }),
]);

export const discoverSkillsSchema = z.object({
  url: z.string().min(1, "GitHub URL is required"),
});

export const installFromGithubSchema = z.object({
  url: z.string().min(1, "GitHub URL is required"),
  skills: z.array(z.string().min(1)).min(1, "Select at least one skill"),
});

// Community skills
export const publishSkillSchema = z.object({
  name: z.string().min(1, "Skill name is required"),
});

export const installCommunitySkillSchema = z.object({
  name: z.string().min(1, "Skill name is required"),
});

// Soul
export const updateSoulSchema = z.object({
  content: z.string().min(1).max(10000),
});

// Chat – keep permissive; the AI SDK controls part shapes and may add new types.
const messagePartSchema = z.object({ type: z.string() }).passthrough();

const uiMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(messagePartSchema),
}).passthrough();

export const chatRequestSchema = z.object({
  messages: z.array(uiMessageSchema).min(1, "At least one message is required"),
  model: z.string().optional(),
  language: z.enum(["en", "zh"]).optional(),
  disabledTools: z.array(z.string()).optional(),
});

// Validation helper
export async function validateBody<T>(
  request: Request,
  schema: z.ZodSchema<T>,
): Promise<T> {
  const body = await request.json();
  const result = schema.safeParse(body);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => i.message)
      .join("; ");
    throw new ValidationError(message);
  }
  return result.data;
}
