import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts'

const issuer = import.meta.env.VITE_LOGTO_ISSUER as string | undefined
const clientId = import.meta.env.VITE_LOGTO_APP_ID as string | undefined

/**
 * Absolute base URL of this SPA — origin + path prefix, no trailing slash
 * (https://kodi.spidmax.win/console, or http://localhost:5174 at root).
 * VITE_APP_URL overrides; otherwise derived at runtime so the same build
 * works at any prefix (nginx /console/ alias, subdomain, previews).
 */
function appBaseUrl(): string {
  const override = (import.meta.env.VITE_APP_URL as string | undefined)?.trim().replace(/\/$/, '')
  if (override && /^https?:\/\//.test(override)) return override
  const { origin, pathname } = window.location
  const stripped = pathname.replace(/\/auth\/(?:callback|silent-renew)\/?$/, '')
  const base = stripped.endsWith('/') ? stripped.slice(0, -1) : stripped
  return `${origin}${base}`
}

const BASE = appBaseUrl()

/** Callback/silent-renew are detected by path suffix so any host or
 *  subpath works (base './' builds, kodi.spidmax.win/console, previews). */
const pathEnds = (suffix: string) =>
  window.location.pathname.replace(/\/$/, '').endsWith(suffix)

export const logtoConfigured = Boolean(issuer && clientId)

if (!logtoConfigured) {
  console.error(
    'Missing VITE_LOGTO_ISSUER / VITE_LOGTO_APP_ID — the console cannot sign anyone in. ' +
      'Set them next to VITE_CONVEX_URL (root .env.local for dev, apps/console/.env.production for builds).',
  )
}

/**
 * OIDC client for self-hosted Logto (public SPA client, PKCE).
 * Same issuer/app as the kodi web app: one Logto account = both apps.
 * Tokens live in localStorage (shared across tabs AND with the kodi web
 * app when both are on the same origin — one login covers the suite).
 * Redirect URIs to register in the Logto admin (per base):
 *   <base>/auth/callback and <base>/auth/silent-renew
 * e.g. https://kodi.spidmax.win/console/auth/callback for the combined
 * single-origin deploy, or per-origin for subdomain/dev setups.
 */
export const userManager = new UserManager({
  authority: issuer ?? 'https://placeholder.invalid',
  client_id: clientId ?? 'placeholder',
  redirect_uri: `${BASE}/auth/callback`,
  silent_redirect_uri: `${BASE}/auth/silent-renew`,
  post_logout_redirect_uri: `${BASE}/`,
  response_type: 'code',
  scope: 'openid profile email',
  loadUserInfo: true,
  automaticSilentRenew: true,
  userStore: new WebStorageStateStore({ store: window.localStorage }),
})

/**
 * Token for Convex setAuth. Convex verifies the ID token (aud = app id);
 * the access token's aud is the API resource and would fail verification.
 */
export async function getAccessToken(): Promise<string | null> {
  try {
    const user: User | null = await userManager.getUser()
    if (!user || user.expired) return null
    return user.id_token ?? user.access_token
  } catch {
    return null
  }
}

export async function signInRedirect(): Promise<void> {
  await userManager.signinRedirect()
}

export async function signOutRedirect(): Promise<void> {
  try {
    await userManager.signoutRedirect()
  } catch {
    // No session to end (or Logto unreachable) — drop locally and reload.
    await userManager.removeUser().catch(() => {})
    window.location.assign('/')
  }
}

/**
 * Process OIDC redirects before the app mounts (no router in this SPA).
 * Caller renders nothing for the silent-renew iframe; the login callback
 * cleans history afterwards. Module-level guard keeps StrictMode from
 * consuming the callback code twice (second call would PKCE-fail).
 */
let callbackPromise: Promise<void> | null = null

export function handleAuthRedirect(): Promise<void> {
  if (pathEnds('/auth/silent-renew')) {
    return (async () => {
      try {
        await userManager.signinSilentCallback()
      } catch {
        /* iframe refresh race — harmless */
      }
    })()
  }
  if (pathEnds('/auth/callback')) {
    if (callbackPromise === null) {
      callbackPromise = (async () => {
        try {
          await userManager.signinCallback()
        } catch (e) {
          console.error('OIDC callback failed:', e)
        } finally {
          window.history.replaceState({}, '', `${BASE}/`)
        }
      })()
    }
    return callbackPromise
  }
  return Promise.resolve()
}
