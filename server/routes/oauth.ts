// Routes for the Codex inference provider.
//
// Auth model: since the public Codex OAuth client is locked to
// http://localhost:1455/auth/callback (which will never exist on a VPS),
// we don't run the OAuth flow ourselves. Instead the admin runs
// `codex login` on a machine with a browser and pastes the contents of
// ~/.codex/auth.json into the admin UI. We extract the tokens and then
// refresh them autonomously like the Rust CLI does.

import { corsHeaders } from "@/lib/http/cors.ts";
import { requireAdmin } from "@/lib/auth/auth.ts";
import { handleError } from "@/routes/utils.ts";
import {
  getStatus,
  clearTokens,
  saveTokens,
  parseJwtClaims,
  extractAccountFromIdToken,
} from "@/lib/providers/codex-tokens.ts";

export async function handleCodexImport(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const body = (await request.json()) as { authJson?: string };
    if (!body.authJson || typeof body.authJson !== "string") {
      return Response.json(
        { error: "authJson string is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(body.authJson);
    } catch {
      return Response.json(
        { error: "authJson is not valid JSON" },
        { status: 400, headers: corsHeaders },
      );
    }

    if (parsed?.auth_mode !== "chatgpt") {
      return Response.json(
        { error: "Not a ChatGPT-mode codex auth.json (auth_mode must be \"chatgpt\")" },
        { status: 400, headers: corsHeaders },
      );
    }
    const t = parsed.tokens ?? {};
    const accessToken = typeof t.access_token === "string" ? t.access_token : null;
    const refreshToken = typeof t.refresh_token === "string" ? t.refresh_token : null;
    if (!accessToken || !refreshToken) {
      return Response.json(
        { error: "tokens.access_token and tokens.refresh_token are required" },
        { status: 400, headers: corsHeaders },
      );
    }
    const accountId = typeof t.account_id === "string" ? t.account_id : undefined;
    const idToken = typeof t.id_token === "string" ? t.id_token : undefined;

    const claims = parseJwtClaims(accessToken);
    const exp =
      claims && typeof claims.exp === "number"
        ? (claims.exp as number) * 1000
        : Date.now() + 3600 * 1000;

    let email: string | undefined;
    let derivedAccountId: string | undefined;
    if (idToken) {
      const extracted = extractAccountFromIdToken(idToken);
      email = extracted.email;
      derivedAccountId = extracted.accountId;
    }
    if (!email && claims) {
      const profile = (claims["https://api.openai.com/profile"] ?? {}) as Record<string, unknown>;
      if (typeof claims.email === "string") email = claims.email;
      else if (typeof profile.email === "string") email = profile.email;
    }

    await saveTokens({
      accessToken,
      refreshToken,
      idToken,
      expiresAt: exp,
      accountEmail: email,
      accountId: accountId ?? derivedAccountId,
    });

    return Response.json(
      { success: true, accountEmail: email },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCodexStatus(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const status = await getStatus();
    return Response.json(status, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCodexDisconnect(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    clearTokens();
    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
