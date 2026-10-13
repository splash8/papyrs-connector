import OAuthProvider, { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { PapyrsClient, PapyrsError, escapeHtml } from "./papyrs";
import { buildServer, type Env, type Props } from "./tools";

// ---------------- MCP endpoint (only reachable with a valid OAuth token) ----------------

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: Props }): Promise<Response> {
    // Stateless: a fresh server per request, bound to the caller's own Papyrs token.
    const server = buildServer(env, ctx.props);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

// ---------------- Sign-in page: each person pastes their own Papyrs API token ----------------

function page(details: ConsentDescription, handle: string, env: Env, error?: string, email = ""): string {
  const site = escapeHtml(env.PAPYRS_BASE_URL.replace(/^https?:\/\//, ""));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Papyrs to ${escapeHtml(details.clientName)}</title>
<style>
 body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f6f8;color:#1c2330;margin:0;padding:24px}
 main{max-width:460px;margin:6vh auto;background:#fff;border-radius:10px;padding:28px;box-shadow:0 1px 3px #0002}
 h1{font-size:20px;margin:0 0 6px} p{line-height:1.5;font-size:14px;color:#4a5568}
 label{display:block;font-size:13px;font-weight:600;margin:16px 0 4px}
 input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd2dc;border-radius:6px;font-size:14px}
 .err{background:#fdecec;color:#9b1c1c;padding:10px;border-radius:6px;font-size:14px}
 .row{display:flex;gap:10px;margin-top:22px} button{flex:1;padding:10px;border-radius:6px;border:0;font-size:14px;cursor:pointer}
 .ok{background:#1f4e8c;color:#fff} .no{background:#e2e6ec}
 small{color:#718096}
</style></head><body><main>
<h1>Connect ${site} to ${escapeHtml(details.clientName)}</h1>
<p>Claude will read and draft on Papyrs <b>as you</b>, with exactly your Papyrs permissions. Access goes to <b>${escapeHtml(details.redirectHost)}</b>.
Anything Claude writes lands first as a private draft flagged for review.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post">
 <input type="hidden" name="handle" value="${escapeHtml(handle)}">
 <input type="hidden" name="cn" value="${escapeHtml(details.clientName)}">
 <input type="hidden" name="rh" value="${escapeHtml(details.redirectHost)}">
 <label for="email">Your Papyrs email</label>
 <input id="email" name="email" type="email" required autocomplete="email" value="${escapeHtml(email)}">
 <label for="token">Your personal Papyrs API token</label>
 <input id="token" name="token" type="password" required autocomplete="off">
 <small>Get it from your Papyrs admin. Never use someone else's token.</small>
 <div class="row"><button class="no" name="decision" value="deny" formnovalidate>Cancel</button><button class="ok" name="decision" value="approve">Connect</button></div>
</form></main></body></html>`;
}

const html = (body: string, headers: Headers, status = 200) => {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status, headers });
};

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("ch-aviation Papyrs connector for Claude. MCP endpoint: /mcp", { headers: { "Content-Type": "text/plain" } });
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });

    const oauth = env.OAUTH_PROVIDER;
    try {
      if (request.method === "GET") {
        const authReq = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authReq);
        const allowed = (env.ALLOWED_REDIRECT_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
        if (allowed.length && !allowed.includes(details.redirectHost))
          return new Response(`This connector only works with: ${allowed.join(", ")}`, { status: 403 });
        const consent = await oauth.beginConsent(authReq);
        return html(page(details, consent.handle, env), consent.headers);
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const handle = String(form.get("handle") ?? "");
        if (form.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const email = String(form.get("email") ?? "").trim().toLowerCase();
        const token = String(form.get("token") ?? "").trim();

        // Validate the token and find this person's Papyrs user ID BEFORE consuming the handle,
        // so a typo just shows the form again.
        let person;
        let limited = false;
        try {
          const people = await new PapyrsClient(env.PAPYRS_BASE_URL, token).people();
          person = people.find((p) => (p.attributes.Email ?? "").trim().toLowerCase() === email);
        } catch (e) {
          // Limited Users can't open the People Directory. If the token still works for pages,
          // connect them read-only instead of refusing.
          if (e instanceof PapyrsError && (e.status === 401 || e.status === 403 || e.status === 404)) {
            try {
              await new PapyrsClient(env.PAPYRS_BASE_URL, token, env.PAPYRS_SUBSITE).allPages();
              limited = true;
            } catch {
              /* the token doesn't work at all: fall through to the error below */
            }
          }
          if (!limited) {
            // Show Papyrs' own reply too, so an admin can see why the token was refused.
            const msg = e instanceof PapyrsError && (e.status === 401 || e.status === 403 || e.status === 404)
              ? `Papyrs did not accept this token. Papyrs replied ${e.status}: ${e.message}`
              : e instanceof PapyrsError ? e.message : "Could not reach Papyrs. Try again in a minute.";
            return retry(form, env, handle, msg, email);
          }
        }
        if (!person && !limited) return retry(form, env, handle, "No Papyrs user with that email. Use the email you sign in to Papyrs with.", email);

        const approved = await oauth.approveConsent(request, handle);
        const props: Props = { papyrsToken: token, papyrsUserId: person?.id ?? "", name: person?.attributes.Name || email, email };
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: person?.id ?? `limited-${email}`,
          metadata: { email, connectedAt: new Date().toISOString() },
          scope: approved.request.scope,
          props,
        });
        approved.headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const msg = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
        return new Response(`${msg}\nPlease start the connection again from Claude.`, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      throw error;
    }
  },
};

/** Re-render the form with an error. The handle has not been consumed yet, so it is still valid. */
async function retry(form: FormData, env: Env, handle: string, error: string, email: string): Promise<Response> {
  // Display-only values carried from the first render (escaped again on output).
  const details = { clientName: String(form.get("cn") ?? "Claude"), redirectHost: String(form.get("rh") ?? "") } as ConsentDescription;
  const headers = new Headers({ "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" });
  return html(page(details, handle, env, error, email), headers, 400);
}

// The OAuth metadata needs the public URL, which lives in env, so build the provider on first request.
let provider: OAuthProvider<Env> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const base = env.PUBLIC_URL.replace(/\/+$/, "");
    provider ??= new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler as never,
      defaultHandler: defaultHandler as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["papyrs"],
      resourceMetadata: { resource: `${base}/mcp`, authorization_servers: [base] },
      accessTokenTTL: 60 * 60, // 1 hour; refresh tokens keep people connected
    });
    return provider.fetch(request, env, ctx);
  },
};
