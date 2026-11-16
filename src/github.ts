/** GitHub sign-in: endpoints, PKCE, and exchanging a code for the signed-in account's id. */
export type GithubUrls = { authorize: string; token: string; user: string };

/** The Worker's public origin, without a trailing slash. */
export function publicBase(env: { PUBLIC_URL: string }): string {
  return env.PUBLIC_URL.replace(/\/+$/, "");
}

/** GitHub's endpoints, or a local fake's when baseUrl is a loopback host (tests only). */
export function githubUrls(baseUrl: string | undefined): GithubUrls {
  if (baseUrl) {
    const { hostname } = new URL(baseUrl);
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      const base = baseUrl.replace(/\/+$/, "");
      return { authorize: `${base}/login/oauth/authorize`, token: `${base}/login/oauth/access_token`, user: `${base}/user` };
    }
  }
  return {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    user: "https://api.github.com/user",
  };
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** No GitHub scopes: sign-in only needs the public profile's numeric id. */
export function githubAuthorizeUrl(urls: GithubUrls, clientId: string, redirectUri: string, state: string, challenge: string): string {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    allow_signup: "false",
  });
  return `${urls.authorize}?${query}`;
}

/** Exchange GitHub's code and return the signed-in account's numeric id. Throws on any failure. */
export async function githubUserId(
  urls: GithubUrls,
  creds: { GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string },
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<number> {
  const tokenResponse = await fetch(urls.token, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.GITHUB_CLIENT_ID,
      client_secret: creds.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const token = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!token.access_token) throw new Error(`GitHub code exchange failed: ${token.error ?? tokenResponse.status}`);
  const userResponse = await fetch(urls.user, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "okf-hub" },
  });
  if (!userResponse.ok) throw new Error(`GitHub user lookup failed: ${userResponse.status}`);
  const user = (await userResponse.json()) as { id?: unknown };
  if (typeof user.id !== "number") throw new Error("GitHub user lookup returned no id");
  return user.id;
}
