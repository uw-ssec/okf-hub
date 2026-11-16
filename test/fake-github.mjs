// Stand-in for GitHub's OAuth endpoints and /user, for local tests only.
// Usage: node test/fake-github.mjs <port> <userId>
//   GET /_set_user?id=N   sign in as user N next; id=deny makes GitHub decline.
import http from "node:http";

const [, , port, initialUser] = process.argv;
let user = initialUser;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/_set_user") {
      user = url.searchParams.get("id");
      res.end("ok");
      return;
    }
    if (url.pathname === "/login/oauth/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("state", url.searchParams.get("state"));
      if (user === "deny") back.searchParams.set("error", "access_denied");
      else back.searchParams.set("code", `code-${user}`);
      res.writeHead(302, { Location: back.href });
      res.end();
      return;
    }
    if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const code = new URLSearchParams(body).get("code") ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(code.startsWith("code-") ? { access_token: `tok-${code.slice(5)}`, token_type: "bearer" } : { error: "bad_verification_code" }));
      return;
    }
    if (url.pathname === "/user") {
      const auth = req.headers.authorization ?? "";
      const id = auth.startsWith("Bearer tok-") ? Number(auth.slice(11)) : NaN;
      if (!Number.isFinite(id)) {
        res.writeHead(401);
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, login: `user${id}` }));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(Number(port), "127.0.0.1");
