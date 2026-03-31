import { db, generateId } from "@/db/index.ts";
import { DESKTOP_MODE } from "@/lib/auth.ts";
import { insertProjectMember } from "@/db/queries/members.ts";
import { log } from "@/lib/logger.ts";

const initLog = log.child({ module: "desktop-init" });

export async function initDesktopUser() {
  if (!DESKTOP_MODE) return;

  const existing = db.query<{ id: string }, [string]>(
    "SELECT id FROM users WHERE id = ?",
  ).get("desktop-user");

  if (!existing) {
    const hash = await Bun.password.hash(crypto.randomUUID(), "bcrypt");
    db.run(
      "INSERT INTO users (id, email, password_hash, is_admin) VALUES (?, ?, ?, 1)",
      ["desktop-user", "desktop@local", hash],
    );
    initLog.info("created desktop user");
  }

  const projectCount = db.query<{ count: number }, []>(
    "SELECT COUNT(*) as count FROM projects",
  ).get();

  if ((projectCount?.count ?? 0) === 0) {
    const projectId = generateId();
    db.run(
      "INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)",
      [projectId, "desktop-user", "My Project"],
    );
    insertProjectMember(projectId, "desktop-user", "owner");
    initLog.info("created default project", { projectId });
  }
}
