// Stand-in for an OIDC provider (Keycloak), for local tests only: publishes a JWKS and mints RS256
// access tokens with whatever claims a test asks for.
// Usage: node test/fake-oidc.mjs <port>
//   GET  /certs                       the JWKS
//   POST /token  {claims, key?}       a signed token; key "other" signs with a key not in the JWKS
import http from "node:http";
import { generateKeyPairSync, createSign } from "node:crypto";

const [, , port] = process.argv;
const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...good.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function mint(claims, which) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" }));
  const body = b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, ...claims }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(signer.sign((which === "other" ? other : good).privateKey))}`;
}

http
  .createServer(async (req, res) => {
    if (req.url === "/certs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.url === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("body must be JSON: {claims, key?}");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(mint(request.claims, request.key));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(Number(port), "127.0.0.1");
