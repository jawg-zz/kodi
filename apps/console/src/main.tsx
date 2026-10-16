import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProviderWithAuth, ConvexReactClient } from 'convex/react'
import App from './App.tsx'
import './index.css'
import { CONVEX_ENABLED } from './data/useDashboardData'
import { AuthProvider, useConvexAuth } from './lib/auth'
import { handleAuthRedirect } from './lib/logto'

const convex = CONVEX_ENABLED
  ? new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string)
  : null

function mount() {
  const root = createRoot(document.getElementById('root')!)
  root.render(
    <StrictMode>
      <AuthProvider>
        {convex ? (
          <ConvexProviderWithAuth client={convex} useAuth={useConvexAuth}>
            <App />
          </ConvexProviderWithAuth>
        ) : (
          <App />
        )}
      </AuthProvider>
    </StrictMode>,
  )
}

const path = window.location.pathname.replace(/\/$/, '')
const isSilentRenew = path.endsWith('/auth/silent-renew')

if (isSilentRenew || path.endsWith('/auth/callback')) {
  // OIDC round-trip: consume tokens first; the silent-renew iframe stays blank.
  void handleAuthRedirect().then(() => {
    if (!isSilentRenew) mount()
  })
} else {
  mount()
}
