import { log } from "@/lib/logger.ts";

export interface ChannelResult {
  status: "pending" | "sent" | "failed";
  error?: string;
}

const channelLog = log.child({ module: "channel:email" });

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const FROM_EMAIL = process.env.FROM_EMAIL ?? "";

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
): Promise<ChannelResult> {
  if (!to || !to.includes("@")) {
    return { status: "failed", error: "Invalid email address" };
  }

  if (!RESEND_API_KEY || !FROM_EMAIL) {
    channelLog.debug("no Resend API key configured");
    return { status: "failed", error: "Email not configured. Set RESEND_API_KEY and FROM_EMAIL environment variables." };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject,
        text: body,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      channelLog.error("Resend API error", { status: res.status, err });
      return { status: "failed", error: `Resend error: ${res.status}` };
    }

    channelLog.info("email sent via Resend", { to, subject });
    return { status: "sent" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    channelLog.error("email send failed", { error: msg });
    return { status: "failed", error: msg };
  }
}
