/** HMAC-signed cookies for the /grants page: a short GitHub login session and its CSRF token. */
const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("COOKIE_SECRET is missing or too short");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fromB64url(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
const sign = async (secret: string, message: string) => b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message)));
async function verify(secret: string, message: string, signature: string): Promise<boolean> {
  const bytes = fromB64url(signature);
  return !!bytes && bytes.length > 0 && crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, enc.encode(message));
}

/** "<userId>.<expiry>.<signature>"; the signature covers both fields. */
export async function signSession(secret: string, userId: string, nowSeconds: number, ttlSeconds: number): Promise<string> {
  const payload = `${userId}.${nowSeconds + ttlSeconds}`;
  return `${payload}.${await sign(secret, `session.${payload}`)}`;
}

/** The session's user id, or null if it is forged, malformed, or expired. */
export async function verifySession(secret: string, value: string, nowSeconds: number): Promise<string | null> {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiry, signature] = parts;
  if (!(await verify(secret, `session.${userId}.${expiry}`, signature))) return null;
  return Number(expiry) > nowSeconds ? userId : null;
}

export const csrfToken = (secret: string, session: string) => sign(secret, `csrf.${session}`);
export const csrfMatches = (secret: string, session: string, token: string) => verify(secret, `csrf.${session}`, token);

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** A host-only cookie (`__Host-` names require Secure and Path=/ with no Domain). */
export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
