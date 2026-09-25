## Goal
Rebuild `/app/reports` into an accurate, fast, filterable hub: true cash-collected numbers, server-side aggregation (no 500/1000-row truncation), global month-range + property filters, and 4 new sections (rent roll & occupancy, payments & M-Pesa, 30/60/90+ aging, deposits & credits). Keep existing visual language (PageHeader/Stat/Card/Table, brand greens, integer KES, YYYY-MM months).

## Findings driving this plan
- `ReportsPage.tsx` fans out 5 full-table queries and computes in-browser; `listPayments take(500)` truncates large orgs; `collected = expected - outstanding` is not cash.
- No `reports.*` backend; no chart lib (hand-rolled div bars); filters are per-section only (arrears property filter); CSV filenames always use current month even for all-time data; `paidAt ms -> ISO -> new Date()` round-trip is timezone-fragile.
- Schema has what we need: `invoices(by_org_month)`, `payments(paidAt, method, allocations)`, `units(propertyId,status,rent_amount)`, `mpesaTransactions(status)`, `depositSettlements`, `tenantCredits`. Missing: date index on `payments.paidAt`.

## Implementation

### 1. Backend — new `convex/reports.ts` (staff-only via `assertStaff`)
- `collectionSummary({orgId, startMonth, endMonth, propertyId?})`: per-month `{month, expected, collected, outstanding, rate, invoiceCount}`. `expected/outstanding` from `by_org_month`; `collected` = sum `payments.amount` whose UTC `monthKey(paidAt)` == month (fixes derived math + timezone). Property filter resolved server-side via `units by_property` -> tenant/unit id sets.
- `arrearsAging({orgId, propertyId?})`: per-tenant `{tenant, phone, property, balance, openCount, oldestMonth, oldestDueDate, bucket}` with buckets Current (due <30d), 30/60/90+ days past `dueDate`; plus bucket totals for header strip.
- `paymentsBreakdown({orgId, startMs, endMs, propertyId?})`: totals + counts by `mpesa_stk/mpesa_manual/cash/bank`; date window from month-range converted to UTC epoch once.
- `mpesaHealth({orgId, startMs, endMs})`: counts + amounts by `success/failed/timeout/pending` from `mpesaTransactions by_org`, success rate %.
- `rentRoll({orgId, propertyId?})`: per-property `{units, occupied, vacant, notice, occupancyPct, monthlyRent}` + org totals; uses `units by_org` / `by_property`.
- `depositsAndCredits({orgId, propertyId?})`: `{depositHeldTotal, settledDeductions, settledRefunds, openDeposits, creditBalanceTotal, tenantsWithCredit}` from `tenants + depositSettlements + tenantCredits`.
- All queries paginate internally (no `take(500)` cap); return plain JSON, no row dumps. Add `payments.by_org_paidAt [orgId+paidAt]` index in `schema.ts` for window queries.

### 2. Frontend — `apps/web/src/pages/ReportsPage.tsx` refactor
- Global filter bar (Card): `Preset Select [3/6/12 months, YTD, Custom]` + `Start month / End month Selects` (YYYY-MM via `addMonths/currentMonthKey`) + `Property Select (All + list)`. Single state object; every section + every CSV respects it. Drop `MONTHS_BACK=6` hard-code and per-section `propertyId` local.
- Replace 5-query `Promise.all` + client math with 6 thin `api.ts` wrappers calling `reports.*`; keep `Loading/ErrorBanner/EmptyState` idiom and `useAuth().org.id` scoping.
- Sections (existing components only):
  - 4 Stats: Outstanding, Collected in range (true cash), Collection rate, Tenants in arrears.
  - Collection by month: keep div-bar pattern, add Expected/Collected/Outstanding KES columns + rate %; cap note removed.
  - Aging buckets strip (4 mini totals) + arrears table extended with Property + Bucket columns, sorted balance desc.
  - Rent roll & occupancy table (per property + totals).
  - Payments by method + M-Pesa health (two side-by-side Cards on lg).
  - Deposits & credits (3 Stats + settled list link-out).
- `apps/web/src/lib/api.ts`: add `getCollectionSummary/getArrearsAging/getPaymentsBreakdown/getMpesaHealth/getRentRoll/getDepositsAndCredits` wrappers with camelCase->snake_case translators matching existing `toInvoice/toPayment` style.

### 3. Exports
- Filenames include range + property: `kodi-collection-YYYYMM-to-YYYYMM[-prop].csv`, same for arrears/payments; add `kodi-rent-roll-...csv` and `kodi-aging-...csv`.
- Payments CSV uses filtered window (not truncated 500); arrears CSV adds Property/Bucket/Oldest columns; amounts stay integer KES via existing `toCsv/downloadCsv` + BOM.

### 4. Shared helpers (`packages/shared`)
- Add `monthRangeList(start,end)`, `monthKeyFromMs(ms)` (UTC), `daysPastDue(dueDateISO, nowMs)`, `agingBucket(days)` with unit tests alongside existing `csv/money/month` tests.

### 5. Tests & verification
- `convex-test` for `reports.*`: fixture org with 3 months invoices + cross-month payments, property filter, bucket boundaries, method split.
- `npm run typecheck`, `npx convex dev --once` for codegen, manual Reports page check across presets + CSV open in Excel.

## Files touched
- NEW `convex/reports.ts`; EDIT `convex/schema.ts` (1 index), `apps/web/src/lib/api.ts`, `apps/web/src/pages/ReportsPage.tsx`, `packages/shared/src/month.ts` (+ test).
- No changes to print docs, Dashboard, auth, or cron in this pass.

## Out of scope / risks
- No chart lib, no P&L/expenses (no expense table exists), no scheduled month-end email — propose as follow-ups.
- Schema index add is additive and safe; large-org queries stay bounded by month window + property filter.
