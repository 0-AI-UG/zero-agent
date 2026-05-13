import { z } from "zod";
import { ValidationError } from "@/lib/utils/errors.ts";

// Auth
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number");

export const usernameSchema = z
  .string()
  .min(3, "Username must be at least 3 characters")
  .max(32, "Username must be at most 32 characters")
  .regex(/^[a-zA-Z0-9_-]+$/, "Username may only contain letters, numbers, underscores and hyphens");

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  inviteToken: z.string().min(1, "Invite token is required"),
});

export const loginSchema = z.object({
  username: usernameSchema,
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
  showSkillsInFiles: z.boolean().optional(),
  assistantName: z.string().min(1).max(100).optional(),
  assistantDescription: z.string().max(500).optional(),
  assistantIcon: z.string().min(1).max(50).optional(),
  systemPrompt: z.string().max(20000).optional(),
  isStarred: z.boolean().optional(),
  isArchived: z.boolean().optional(),
});

// Files
export const folderPathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^\/([a-zA-Z0-9._\- ]+\/)*$/, "Invalid folder path");

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
    .nonnegative()
    .max(50 * 1024 * 1024, "File too large (max 50 MB)"),
});

// Skills
export const installSkillSchema = z.object({
  content: z.string().min(1, "Skill content is required"),
});

export const discoverSkillsSchema = z.object({
  url: z.string().min(1, "GitHub URL is required"),
});

export const installFromGithubSchema = z.object({
  url: z.string().min(1, "GitHub URL is required"),
  skills: z.array(z.string().min(1)).min(1, "Select at least one skill"),
});

// Credentials
const credentialBaseFields = {
  label: z.string().min(1).max(100),
  siteUrl: z.string().min(1).max(500),
};

export const createCredentialSchema = z.discriminatedUnion("credType", [
  z.object({
    ...credentialBaseFields,
    credType: z.literal("password"),
    username: z.string().min(1),
    password: z.string().min(1),
    totpSecret: z.string().optional(),
    backupCodes: z.array(z.string()).optional(),
  }),
  z.object({
    ...credentialBaseFields,
    credType: z.literal("passkey"),
  }),
]);

export const updateCredentialSchema = z.discriminatedUnion("credType", [
  z.object({
    ...credentialBaseFields,
    credType: z.literal("password"),
    username: z.string().optional(),
    password: z.string().optional(),
    totpSecret: z.string().optional(),
    backupCodes: z.array(z.string()).optional(),
  }),
  z.object({
    ...credentialBaseFields,
    credType: z.literal("passkey"),
  }),
]);

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
