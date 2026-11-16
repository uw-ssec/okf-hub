import { describe, expect, it } from "vitest";
import { cookie, csrfMatches, csrfToken, readCookie, signSession, verifySession } from "../src/session";

const SECRET = "a".repeat(64);

describe("session", () => {
  it("round-trips and expires", async () => {
    const value = await signSession(SECRET, "4242", 1000, 60);
    expect(await verifySession(SECRET, value, 1059)).toBe("4242");
    expect(await verifySession(SECRET, value, 1060)).toBeNull();
  });
  it("rejects tampering, another secret, and junk", async () => {
    const value = await signSession(SECRET, "4242", 1000, 60);
    expect(await verifySession(SECRET, value.replace("4242", "999"), 1001)).toBeNull();
    expect(await verifySession("b".repeat(64), value, 1001)).toBeNull();
    expect(await verifySession(SECRET, "junk", 1001)).toBeNull();
    expect(await verifySession(SECRET, "a.b.!!!", 1001)).toBeNull();
  });
  it("refuses to sign with a short or missing secret", async () => {
    await expect(signSession("", "1", 0, 60)).rejects.toThrow(/COOKIE_SECRET/);
  });
  it("binds CSRF tokens to the session", async () => {
    const token = await csrfToken(SECRET, "s1");
    expect(await csrfMatches(SECRET, "s1", token)).toBe(true);
    expect(await csrfMatches(SECRET, "s2", token)).toBe(false);
    expect(await csrfMatches(SECRET, "s1", "")).toBe(false);
  });
  it("reads and writes host-only secure cookies", () => {
    const req = new Request("https://x/", { headers: { Cookie: "a=1; __Host-okf-grants=v.2.s" } });
    expect(readCookie(req, "__Host-okf-grants")).toBe("v.2.s");
    expect(readCookie(req, "missing")).toBeNull();
    expect(cookie("__Host-okf-grants", "v", 60)).toBe("__Host-okf-grants=v; Max-Age=60; Path=/; Secure; HttpOnly; SameSite=Lax");
  });
});
