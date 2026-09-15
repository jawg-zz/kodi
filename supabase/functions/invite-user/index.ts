// invite-user — staff-only. Creates an auth user (tenant portal or manager)
// and links it to the caller's org. Uses the service_role key; never expose
// admin credentials to the browser.

import { errorResponse, jsonResponse, resolveCaller, sbFetch } from "../_shared/mod.ts";

function randomPassword(length = 16): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// Simple per-org invite throttle: max 20 invites per hour (abuse guard).
const inviteHits = new Map<string, number[]>();
function inviteAllowed(orgId: string): boolean {
  const now = Date.now();
  const windowStart = now - 3600_000;
  const hits = (inviteHits.get(orgId) ?? []).filter((t) => t > windowStart);
  if (hits.length >= 20) return false;
  hits.push(now);
  inviteHits.set(orgId, hits);
  return true;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);
  const caller = await resolveCaller(req);
  if (caller instanceof Response) return caller;
  if (caller.role !== "owner" && caller.role !== "manager") {
    return errorResponse("Only staff can invite users", 403);
  }
  if (!inviteAllowed(caller.orgId)) {
    return errorResponse("Too many invites — try again later", 429);
  }

  let body: {
    email?: string;
    fullName?: string;
    phone?: string;
    kind?: string;
    tenantId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body");
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const fullName = (body.fullName ?? "").trim();
  const phone = (body.phone ?? "").trim();
  const kind = body.kind;
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return errorResponse("A valid email is required");
  if (!fullName) return errorResponse("Full name is required");
  if (kind !== "tenant" && kind !== "manager") return errorResponse("kind must be 'tenant' or 'manager'");

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const adminFetch = (path: string, method: string, payload?: unknown) =>
    fetch(`${url}/auth/v1/admin/${path}`, {
      method,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });

  // Reuse an existing account with this email if present.
  let userId: string | null = null;
  let tempPassword: string | null = null;
  const list = await adminFetch(`users?email=${encodeURIComponent(email)}`, "GET");
  if (list.ok) {
    const found = (await list.json()) as { users?: { id: string }[] };
    userId = found.users?.[0]?.id ?? null;
  }
  if (!userId) {
    tempPassword = randomPassword();
    const created = await adminFetch("users", "POST", {
      email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { full_name: fullName, phone },
    });
    if (!created.ok) {
      const err = await created.text();
      return errorResponse(`Could not create user: ${err}`, 500);
    }
    userId = ((await created.json()) as { id: string }).id;
  }

  // Profile row: create if missing, otherwise fill blanks only.
  const existing = await sbFetch("profiles", {
    params: { id: `eq.${userId}`, select: "id,full_name,phone" },
  });
  const rows = ((existing.data ?? []) as { id: string; full_name: string; phone: string | null }[]);
  if (rows.length === 0) {
    await sbFetch("profiles", {
      method: "POST",
      params: {},
      body: { id: userId, full_name: fullName, phone },
    });
  } else {
    const patch: Record<string, string> = {};
    if (!rows[0].full_name && fullName) patch.full_name = fullName;
    if (!rows[0].phone && phone) patch.phone = phone;
    if (Object.keys(patch).length > 0) {
      await sbFetch("profiles", {
        method: "PATCH",
        params: { id: `eq.${userId}` },
        body: patch,
      });
    }
  }

  if (kind === "manager") {
    const m = await sbFetch("org_members", {
      method: "POST",
      body: { org_id: caller.orgId, user_id: userId, role: "manager" },
    });
    if (!m.ok) return errorResponse("Could not link manager to organization", 500);
  } else {
    const tenantId = body.tenantId;
    if (!tenantId) return errorResponse("tenantId is required for tenant invites");
    // Confirm the tenant belongs to the caller's org (prevents cross-org linking).
    const t = await sbFetch("tenants", {
      params: { id: `eq.${tenantId}`, org_id: `eq.${caller.orgId}`, select: "id" },
    });
    if (!t.ok || ((t.data ?? []) as unknown[]).length === 0) {
      return errorResponse("Tenant not found in your organization", 404);
    }
    const already = await sbFetch("tenant_users", {
      params: { tenant_id: `eq.${tenantId}`, select: "tenant_id" },
    });
    if (!already.ok || ((already.data ?? []) as unknown[]).length > 0) {
      return errorResponse("This tenant already has a portal login", 409);
    }
    const link = await sbFetch("tenant_users", {
      method: "POST",
      body: { tenant_id: tenantId, user_id: userId },
    });
    if (!link.ok) return errorResponse("Could not link tenant portal login", 500);
  }

  return jsonResponse({ email, tempPassword, invited: tempPassword !== null });
});
