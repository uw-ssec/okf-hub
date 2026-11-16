import { describe, expect, it } from "vitest";
import { consentPage, errorPage, escapeHtml, grantsPage } from "../src/pages";

const details = {
  clientId: "c1",
  clientName: '<img src=x onerror="alert(1)">',
  redirectUri: "http://127.0.0.1:9/callback",
  redirectHost: "127.0.0.1",
  redirectIsLoopback: true,
  scope: ["okf:read"],
};

describe("pages", () => {
  it("escapes every client-chosen string", () => {
    const html = consentPage(details, 'h"1');
    expect(html).not.toContain("<img");
    expect(html).toContain(escapeHtml(details.clientName));
    expect(html).toContain('name="handle" value="h&#34;1"');
  });
  it("shows where tokens go, warns for local apps, and defaults to read-only", () => {
    const html = consentPage(details, "h1");
    expect(html).toContain("127.0.0.1");
    expect(html).toMatch(/app on your computer/);
    expect(html).toMatch(/value="read" checked/);
    expect(html).toContain('name="exclude"');
  });
  it("escapes error messages and grant rows", () => {
    expect(errorPage("<t>", "<m>")).not.toMatch(/<t>|<m>/);
    const rows = grantsPage([{ id: "g<1", clientName: "<b>x</b>", access: "read", exclude: ["people/"], approvedAt: "2026-10-07" }], "tok");
    expect(rows).toContain('data-client="&#60;b&#62;x&#60;/b&#62;"');
    expect(rows).toContain('name="grant_id" value="g&#60;1"');
    expect(rows).toContain('name="csrf" value="tok"');
  });
});
