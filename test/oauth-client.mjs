// OAuth test client for okf-hub's authorization server (local integration tests only).
//   register <base> <client_name>                                  -> {client_id, ...}
//   consent-page <base> <client_id>                                -> the consent page HTML
//   authorize <base> <client_id> <full|read> <exclude> <approve|deny>
//       -> {status:"ok", access_token, refresh_token, iss} | {status:"denied", error, iss} | {status:"page", code, text}
//   replay <base> <client_id>                                      -> {first, replay}: second use of the same callback
//   refresh <base> <client_id> <refresh_token>                     -> the token endpoint's JSON
//   grants-status <base>                                           -> {status} of /grants after GitHub sign-in
//   revoke <base> <client_name>                                    -> {revoked: n}
import { createHash, randomBytes } from "node:crypto";

const REDIRECT = "http://127.0.0.1:9/callback";
const jar = new Map();
let lastCallback = null;

function remember(res) {
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1);
    if (value === "" || /max-age=0/i.test(cookie) || /expires=thu, 01 jan 1970/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
}
async function go(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
  remember(res);
  return res;
}
const form = (fields) => ({ method: "POST", body: new URLSearchParams(fields), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function authorizeUrl(base, clientId, challenge) {
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "st-1",
    code_challenge: challenge, code_challenge_method: "S256", scope: "okf:read", resource: `${base}/mcp`,
  });
  return `${base}/authorize?${q}`;
}

/** Follow redirects (fake GitHub, our callbacks) until one leaves for the client or a page renders. */
async function follow(base, res) {
  for (let hops = 0; hops < 6 && res.status >= 300 && res.status < 400; hops++) {
    const location = new URL(res.headers.get("location"), base);
    if (location.href.startsWith(REDIRECT)) return { res, location };
    if (location.pathname === "/callback") lastCallback = location.href;
    res = await go(location.href);
  }
  return { res, location: null };
}

async function authorize(base, clientId, access, exclude, decision) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const page = await go(authorizeUrl(base, clientId, challenge));
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (page.status !== 200 || !handle) return { status: "page", code: page.status, text: html.slice(0, 300) };
  const { res, location } = await follow(base, await go(`${base}/authorize`, form({ handle, access, exclude, decision })));
  if (!location) return { status: "page", code: res.status, text: (await res.text()).slice(0, 300) };
  const p = location.searchParams;
  if (p.get("error")) return { status: "denied", error: p.get("error"), state: p.get("state"), iss: p.get("iss") };
  const tokenRes = await fetch(`${base}/token`, form({
    grant_type: "authorization_code", code: p.get("code"), redirect_uri: REDIRECT,
    client_id: clientId, code_verifier: verifier, resource: `${base}/mcp`,
  }));
  const token = await tokenRes.json();
  return { status: token.access_token ? "ok" : "token-error", state: p.get("state"), iss: p.get("iss"), ...token };
}

async function grantsPage(base) {
  const { res } = await follow(base, await go(`${base}/grants`));
  return res;
}

const [, , command, base, ...rest] = process.argv;
let out;
if (command === "register") {
  const res = await fetch(`${base}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: rest[0], redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  out = await res.json();
} else if (command === "consent-page") {
  const res = await go(authorizeUrl(base, rest[0], b64url(randomBytes(32))));
  process.stdout.write(await res.text());
  process.exit(0);
} else if (command === "authorize") {
  out = await authorize(base, rest[0], rest[1], rest[2], rest[3]);
} else if (command === "replay") {
  const first = await authorize(base, rest[0], "read", "", "approve");
  const again = lastCallback ? (await go(lastCallback)).status : null;
  out = { first: first.status, replay: again };
} else if (command === "refresh") {
  out = await (await fetch(`${base}/token`, form({ grant_type: "refresh_token", refresh_token: rest[1], client_id: rest[0] }))).json();
} else if (command === "grants-status") {
  out = { status: (await grantsPage(base)).status };
} else if (command === "revoke") {
  const html = await (await grantsPage(base)).text();
  const rows = [...html.matchAll(/<tr data-client="([^"]*)">[\s\S]*?name="grant_id" value="([^"]+)"[\s\S]*?name="csrf" value="([^"]+)"/g)];
  let revoked = 0;
  for (const [, name, grantId, csrf] of rows) {
    if (name !== rest[0]) continue;
    const res = await go(`${base}/grants/revoke`, form({ grant_id: grantId, csrf }));
    if (res.status === 303) revoked++;
  }
  out = { revoked };
} else {
  out = { error: `unknown command ${command}` };
}
console.log(JSON.stringify(out));
