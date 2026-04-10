import bcrypt from "bcrypt";
import { corsHeaders } from "@/lib/cors.ts";
import { requireAdmin } from "@/lib/auth.ts";
import { db, generateId } from "@/db/index.ts";
import { handleError } from "@/routes/utils.ts";
import { log } from "@/lib/logger.ts";
import type { UserRow } from "@/db/types.ts";
import { getUserTokenTotalsByIds } from "@/db/queries/usage-logs.ts";

const adminLog = log.child({ module: "admin" });

export async function handleListUsers(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);

    const users = db.prepare(
      "SELECT id, username, is_admin, can_create_projects, token_limit, created_at FROM users ORDER BY created_at"
    ).all() as Pick<UserRow, "id" | "username" | "is_admin" | "can_create_projects" | "token_limit" | "created_at">[];

    const tokensUsedMap = getUserTokenTotalsByIds(users.map((u) => u.id));

    return Response.json(
      {
        users: users.map((u) => ({
          id: u.id,
          username: u.username,
          isAdmin: u.is_admin === 1,
          canCreateProjects: u.can_create_projects !== 0,
          tokenLimit: u.token_limit ?? null,
          tokensUsed: tokensUsedMap[u.id] ?? 0,
          createdAt: u.created_at,
        })),
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateUser(request: Request): Promise<Response> {
  try {
    const { userId } = await requireAdmin(request);
    const body: any = await request.json();
    const { username, password } = body;

    if (!username || !password) {
      return Response.json(
        { error: "Email and password are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Check if username already exists
    const existing = db.prepare(
      "SELECT id FROM users WHERE username = ?"
    ).get(username);
    if (existing) {
      return Response.json(
        { error: "Email already registered" },
        { status: 409, headers: corsHeaders }
      );
    }

    const id = generateId();
    const passwordHash = await bcrypt.hash(password, 10);
    const canCreate = body.canCreateProjects !== false ? 1 : 0;
    db.prepare(
      "INSERT INTO users (id, username, password_hash, is_admin, can_create_projects) VALUES (?, ?, ?, 0, ?)"
    ).run(id, username, passwordHash, canCreate);

    adminLog.info("user created by admin", { createdBy: userId, newUser: id, username });

    return Response.json(
      { id, username, isAdmin: false, canCreateProjects: canCreate === 1, createdAt: new Date().toISOString() },
      { status: 201, headers: corsHeaders }
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteUser(request: Request): Promise<Response> {
  try {
    const { userId: adminId } = await requireAdmin(request);
    const url = new URL(request.url);
    const targetId = url.pathname.split("/").pop()!;

    if (targetId === adminId) {
      return Response.json(
        { error: "Cannot delete your own account" },
        { status: 400, headers: corsHeaders }
      );
    }

    const user = db.prepare(
      "SELECT id FROM users WHERE id = ?"
    ).get(targetId);
    if (!user) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    db.prepare("DELETE FROM users WHERE id = ?").run(targetId);
    adminLog.info("user deleted by admin", { deletedBy: adminId, deletedUser: targetId });

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateUser(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const url = new URL(request.url);
    const targetId = url.pathname.split("/").pop()!;
    const body: any = await request.json();

    const user = db.prepare(
      "SELECT id FROM users WHERE id = ?"
    ).get(targetId);
    if (!user) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    if (body.password) {
      const passwordHash = await bcrypt.hash(body.password, 10);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, targetId);
    }

    if (body.canCreateProjects !== undefined) {
      db.prepare("UPDATE users SET can_create_projects = ? WHERE id = ?").run(body.canCreateProjects ? 1 : 0, targetId);
    }

    if (body.tokenLimit !== undefined) {
      if (body.tokenLimit === null) {
        db.prepare("UPDATE users SET token_limit = NULL WHERE id = ?").run(targetId);
      } else {
        const limit = Number(body.tokenLimit);
        if (!Number.isFinite(limit) || limit < 0 || !Number.isInteger(limit)) {
          return Response.json(
            { error: "tokenLimit must be a non-negative integer or null" },
            { status: 400, headers: corsHeaders }
          );
        }
        db.prepare("UPDATE users SET token_limit = ? WHERE id = ?").run(limit, targetId);
      }
    }

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
