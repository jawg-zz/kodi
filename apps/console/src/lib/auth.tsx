import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { getFreshUser, logtoConfigured, refreshSession, signInRedirect, signOutRedirect, userManager } from './logto'
import type { User } from 'oidc-client-ts'

interface AuthUser {
  id: string
  email: string | null
}

interface AuthState {
  loading: boolean
  isAuthenticated: boolean
  user: AuthUser | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

function toUser(u: User | null): AuthUser | null {
  if (!u || u.expired || typeof u.profile.sub !== 'string') return null
  return { id: u.profile.sub, email: typeof u.profile.email === 'string' ? u.profile.email : null }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<AuthUser | null>(null)

  useEffect(() => {
    let cancelled = false
    getFreshUser()
      .then((u) => {
        if (!cancelled) {
          setUser(toUser(u))
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    const onLoaded = () => void userManager.getUser().then((u) => setUser(toUser(u)))
    const onCleared = () => setUser(null)
    const events = userManager.events
    events.addUserLoaded(onLoaded)
    events.addUserUnloaded(onCleared)
    events.addUserSignedOut(onCleared)
    return () => {
      cancelled = true
      events.removeUserLoaded(onLoaded)
      events.removeUserUnloaded(onCleared)
      events.removeUserSignedOut(onCleared)
    }
  }, [])

  const signIn = useCallback(async () => {
    if (logtoConfigured) await signInRedirect()
  }, [])
  const signOut = useCallback(async () => {
    await signOutRedirect()
  }, [])

  return (
    <AuthContext.Provider value={{ loading, isAuthenticated: user !== null, user, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

/** Safe in mock mode (no AuthProvider): returns null instead of throwing. */
export function useOptionalAuth(): AuthState | null {
  return useContext(AuthContext) ?? null
}

/**
 * Shape required by convex's <ConvexProviderWithAuth useAuth={...}>.
 * App gates all queries behind isAuthenticated, so an anonymous caller
 * never fires (and never fails) an unauthenticated query.
 */
export function useConvexAuth(): {
  isLoading: boolean
  isAuthenticated: boolean
  fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>
} {
  const auth = useOptionalAuth()
  const fetchAccessToken = useCallback(async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
    try {
      // refreshSession() only calls signinSilent when a refresh_token
      // exists (native XHR grant — no iframe); otherwise it returns the
      // current session or null and Convex's gate reacts accordingly.
      const u = await refreshSession(forceRefreshToken)
      if (!u || u.expired) return null
      return u.id_token ?? u.access_token
    } catch {
      return null
    }
  }, [])
  return {
    isLoading: auth?.loading ?? false,
    isAuthenticated: auth?.isAuthenticated ?? false,
    fetchAccessToken,
  }
}
