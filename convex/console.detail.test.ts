import { convexTest } from 'convex-test'
import { expect, test } from 'vitest'
import { api } from './_generated/api'
import schema from './schema'
import * as consoleModule from './console'
import * as operator from './operator'
import type { Id } from './_generated/dataModel'

const modules = {
  './_generated/api.js': () => Promise.resolve({}),
  './console.js': () => Promise.resolve(consoleModule),
  './operator.js': () => Promise.resolve(operator),
}

const PLATFORM_ADMIN = { subject: 'user-admin' }
const ORG_STAFF = { subject: 'user-staff' }
const OUTSIDER = { subject: 'user-nobody' }

interface Seeded {
  orgA: Id<'orgs'>
  payA: Id<'payments'>
  payStk: Id<'payments'>
  orphan: Id<'c2bPayments'>
  stkPending: Id<'mpesaTransactions'>
  feedId: Id<'transactions'>
}

async function seed(t: ReturnType<typeof convexTest>): Promise<Seeded> {
  return t.run(async (ctx) => {
    const orgA = await ctx.db.insert('orgs', {
      name: 'Org A',
      plan_code: 'growth',
      subscription_status: 'active',
      invoice_due_day: 5,
    })
    await ctx.db.insert('orgMembers', { orgId: orgA, userId: ORG_STAFF.subject, role: 'owner' })
    await ctx.db.insert('platformAdmins', { userId: PLATFORM_ADMIN.subject, createdAt: Date.now() })
    const tenant = await ctx.db.insert('tenants', {
      orgId: orgA,
      full_name: 'Alice Rent',
      phone: '254711000001',
      national_id: '1',
      accountCode: 'GC-A1',
      deposit_held: 0,
      status: 'active',
    })

    const invoice = await ctx.db.insert('invoices', {
      orgId: orgA,
      tenantId: tenant,
      month: '2026-01',
      lines: { rent: 4500, water: 300, garbage: 100, other: 100 },
      total: 5000,
      dueDate: '2026-01-05',
      status: 'partial',
      balance: 500,
    })
    const payA = await ctx.db.insert('payments', {
      orgId: orgA,
      tenantId: tenant,
      amount: 5000,
      method: 'mpesa_c2b',
      mpesaCode: 'CODEA1',
      paidAt: 1_000,
      allocations: [{ invoiceId: invoice, amount: 4500, month: '2026-01' }],
      receiptNo: 'RCP-A1',
    })
    await ctx.db.insert('platformCollections', {
      orgId: orgA,
      paymentId: payA,
      amount: 5000,
      fee: 50,
      settledAt: 2_000,
      payoutRef: 'PAYOUT-1',
      settleKind: 'auto',
    })
    await ctx.db.insert('webhookLog', {
      orgId: orgA,
      route: '/c2b/confirmation',
      transId: 'CODEA1',
      outcome: 'matched',
      latencyMs: 210,
    })

    const orphan = await ctx.db.insert('c2bPayments', {
      orgId: orgA,
      transId: 'ORPHAN1',
      transAmount: 250,
      msisdn: '254711000003',
      status: 'pending_review',
      matchReason: 'no invoice match',
      rawPayload: '{"TransID":"ORPHAN1"}',
    })
    await ctx.db.insert('webhookLog', {
      orgId: orgA,
      route: '/c2b/confirmation',
      transId: 'ORPHAN1',
      outcome: 'orphan_queued',
    })

    const stkPending = await ctx.db.insert('mpesaTransactions', {
      orgId: orgA,
      tenantId: tenant,
      checkoutRequestId: 'ws_CO_123',
      phone: '254711000001',
      amount: 700,
      status: 'pending',
      initiatedBy: 'staff-1',
      viaPlatform: true,
    })
    await ctx.db.insert('webhookLog', {
      orgId: orgA,
      route: '/stk/callback',
      transId: 'ws_CO_123',
      outcome: 'stk_pending',
    })

    const payStk = await ctx.db.insert('payments', {
      orgId: orgA,
      tenantId: tenant,
      amount: 1500,
      method: 'mpesa_stk',
      mpesaCode: 'CODES1',
      paidAt: 3_000,
      allocations: [],
      receiptNo: 'RCP-S1',
      checkoutRequestId: 'ws_CO_999',
    })
    // The STK attempt that produced payStk (linked via checkoutRequestId).
    await ctx.db.insert('mpesaTransactions', {
      orgId: orgA,
      tenantId: tenant,
      checkoutRequestId: 'ws_CO_999',
      phone: '254711000001',
      amount: 1500,
      status: 'success',
      mpesaReceipt: 'CODES1',
      paymentId: payStk,
    })

    const feedId = await ctx.db.insert('transactions', {
      code: 'FEED1',
      reference: 'REF-FEED',
      msisdn: '254700000001',
      payerName: 'Feed Payer',
      amount: 100,
      fee: 1,
      channel: 'Paybill',
      status: 'failed',
      direction: 'CR',
      failureReason: 'insufficient funds',
      source: 'seed',
      raw: { TransID: 'FEED1' },
    })

    return { orgA, payA, payStk, orphan, stkPending, feedId }
  })
}

test('transactionDetail rejects unauthenticated callers', async () => {
  const t = convexTest(schema, modules)
  const { payA } = await seed(t)
  await expect(
    t.query(api.console.transactionDetail, { source: 'rent', id: payA }),
  ).rejects.toThrow('Not authenticated')
})

test('rent detail joins payment, collection, tenant and webhook evidence', async () => {
  const t = convexTest(schema, modules).withIdentity(PLATFORM_ADMIN)
  const { payA } = await seed(t)
  const d = await t.query(api.console.transactionDetail, { source: 'rent', id: payA })
  expect(d).not.toBeNull()
  expect(d!.payment?.amount).toBe(5000)
  expect(d!.payment?.mpesaCode).toBe('CODEA1')
  expect(d!.tenant?.name).toBe('Alice Rent')
  expect(d!.org?.name).toBe('Org A')
  expect(d!.collection?.fee).toBe(50)
  expect(d!.collection?.payoutRef).toBe('PAYOUT-1')
  expect(d!.collection?.settledAt).toBe(2000)
  expect(d!.payment?.allocations).toHaveLength(1)
  expect(d!.webhooks.some((w) => w.event === '/c2b/confirmation' && w.ok)).toBe(true)
})

test('c2b orphan detail carries match reason, payload and its webhook', async () => {
  const t = convexTest(schema, modules).withIdentity(PLATFORM_ADMIN)
  const { orphan } = await seed(t)
  const d = await t.query(api.console.transactionDetail, { source: 'c2b', id: orphan })
  expect(d!.c2b?.transId).toBe('ORPHAN1')
  expect(d!.c2b?.status).toBe('pending_review')
  expect(d!.c2b?.matchReason).toBe('no invoice match')
  expect(d!.c2b?.rawPayload).toContain('ORPHAN1')
  expect(d!.payment).toBeUndefined()
  expect(d!.webhooks.some((w) => w.event === '/c2b/confirmation')).toBe(true)
})

test('stk detail exposes checkout state and tenant, with no settled collection', async () => {
  const t = convexTest(schema, modules).withIdentity(PLATFORM_ADMIN)
  const { stkPending } = await seed(t)
  const d = await t.query(api.console.transactionDetail, { source: 'stk', id: stkPending })
  expect(d!.checkout?.checkoutRequestId).toBe('ws_CO_123')
  expect(d!.checkout?.status).toBe('pending')
  expect(d!.checkout?.viaPlatform).toBe(true)
  expect(d!.tenant?.phone).toBe('254711000001')
  expect(d!.collection).toBeUndefined()
  expect(d!.webhooks.some((w) => w.event === '/stk/callback')).toBe(true)
})

test('rent row linked to a checkout surfaces the STK attempt', async () => {
  const t = convexTest(schema, modules).withIdentity(PLATFORM_ADMIN)
  const { payStk } = await seed(t)
  const d = await t.query(api.console.transactionDetail, { source: 'rent', id: payStk })
  expect(d!.checkout?.checkoutRequestId).toBe('ws_CO_999')
})

test('feed detail is platform-only and carries the raw payload', async () => {
  const t = convexTest(schema, modules).withIdentity(PLATFORM_ADMIN)
  const { feedId } = await seed(t)
  const d = await t.query(api.console.transactionDetail, { source: 'feed', id: feedId })
  expect(d!.feed?.code).toBe('FEED1')
  expect(d!.feed?.failureReason).toBe('insufficient funds')
  expect(d!.feed?.raw).toEqual({ TransID: 'FEED1' })
})

test('org staff cannot read another org row, and never the feed', async () => {
  const t = convexTest(schema, modules).withIdentity(ORG_STAFF)
  const { payA, feedId } = await seed(t)
  // Own-org row: readable.
  const own = await t.query(api.console.transactionDetail, { source: 'rent', id: payA })
  expect(own!.payment?.amount).toBe(5000)
  // Feed rows have no org: invisible to org staff.
  const feed = await t.query(api.console.transactionDetail, { source: 'feed', id: feedId })
  expect(feed).toBeNull()
})

test('unlinked users are rejected and malformed ids return null', async () => {
  const outsider = convexTest(schema, modules).withIdentity(OUTSIDER)
  const { payA } = await seed(outsider)
  await expect(
    outsider.query(api.console.transactionDetail, { source: 'rent', id: payA }),
  ).rejects.toThrow(/not linked/i)

  const admin = convexTest(schema, modules).withIdentity(PLATFORM_ADMIN)
  await seed(admin)
  const bogus = await admin.query(api.console.transactionDetail, { source: 'rent', id: 'not-an-id' })
  expect(bogus).toBeNull()
  const missing = await admin.query(api.console.transactionDetail, { source: 'c2b', id: 'k17fakedocid0000' })
  expect(missing).toBeNull()
})
