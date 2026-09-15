// invite-user — staff-only. Creates an auth user (tenant portal or manager)
// and links it to the caller's org. Uses the service_role key; never expose
// admin credentials to the browser.

import { errorResponse, jsonResponse, resolveCaller, sbFetch } from "../_shared/mod.ts";

function randomPassword(length = 12): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);
  const caller = await resolveCaller(req);
  if (caller instanceof Response) return caller;
  if (caller.role !== "owner" && caller.role !== "manager") {
    return errorResponse("Only staff can invite users", 403);
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

  // Profile row.
  await sbFetch("profiles", {
    method: "POST",
    params: {},
    body: { id: userId, full_name: fullName, phone },
  });

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
    const link = await sbFetch("tenant_users", {
      method: "POST",
      body: { tenant_id: tenantId, user_id: userId },
    });
    if (!link.ok) return errorResponse("Could not link tenant portal login", 500);
  }

  return jsonResponse({ email, tempPassword, invited: tempPassword !== null });
});
