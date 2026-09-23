import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";

const issuer = import.meta.env.VITE_ZITADEL_ISSUER as string | undefined;
const clientId = import.meta.env.VITE_ZITADEL_CLIENT_ID as string | undefined;
const rawAppUrl = (
  import.meta.env.VITE_APP_URL as string | undefined
)?.trim();
/** Absolute web origin for OIDC redirects. Never a bare path. */
const appUrl =
  rawAppUrl !== undefined && rawAppUrl !== ""
    ? rawAppUrl.replace(/\/$/, "")
    : window.location.origin;

if (!/^https?:\/\//.test(appUrl)) {
  console.error(
    `VITE_APP_URL must be an absolute origin (https://...), got ${JSON.stringify(rawAppUrl)}. Falling back to window.location.origin.`,
  );
}

const safeAppUrl = /^https?:\/\//.test(appUrl)
  ? appUrl
  : window.location.origin;

if (!issuer || !clientId) {
  console.error(
    "Missing VITE_ZITADEL_ISSUER / VITE_ZITADEL_CLIENT_ID. " +
      "Set them in apps/web/.env (see .env.example) and restart the dev server.",
  );
}

const RETURN_TO_KEY = "kodi:returnTo";

export const zitadelConfigured = Boolean(issuer && clientId);

/**
 * OIDC client for Zitadel (public SPA client, PKCE, no secret).
 * Tokens live in sessionStorage so closing the tab signs out.
 * Silent renew uses a same-origin popup-free redirect URI handled by the
 * SPA router (/silent-renew path renders nothing and closes the flow).
 */
export const userManager = new UserManager({
  authority: issuer ?? "https://placeholder.invalid",
  client_id: clientId ?? "placeholder",
  redirect_uri: `${safeAppUrl}/auth/callback`,
  silent_redirect_uri: `${safeAppUrl}/auth/silent-renew`,
  post_logout_redirect_uri: `${safeAppUrl}/`,
  response_type: "code",
  scope: "openid profile email",
  loadUserInfo: true,
  automaticSilentRenew: true,
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
});

/** Remember where to land after the Zitadel round-trip (e.g. /invite/<token>). */
export function stashReturnTo(path: string): void {
  try {
    window.sessionStorage.setItem(RETURN_TO_KEY, path);
  } catch {
    /* storage unavailable — fall back to home */
  }
}

export function takeReturnTo(): string {
  try {
    const v = window.sessionStorage.getItem(RETURN_TO_KEY) ?? "/";
    window.sessionStorage.removeItem(RETURN_TO_KEY);
    return v.startsWith("/") ? v : "/";
  } catch {
    return "/";
  }
}

/** Access token for Convex setAuth — null when signed out/expired. */
export async function getAccessToken(): Promise<string | null> {
  try {
    const user: User | null = await userManager.getUser();
    if (!user || user.expired) return null;
    return user.access_token;
  } catch {
    return null;
  }
}

/** Start login on Zitadel-hosted pages, returning to `path` afterwards. */
export async function signInRedirect(returnTo = "/"): Promise<void> {
  stashReturnTo(returnTo);
  await userManager.signinRedirect();
}

/** Start registration on Zitadel-hosted pages (same flow, register hint). */
export async function signUpRedirect(returnTo = "/onboarding"): Promise<void> {
  stashReturnTo(returnTo);
  await userManager.signinRedirect({
    extraQueryParams: { prompt: "create" },
  });
}
