import { githubAuthorizeUrl, githubUrls, githubUserId, pkcePair, publicBase } from "./github";
import { errorPage, grantsPage, htmlResponse, type GrantRow } from "./pages";
import { cookie, csrfMatches, csrfToken, readCookie, signSession, verifySession } from "./session";

const SESSION_COOKIE = "__Host-okf-grants";
const LOGIN_COOKIE = "__Host-okf-grants-login";
const SESSION_TTL = 8 * 3600;
const LOGIN_TTL = 600;
const now = () => Math.floor(Date.now() / 1000);

function redirect(location: string, status = 302, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status, headers });
}

/** Send the browser to GitHub; the state and PKCE verifier ride in a short-lived cookie. */
async function startLogin(env: Env): Promise<Response> {
  const state = crypto.randomUUID();
  const { verifier, challenge } = await pkcePair();
  const url = githubAuthorizeUrl(githubUrls(env.GITHUB_BASE_URL), env.GITHUB_CLIENT_ID, `${publicBase(env)}/callback/grants`, state, challenge);
  return redirect(url, 302, [cookie(LOGIN_COOKIE, `${state}.${verifier}`, LOGIN_TTL)]);
}

async function finishLogin(request: Request, env: Env, url: URL): Promise<Response> {
  const [state, verifier] = (readCookie(request, LOGIN_COOKIE) ?? "").split(".");
  const code = url.searchParams.get("code");
  if (!state || !verifier || url.searchParams.get("state") !== state || !code) {
    return htmlResponse(400, errorPage("Sign-in expired", "Open the grants page again to sign in."));
  }
  let userId: number;
  try {
    userId = await githubUserId(githubUrls(env.GITHUB_BASE_URL), env, code, verifier, `${publicBase(env)}/callback/grants`);
  } catch (err) {
    console.error("grants sign-in failed", err);
    return htmlResponse(502, errorPage("Sign-in failed", "GitHub sign-in didn't complete; try again later."));
  }
  if (String(userId) !== env.ALLOWED_GITHUB_USER_ID) {
    return htmlResponse(403, errorPage("Not allowed", "This GitHub account can't manage access to this knowledge bundle."));
  }
  const session = await signSession(env.COOKIE_SECRET, String(userId), now(), SESSION_TTL);
  return redirect("/grants", 303, [cookie(SESSION_COOKIE, session, SESSION_TTL), cookie(LOGIN_COOKIE, "", 0)]);
}

async function grantRows(env: Env, userId: string): Promise<GrantRow[]> {
  const rows: GrantRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(userId, { cursor });
    for (const g of page.items) {
      const m = (g.metadata ?? {}) as { clientName?: string; access?: string; exclude?: string[]; approvedAt?: string };
      rows.push({
        id: g.id,
        clientName: m.clientName ?? g.clientId,
        access: m.access ?? "unknown",
        exclude: m.exclude ?? [],
        approvedAt: m.approvedAt ?? new Date(g.createdAt * 1000).toISOString(),
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return rows.sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
}

/** /grants (list), /grants/revoke (POST + CSRF), /callback/grants (GitHub sign-in for this page). */
export async function handleGrants(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/callback/grants") return finishLogin(request, env, url);
  const session = readCookie(request, SESSION_COOKIE);
  const userId = session ? await verifySession(env.COOKIE_SECRET, session, now()) : null;
  if (!session || userId === null || userId !== env.ALLOWED_GITHUB_USER_ID) return startLogin(env);
  if (url.pathname === "/grants/revoke" && request.method === "POST") {
    const form = await request.formData();
    if (!(await csrfMatches(env.COOKIE_SECRET, session, String(form.get("csrf") ?? "")))) {
      return htmlResponse(403, errorPage("Form expired", "Reload the grants page and try again."));
    }
    await env.OAUTH_PROVIDER.revokeGrant(String(form.get("grant_id") ?? ""), userId);
    return redirect("/grants", 303);
  }
  if (url.pathname !== "/grants" || request.method !== "GET") return new Response("not found", { status: 404 });
  return htmlResponse(200, grantsPage(await grantRows(env, userId), await csrfToken(env.COOKIE_SECRET, session)));
}
