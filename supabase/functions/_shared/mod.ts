// Shared helpers for Kodi edge functions (Deno runtime).
// Pure helpers are dependency-free so they can be unit-tested with `deno test`.

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export function getEnv(name: string, fallback = ""): string {
  return Deno.env.get(name) ?? fallback;
}

const SANDBOX_BASE = "https://sandbox.safaricom.co.ke";
const PROD_BASE = "https://api.safaricom.co.ke";

export function darajaBase(environment: string): string {
  return environment === "production" ? PROD_BASE : SANDBOX_BASE;
}

/** Daraja timestamp: YYYYMMDDHHMMSS in Africa/Nairobi (UTC+3, no DST). */
export function darajaTimestamp(d = new Date()): string {
  const eat = new Date(d.getTime() + 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${eat.getUTCFullYear()}${p(eat.getUTCMonth() + 1)}${p(eat.getUTCDate())}` +
    `${p(eat.getUTCHours())}${p(eat.getUTCMinutes())}${p(eat.getUTCSeconds())}`
  );
}

export function stkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return btoa(`${shortcode}${passkey}${timestamp}`);
}

export function normalizePhone(input: string): string | null {
  if (!input) return null;
  let digits = input.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("0")) digits = "254" + digits.slice(1);
  else if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) digits = "254" + digits;
  if (digits.length !== 12 || !digits.startsWith("254")) return null;
  const local = digits.slice(3);
  if (!local.startsWith("7") && !local.startsWith("1")) return null;
  return digits;
}

// ---------------------------------------------------------------------------
// Symmetric encryption for Daraja secrets at rest (AES-GCM, key from env).
// ---------------------------------------------------------------------------
function credKey(): Promise<CryptoKey> {
  const raw = getEnv("CREDENTIALS_KEY");
  if (!raw) throw new Error("CREDENTIALS_KEY secret is not configured");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(raw.padEnd(32, "0").slice(0, 32)), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string): Promise<string> {
  const key = await credKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv, 0);
  buf.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...buf));
}

export async function decryptSecret(stored: string): Promise<string> {
  const key = await credKey();
  const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------------------
// Supabase admin client (service role) for server-side DB access.
// ---------------------------------------------------------------------------
export function supabaseAdmin() {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured");
  return { url, key };
}

export async function sbFetch(
  path: string,
  options: { method?: string; body?: unknown; params?: Record<string, string> } = {}
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const { url, key } = supabaseAdmin();
  const qs = options.params ? "?" + new URLSearchParams(options.params).toString() : "";
  const res = await fetch(`${url}/rest/v1/${path}${qs}`, {
    method: options.method ?? "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

export async function sbRpc(fn: string, args: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: unknown }> {
  const { url, key } = supabaseAdmin();
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
export interface Caller {
  userId: string;
  orgId: string;
  role: string;
  /** tenant row id when the caller is a portal tenant (staff callers: null) */
  tenantId: string | null;
}

/** Resolve the caller's JWT into org membership or tenant linkage. */
export async function resolveCaller(req: Request): Promise<Caller | Response> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return errorResponse("Missing Authorization header", 401);
  const { url, key } = supabaseAdmin();
  const me = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  });
  if (!me.ok) return errorResponse("Invalid or expired session", 401);
  const user = (await me.json()) as { id: string };

  const members = await sbFetch("org_members", {
    params: { user_id: `eq.${user.id}`, select: "org_id,role" },
  });
  const rows = (members.data ?? []) as { org_id: string; role: string }[];
  if (rows.length > 0) {
    return { userId: user.id, orgId: rows[0].org_id, role: rows[0].role, tenantId: null };
  }
  const links = await sbFetch("tenant_users", {
    params: { user_id: `eq.${user.id}`, select: "tenant_id,tenants!inner(org_id)" },
  });
  const linkRows = (links.data ?? []) as { tenant_id: string; tenants: { org_id: string }[] }[];
  if (linkRows.length > 0) {
    const t = linkRows[0];
    const orgId = Array.isArray(t.tenants) ? t.tenants[0]?.org_id : (t.tenants as unknown as { org_id: string })?.org_id;
    if (orgId) return { userId: user.id, orgId, role: "tenant", tenantId: t.tenant_id };
  }
  return errorResponse("Account is not linked to any organization", 403);
}
