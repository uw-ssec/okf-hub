import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { githubAuthorizeUrl, githubUrls, githubUserId, pkcePair, publicBase } from "./github";
import { consentPage, errorPage, htmlResponse } from "./pages";
import { PolicyError, parseExcludes, sanitizeActor, scopesFor, type Access, type GrantProps } from "./policy";

/** What survives the GitHub round trip (encrypted by the library; never sent to GitHub). */
type UpstreamData = { verifier: string; access: Access; exclude: string[] };

/** Errors from the helpers, per the library's consent-page guidance: redirect only when it's safe. */
function authorizeFailure(err: unknown): Response {
  if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
  if (err instanceof AuthorizationError) {
    return htmlResponse(400, errorPage("This sign-in link can't be used", `${err.description} Start connecting again from the app.`));
  }
  if (err instanceof CimdFetchError) {
    return htmlResponse(400, errorPage("App could not be verified", "This app's metadata document could not be fetched."));
  }
  console.error("authorize failed", err);
  return htmlResponse(502, errorPage("Sign-in failed", "GitHub sign-in didn't complete. Existing connections keep working; try again later."));
}

/** GET shows the consent page; POST approves (then GitHub sign-in) or denies. Consent comes first, per MCP's confused-deputy rule. */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest); // first: a failed lookup leaves nothing in KV
      const consent = await oauth.beginConsent(authRequest);
      return htmlResponse(200, consentPage(details, consent.handle), consent.headers);
    }
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const access: Access = form.get("access") === "full" ? "full" : "read";
    let exclude: string[];
    try {
      exclude = parseExcludes(String(form.get("exclude") ?? ""));
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      return htmlResponse(400, errorPage("Hidden folders not accepted", `${err.message}. Go back and fix the list.`));
    }
    const approved = await oauth.approveConsent(request, handle, { scope: scopesFor(access) });
    const { verifier, challenge } = await pkcePair();
    const data: UpstreamData = { verifier, access, exclude };
    const upstream = await oauth.beginUpstream(approved.request, { data, headers: approved.headers });
    upstream.headers.set(
      "Location",
      githubAuthorizeUrl(githubUrls(env.GITHUB_BASE_URL), env.GITHUB_CLIENT_ID, `${publicBase(env)}/callback`, upstream.state, challenge),
    );
    return new Response(null, { status: 302, headers: upstream.headers });
  } catch (err) {
    return authorizeFailure(err);
  }
}

/** GitHub sends the browser back here; only ALLOWED_GITHUB_USER_ID completes a grant. */
export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    const { request: original, data, headers } = await oauth.finishUpstream<UpstreamData>(request);
    const params = new URL(request.url).searchParams;
    const code = params.get("code");
    if (params.get("error") || !code) {
      headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
      return new Response(null, { status: 302, headers });
    }
    const userId = await githubUserId(githubUrls(env.GITHUB_BASE_URL), env, code, data.verifier, `${publicBase(env)}/callback`);
    if (String(userId) !== env.ALLOWED_GITHUB_USER_ID) {
      return htmlResponse(403, errorPage("Not allowed", "This GitHub account can't approve access to this knowledge bundle. No access was granted."), headers);
    }
    const client = await oauth.lookupClient(original.clientId);
    const clientName = sanitizeActor(client?.clientName ?? original.clientId);
    const props: GrantProps = { githubUserId: userId, clientId: original.clientId, clientName, access: data.access, exclude: data.exclude };
    const { redirectTo } = await oauth.completeAuthorization({
      request: original,
      userId: String(userId),
      metadata: { clientName, access: data.access, exclude: data.exclude, approvedAt: new Date().toISOString() },
      scope: original.scope,
      props,
    });
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (err) {
    return authorizeFailure(err);
  }
}
