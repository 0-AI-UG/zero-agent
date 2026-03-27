import { corsHeaders } from "@/lib/cors.ts";
import { requireAdmin } from "@/lib/auth.ts";
import { db, generateId } from "@/db/index.ts";
import { handleError } from "@/routes/utils.ts";
import { log } from "@/lib/logger.ts";
import type { UserRow } from "@/db/types.ts";

const adminLog = log.child({ module: "admin" });

export async function handleListUsers(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);

    const users = db.query<UserRow, []>(
      "SELECT id, email, is_admin, created_at FROM users ORDER BY created_at"
    ).all();

    return Response.json(
      {
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          isAdmin: (u as any).is_admin === 1,
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
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return Response.json(
        { error: "Email and password are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Check if email already exists
    const existing = db.query<{ id: string }, [string]>(
      "SELECT id FROM users WHERE email = ?"
    ).get(email);
    if (existing) {
      return Response.json(
        { error: "Email already registered" },
        { status: 409, headers: corsHeaders }
      );
    }

    const id = generateId();
    const passwordHash = await Bun.password.hash(password, "bcrypt");
    db.run(
      "INSERT INTO users (id, email, password_hash, is_admin) VALUES (?, ?, ?, 0)",
      [id, email, passwordHash]
    );

    adminLog.info("user created by admin", { createdBy: userId, newUser: id, email });

    return Response.json(
      { id, email, isAdmin: false, createdAt: new Date().toISOString() },
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

    const user = db.query<{ id: string }, [string]>(
      "SELECT id FROM users WHERE id = ?"
    ).get(targetId);
    if (!user) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    db.run("DELETE FROM users WHERE id = ?", [targetId]);
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
    const body = await request.json();

    const user = db.query<{ id: string }, [string]>(
      "SELECT id FROM users WHERE id = ?"
    ).get(targetId);
    if (!user) {
      return Response.json(
        { error: "User not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    if (body.password) {
      const passwordHash = await Bun.password.hash(body.password, "bcrypt");
      db.run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, targetId]);
    }

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
