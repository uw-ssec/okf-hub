/** Constant-time secret check. Hashing both sides first gives equal-length inputs. Fails closed. */
export async function secretMatches(presented: string, secret: string | undefined): Promise<boolean> {
  if (!secret || !presented) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Constant-time bearer check for the hub API. */
export async function bearerMatches(request: Request, secret: string | undefined): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  return secretMatches(header.startsWith("Bearer ") ? header.slice(7) : "", secret);
}
