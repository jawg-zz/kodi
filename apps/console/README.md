# @kodi/console — KenyaPay merchant-ops console

M-Pesa merchant operations face of kodi: KPI cards, live transaction stream
(fed by `/hooks/mpesa` + kodi's Daraja flows via the shared `transactions`
table), hourly/daily charts, filterable transactions table, settlements and
webhook health. Talks to the SAME Convex deployment as the rest of kodi
(`convexapi.spidmax.win`) — backend source of truth is the repo-root
`convex/` directory; never push from here.

- `VITE_CONVEX_URL` — Convex API URL (`.env.local` for dev, committed
  `.env.production` for builds)
- `npm run dev` → http://localhost:5174
- Deploy: static build (`npm run build` → `dist/`), any static host or
  Dokploy static site; behind a subpath is fine (relative base)
