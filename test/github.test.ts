import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubAuthorizeUrl, githubUrls, pkcePair } from "../src/github";

describe("githubUrls", () => {
  it("uses GitHub unless the override is a loopback host", () => {
    expect(githubUrls(undefined).token).toBe("https://github.com/login/oauth/access_token");
    expect(githubUrls("https://evil.example").user).toBe("https://api.github.com/user");
    expect(githubUrls("http://127.0.0.1:8791").user).toBe("http://127.0.0.1:8791/user");
  });
});

describe("pkce", () => {
  it("derives an S256 challenge", async () => {
    const { verifier, challenge } = await pkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    const url = new URL(githubAuthorizeUrl(githubUrls(undefined), "cid", "https://h/callback", "st", challenge));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
  });
});
