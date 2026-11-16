import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export type GrantRow = { id: string; clientName: string; access: string; exclude: string[]; approvedAt: string };

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--line:#d6d3d1;--accent:#1d4ed8;--on-accent:#fff;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--accent:#93c5fd;--on-accent:#1c1917;--warn:#fbbf24}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:40rem;margin:0 auto;padding:2rem 16px}h1{font-size:1.4rem}
fieldset{border:1px solid var(--line);border-radius:6px;margin:1rem 0}label{display:block;margin:.4rem 0}
input[type=text]{width:100%;box-sizing:border-box;padding:.45rem;border:1px solid var(--line);border-radius:4px;background:transparent;color:inherit}
button{padding:.5rem 1rem;margin:.25rem .5rem .25rem 0;border-radius:4px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button[value=approve]{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.hint{color:var(--muted);font-size:.9rem}.warn{color:var(--warn)}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.4rem;border-bottom:1px solid var(--line);vertical-align:top}`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

/** HTML response; adds a strict CSP unless the caller's headers (e.g. the library's consent headers) carry one. */
export function htmlResponse(status: number, html: string, headers: Headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  }
  return new Response(html, { status, headers });
}

export function consentPage(d: ConsentDescription, handle: string): string {
  const name = escapeHtml(d.clientName);
  const origin = d.clientDomain
    ? `Published by <strong>${escapeHtml(d.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const loopback = d.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>`
    : "";
  return layout(`Allow ${name}?`, `<h1>Allow <strong>${name}</strong> to use this knowledge bundle?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(d.redirectHost)}</strong>.</p>${loopback}
<p class="hint">It asked for: ${d.scope.map(escapeHtml).join(", ") || "no scopes"}.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<fieldset><legend>Access</legend>
<label><input type="radio" name="access" value="read" checked> Read only (search, show, validate)</label>
<label><input type="radio" name="access" value="full"> Read and write (all six tools)</label>
</fieldset>
<label>Hidden folders <input type="text" name="exclude" placeholder="people/" autocomplete="off"></label>
<p class="hint">Comma-separated. The app can't read or change these folders or see links into them.</p>
<p class="hint">You'll sign in with GitHub next.</p>
<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button>
</form>`);
}

export function errorPage(title: string, message: string): string {
  return layout(escapeHtml(title), `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

export function grantsPage(rows: GrantRow[], csrf: string): string {
  const body = rows.length
    ? rows
        .map(
          (r) => `<tr data-client="${escapeHtml(r.clientName)}"><td>${escapeHtml(r.clientName)}</td><td>${escapeHtml(r.access)}</td>
<td>${escapeHtml(r.exclude.join(", ") || "none")}</td><td>${escapeHtml(r.approvedAt)}</td>
<td><form method="post" action="/grants/revoke"><input type="hidden" name="grant_id" value="${escapeHtml(r.id)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button>Revoke</button></form></td></tr>`,
        )
        .join("\n")
    : `<tr><td colspan="5">No apps are connected.</td></tr>`;
  return layout("Connected apps", `<h1>Apps connected to this knowledge bundle</h1>
<table><thead><tr><th>App</th><th>Access</th><th>Hidden folders</th><th>Approved</th><th></th></tr></thead><tbody>${body}</tbody></table>
<p class="hint">Revoking ends the app's access at once; it will need approval again.</p>`);
}
