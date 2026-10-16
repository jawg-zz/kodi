import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import App from './App.tsx'
import './index.css'
import { CONVEX_ENABLED } from './data/useDashboardData'

const convex = CONVEX_ENABLED
  ? new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string)
  : null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {convex ? (
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    ) : (
      <App />
    )}
  </StrictMode>,
)
