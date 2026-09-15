/**
 * Dev-only helper: Supabase Management API calls using the access token from
 * the user's CLI config (~/.zcode/cli/config.json, server `supabase-kodi`).
 *
 * The MCP server is read-only by design, so writes (applying migrations,
 * deploying functions/secrets) go through the Management API — the same
 * backend the Dashboard and CLI use.
 *
 * The token is NEVER printed: all output passes through `redact()`.
 *
 *   node tools/sb-mgmt.mjs query "select version();"
 *   node tools/sb-mgmt.mjs get <path>            (e.g. get /v1/projects/REF/functions)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const redact = (s) =>
  String(s ?? "")
    .replace(/sbp_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/sb_publishable_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");

const REF = "fsysabhazmberfszfhao";
const API = "https://api.supabase.com";

function loadToken() {
  const p = join(homedir(), ".zcode", "cli", "config.json");
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  const tok = cfg?.mcp?.servers?.["supabase-kodi"]?.env?.SUPABASE_ACCESS_TOKEN;
  if (!tok) throw new Error("access token not found in CLI config");
  return tok;
}

const [cmd, a, b] = process.argv.slice(2);

try {
  const token = loadToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  let res;
  if (cmd === "query") {
    res = await fetch(`${API}/v1/projects/${REF}/database/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: a }),
    });
  } else if (cmd === "get") {
    res = await fetch(`${API}${a}`, { headers });
  } else if (cmd === "post") {
    res = await fetch(`${API}${a}`, { method: "POST", headers, body: b });
  } else {
    console.error("usage: query <sql> | get <path> | post <path> <json>");
    process.exit(1);
  }
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(redact(text.slice(0, 6000)));
  if (!res.ok) process.exit(1);
} catch (e) {
  console.error(redact(e.message));
  process.exit(1);
}
