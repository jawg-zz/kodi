import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts'

const issuer = import.meta.env.VITE_LOGTO_ISSUER as string | undefined
const clientId = import.meta.env.VITE_LOGTO_APP_ID as string | undefined

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
 * Tokens live in localStorage (shared across tabs). Redirect URIs to
 * register in the Logto admin: <origin>/auth/callback and
 * <origin>/auth/silent-renew for every console origin (prod + dev).
 */
export const userManager = new UserManager({
  authority: issuer ?? 'https://placeholder.invalid',
  client_id: clientId ?? 'placeholder',
  redirect_uri: `${window.location.origin}/auth/callback`,
  silent_redirect_uri: `${window.location.origin}/auth/silent-renew`,
  post_logout_redirect_uri: `${window.location.origin}/`,
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
          window.history.replaceState({}, '', '/')
        }
      })()
    }
    return callbackPromise
  }
  return Promise.resolve()
}
