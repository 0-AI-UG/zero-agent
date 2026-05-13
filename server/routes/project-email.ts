/**
 * Per-project mailbox config: status, toggle, verify (autoconfig + login probe),
 * restart.
 *
 * Project owners (or admins) configure the project's email account here.
 * Verify persists discovered hosts/ports/credentials on success and bounces
 * the IMAP IDLE loop so the new creds take effect immediately.
 */
import { corsHeaders } from "@/lib/http/cors.ts";
import { authenticateRequest } from "@/lib/auth/auth.ts";
import { handleError, verifyProjectAccess, verifyProjectOwnership } from "@/routes/utils.ts";
import {
  getProjectById,
  setProjectEmailConfig,
  updateProject,
} from "@/db/queries/projects.ts";
import {
  isFeatureEnabled,
  encryptMailboxPassword,
  decryptMailboxPassword,
  startProjectMailbox,
  stopProjectMailbox,
  restartProjectMailbox,
  isProjectMailboxReady,
} from "@/lib/email-global/mailbox.ts";
import { autoconfigure } from "@/lib/email-global/autoconfig.ts";
import { listEmailMessages } from "@/db/queries/email-messages.ts";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { log } from "@/lib/utils/logger.ts";

const peLog = log.child({ module: "routes/project-email" });

interface RequestWithId extends Request {
  params: { id: string };
}

function configured(p: { email_address: string | null; email_password_enc: string | null; email_imap_host: string | null; email_smtp_host: string | null }): boolean {
  return !!(p.email_address && p.email_password_enc && p.email_imap_host && p.email_smtp_host);
}

export async function handleGetProjectEmail(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id } = (request as RequestWithId).params;
    const project = verifyProjectAccess(id, userId);
    const recent = listEmailMessages({ projectId: project.id, limit: 1 });

    return Response.json({
      enabled: project.email_enabled === 1,
      featureEnabled: isFeatureEnabled(),
      configured: configured(project),
      ready: isProjectMailboxReady(project.id),
      address: project.email_address,
      fromName: project.email_from_name,
      imapHost: project.email_imap_host,
      imapPort: project.email_imap_port,
      imapSecure: project.email_imap_secure,
      smtpHost: project.email_smtp_host,
      smtpPort: project.email_smtp_port,
      smtpSecure: project.email_smtp_secure,
      autoconfigStatus: project.email_autoconfig_status,
      lastInboundAt: recent[0]?.received_at ?? null,
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

interface ToggleBody { enabled?: boolean }

export async function handleUpdateProjectEmail(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id } = (request as RequestWithId).params;
    const project = verifyProjectOwnership(id, userId);
    const body = (await request.json()) as ToggleBody;

    if (body.enabled === true) {
      if (!isFeatureEnabled()) {
        return Response.json({ error: "email integration disabled by admin" }, { status: 403, headers: corsHeaders });
      }
      if (!configured(project)) {
        return Response.json({ error: "configure mailbox first (POST /verify)" }, { status: 400, headers: corsHeaders });
      }
      updateProject(project.id, { emailEnabled: true });
      await startProjectMailbox(project.id);
    } else if (body.enabled === false) {
      updateProject(project.id, { emailEnabled: false });
      await stopProjectMailbox(project.id);
    }

    return handleGetProjectEmail(request);
  } catch (error) {
    return handleError(error);
  }
}

interface VerifyBody {
  address?: string;
  password?: string;
  fromName?: string;
  manual?: {
    imapHost: string; imapPort: number; imapSecure: "tls" | "starttls";
    smtpHost: string; smtpPort: number; smtpSecure: "tls" | "starttls";
  };
}

export async function handleVerifyProjectEmail(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id } = (request as RequestWithId).params;
    const project = verifyProjectOwnership(id, userId);
    if (!isFeatureEnabled()) {
      return Response.json({ error: "email integration disabled by admin" }, { status: 403, headers: corsHeaders });
    }
    const body = (await request.json()) as VerifyBody;
    const address = (body.address || project.email_address || "").trim();
    if (!address) return Response.json({ ok: false, error: "address required" }, { status: 400, headers: corsHeaders });

    // Resolve password: caller may submit a new one, or we reuse the stored one.
    let passwordEnc = project.email_password_enc;
    if (body.password) passwordEnc = await encryptMailboxPassword(body.password);
    if (!passwordEnc) return Response.json({ ok: false, error: "password required" }, { status: 400, headers: corsHeaders });
    const pass = await decryptMailboxPassword(passwordEnc);

    // Discover endpoints (manual override wins).
    let imap = body.manual
      ? { host: body.manual.imapHost, port: body.manual.imapPort, secure: body.manual.imapSecure }
      : null;
    let smtp = body.manual
      ? { host: body.manual.smtpHost, port: body.manual.smtpPort, secure: body.manual.smtpSecure }
      : null;
    let source = body.manual ? "manual" : "autoconfig";
    if (!imap || !smtp) {
      const discovered = await autoconfigure(address);
      if (discovered?.imap) imap = discovered.imap;
      if (discovered?.smtp) smtp = discovered.smtp;
      source = discovered?.source ?? "guess";
    }
    if (!imap || !smtp) {
      return Response.json({ ok: false, error: "could not discover endpoints" }, { status: 400, headers: corsHeaders });
    }

    // Probe IMAP.
    let imapOk = false; let imapErr: string | null = null;
    try {
      const client = new ImapFlow({ host: imap.host, port: imap.port, secure: imap.secure === "tls", auth: { user: address, pass }, logger: false });
      await client.connect();
      await client.logout();
      imapOk = true;
    } catch (err) {
      imapErr = err instanceof Error ? err.message : String(err);
    }

    // Probe SMTP.
    let smtpOk = false; let smtpErr: string | null = null;
    try {
      const transport = nodemailer.createTransport({
        host: smtp.host, port: smtp.port,
        secure: smtp.secure === "tls",
        requireTLS: smtp.secure === "starttls",
        auth: { user: address, pass },
      });
      await transport.verify();
      transport.close();
      smtpOk = true;
    } catch (err) {
      smtpErr = err instanceof Error ? err.message : String(err);
    }

    if (imapOk && smtpOk) {
      setProjectEmailConfig(project.id, {
        address,
        passwordEnc,
        fromName: body.fromName ?? project.email_from_name,
        imapHost: imap.host,
        imapPort: imap.port,
        imapSecure: imap.secure,
        smtpHost: smtp.host,
        smtpPort: smtp.port,
        smtpSecure: smtp.secure,
        autoconfigStatus: "ok",
      });
      peLog.info("project email verified", { projectId: project.id, address, source });
      // Bounce the loop so new creds take effect.
      if (project.email_enabled === 1) await restartProjectMailbox(project.id);
      return Response.json({ ok: true, imap, smtp, source }, { headers: corsHeaders });
    }

    // On failure: still persist the address + discovered endpoints so the
    // form keeps state, but mark autoconfig_status accordingly.
    setProjectEmailConfig(project.id, {
      address,
      passwordEnc,
      fromName: body.fromName ?? project.email_from_name,
      imapHost: imap.host,
      imapPort: imap.port,
      imapSecure: imap.secure,
      smtpHost: smtp.host,
      smtpPort: smtp.port,
      smtpSecure: smtp.secure,
      autoconfigStatus: `failed:${imapOk ? "" : "imap "}${smtpOk ? "" : "smtp"}`.trim(),
    });
    return Response.json({
      ok: false,
      imap: { ...imap, ok: imapOk, error: imapErr },
      smtp: { ...smtp, ok: smtpOk, error: smtpErr },
      source,
    }, { status: 400, headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRestartProjectEmail(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { id } = (request as RequestWithId).params;
    const project = verifyProjectOwnership(id, userId);
    if (project.email_enabled !== 1) {
      return Response.json({ ok: false, error: "email not enabled for project" }, { status: 400, headers: corsHeaders });
    }
    await restartProjectMailbox(project.id);
    return Response.json({ ok: true, ready: isProjectMailboxReady(project.id) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
