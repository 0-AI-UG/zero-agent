import bcrypt from "bcrypt";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { corsHeaders } from "@/lib/cors.ts";
import { requireAdmin, createToken, createTempToken, isTotpRequired } from "@/lib/auth.ts";
import { handleError } from "@/routes/utils.ts";
import { validateBody, passwordSchema } from "@/lib/validation.ts";
import { ValidationError, AuthError } from "@/lib/errors.ts";
import { authRateLimiter } from "@/lib/rate-limit.ts";
import { getUserByEmail, getUserById, insertUser } from "@/db/queries/users.ts";
import { db } from "@/db/index.ts";
import {
  createInvitation,
  getInvitationByTokenHash,
  listAllInvitations,
  markInvitationAccepted,
  deleteInvitation,
  type UserInvitationRow,
} from "@/db/queries/user-invitations.ts";
import { log } from "@/lib/logger.ts";

const inviteLog = log.child({ module: "user-invitations" });

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function serializeInvitation(row: UserInvitationRow) {
  const now = nowSeconds();
  const expired = row.expires_at < now && !row.accepted_at;
  const status = row.accepted_at ? "accepted" : expired ? "expired" : "pending";
  return {
    id: row.id,
    email: row.email,
    status,
    canCreateProjects: row.can_create_projects === 1,
    tokenLimit: row.token_limit,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
  };
}

const createSchema = z.object({
  email: z.string().email("Invalid email"),
  canCreateProjects: z.boolean().optional(),
  tokenLimit: z.number().int().nonnegative().nullable().optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
});

function checkRateLimit(request: Request): Response | null {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";
  const { allowed, retryAfterSeconds } = authRateLimiter.check(ip);
  if (!allowed) {
    return Response.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429, headers: { ...corsHeaders, "Retry-After": String(retryAfterSeconds) } },
    );
  }
  return null;
}

// ── Admin: create ──
export async function handleCreateInvitation(request: Request): Promise<Response> {
  try {
    const { userId } = await requireAdmin(request);
    const body = await validateBody(request, createSchema);

    const normalizedEmail = body.email.toLowerCase().trim();
    if (getUserByEmail(normalizedEmail)) {
      return Response.json(
        { error: "A user with that email already exists" },
        { status: 409, headers: corsHeaders },
      );
    }

    const rawToken = randomBytes(32).toString("base64url");
    const expiresInDays = body.expiresInDays ?? 7;
    const expiresAt = nowSeconds() + expiresInDays * 24 * 60 * 60;

    const row = createInvitation({
      tokenHash: hashToken(rawToken),
      email: normalizedEmail,
      inviterId: userId,
      canCreateProjects: body.canCreateProjects ?? true,
      tokenLimit: body.tokenLimit ?? null,
      expiresAt,
    });

    inviteLog.info("invitation created", { id: row.id, email: normalizedEmail, inviterId: userId });

    return Response.json(
      { invitation: serializeInvitation(row), token: rawToken },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

// ── Admin: list ──
export async function handleListAdminInvitations(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const invitations = listAllInvitations().map(serializeInvitation);
    return Response.json({ invitations }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// ── Admin: delete/revoke ──
export async function handleDeleteInvitation(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const id = (request as any).params?.id;
    if (!id) throw new ValidationError("id is required");
    deleteInvitation(id);
    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// ── Public: lookup by raw token ──
export async function handleLookupInvitation(request: Request): Promise<Response> {
  const rl = checkRateLimit(request);
  if (rl) return rl;
  try {
    const token = (request as any).params?.token as string | undefined;
    if (!token) throw new ValidationError("token is required");
    const row = getInvitationByTokenHash(hashToken(token));
    if (!row) {
      return Response.json({ valid: false, reason: "not_found" }, { headers: corsHeaders });
    }
    if (row.accepted_at) {
      return Response.json({ valid: false, reason: "already_accepted", email: row.email }, { headers: corsHeaders });
    }
    if (row.expires_at < nowSeconds()) {
      return Response.json({ valid: false, reason: "expired", email: row.email }, { headers: corsHeaders });
    }
    return Response.json({ valid: true, email: row.email, expiresAt: row.expires_at }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// ── Public: accept ──
export async function handleAcceptUserInvitation(request: Request): Promise<Response> {
  const rl = checkRateLimit(request);
  if (rl) return rl;
  try {
    const token = (request as any).params?.token as string | undefined;
    if (!token) throw new ValidationError("token is required");

    const body = await request.json() as { password?: string };
    if (!body.password) throw new ValidationError("password is required");
    const parsed = passwordSchema.safeParse(body.password);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
    }

    const row = getInvitationByTokenHash(hashToken(token));
    if (!row) throw new AuthError("Invalid invitation");
    if (row.accepted_at) throw new AuthError("Invitation already accepted");
    if (row.expires_at < nowSeconds()) throw new AuthError("Invitation expired");

    if (getUserByEmail(row.email)) {
      throw new AuthError("A user with that email already exists");
    }

    const passwordHash = await bcrypt.hash(body.password, 10);
    const newUser = insertUser(row.email, passwordHash);

    // Apply invite-time settings
    db.prepare(
      "UPDATE users SET can_create_projects = ?, token_limit = ? WHERE id = ?"
    ).run(row.can_create_projects, row.token_limit, newUser.id);

    markInvitationAccepted(row.id, newUser.id);
    inviteLog.info("invitation accepted", { id: row.id, userId: newUser.id, email: row.email });

    const fullUser = getUserById(newUser.id)!;
    const isDev = process.env.NODE_ENV !== "production";
    if (!isDev && isTotpRequired(fullUser)) {
      const tempToken = await createTempToken(newUser.id);
      return Response.json(
        { requires2FASetup: true, tempToken, user: { id: newUser.id, email: newUser.email } },
        { status: 201, headers: corsHeaders },
      );
    }

    const authToken = await createToken({ userId: newUser.id, email: newUser.email });
    return Response.json(
      { token: authToken, user: { id: newUser.id, email: newUser.email } },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
