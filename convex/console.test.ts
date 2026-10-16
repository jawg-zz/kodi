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
  orgB: Id<'orgs'>
}

async function seed(t: ReturnType<typeof convexTest>): Promise<Seeded> {
  return t.run(async (ctx) => {
    const orgA = await ctx.db.insert('orgs', {
      name: 'Org A',
      plan_code: 'growth',
      subscription_status: 'active',
      invoice_due_day: 5,
    })
    const orgB = await ctx.db.insert('orgs', {
      name: 'Org B',
      plan_code: 'starter',
      subscription_status: 'active',
      invoice_due_day: 5,
    })
    await ctx.db.insert('orgMembers', { orgId: orgA, userId: ORG_STAFF.subject, role: 'owner' })
    await ctx.db.insert('platformAdmins', { userId: PLATFORM_ADMIN.subject, createdAt: Date.now() })
    const tenantA = await ctx.db.insert('tenants', {
      orgId: orgA,
      full_name: 'Alice Rent',
      phone: '254711000001',
      national_id: '1',
      accountCode: 'GC-A1',
      deposit_held: 0,
      status: 'active',
    })
    const tenantB = await ctx.db.insert('tenants', {
      orgId: orgB,
      full_name: 'Bob Rent',
      phone: '254711000002',
      national_id: '2',
      accountCode: 'GC-B1',
      deposit_held: 0,
      status: 'active',
    })
    const payA = await ctx.db.insert('payments', {
      orgId: orgA,
      tenantId: tenantA,
      amount: 5000,
      method: 'mpesa_stk',
      paidAt: 1_000,
      allocations: [],
      receiptNo: 'RCP-A1',
    })
    // Non-M-Pesa method: out of console scope entirely.
    await ctx.db.insert('payments', {
      orgId: orgA,
      tenantId: tenantA,
      amount: 700,
      method: 'cash',
      paidAt: 1_100,
      allocations: [],
      receiptNo: 'RCP-A-CASH',
    })
    await ctx.db.insert('payments', {
      orgId: orgB,
      tenantId: tenantB,
      amount: 9000,
      method: 'mpesa_stk',
      paidAt: 1_200,
      allocations: [],
      receiptNo: 'RCP-B1',
    })
    // Allocated C2B: must NOT appear (its money is payA).
    await ctx.db.insert('c2bPayments', {
      orgId: orgA,
      tenantId: tenantA,
      transId: 'ALLOCATED1',
      transAmount: 5000,
      msisdn: '254711000001',
      status: 'matched',
      paymentId: payA,
    })
    // Orphan C2B: appears as pending.
    await ctx.db.insert('c2bPayments', {
      orgId: orgA,
      transId: 'ORPHAN1',
      transAmount: 250,
      msisdn: '254711000003',
      status: 'pending_review',
    })
    await ctx.db.insert('c2bPayments', {
      orgId: orgB,
      transId: 'ORPHANB1',
      transAmount: 300,
      msisdn: '254711000004',
      status: 'pending_review',
    })
    await ctx.db.insert('webhookLog', {
      orgId: orgA,
      route: '/c2b/confirmation',
      outcome: 'matched',
    })
    await ctx.db.insert('paymentAlerts', {
      orgId: orgA,
      kind: 'orphan_c2b',
      title: 'Orphan C2B in Org A',
      acknowledged: false,
    })
    await ctx.db.insert('paymentAlerts', {
      orgId: orgB,
      kind: 'forward_failed',
      title: 'Forward failed in Org B',
      acknowledged: false,
    })
    // Simulator feed rows have no org: platform view only.
    await ctx.db.insert('transactions', {
      code: 'FEED1',
      reference: 'REF-FEED',
      msisdn: '254700000001',
      payerName: 'Feed Payer',
      amount: 100,
      fee: 1,
      channel: 'Paybill',
      status: 'success',
      direction: 'CR',
      source: 'seed',
    })
    return { orgA, orgB }
  })
}

test('unauthenticated callers are rejected on every query', async () => {
  const t = convexTest(schema, modules)
  await seed(t)
  await expect(t.query(api.console.whoami, {})).rejects.toThrow('Not authenticated')
  await expect(t.query(api.console.transactions, {})).rejects.toThrow('Not authenticated')
  await expect(t.query(api.console.settlements, {})).rejects.toThrow('Not authenticated')
  await expect(t.query(api.console.webhookHealth, {})).rejects.toThrow('Not authenticated')
  await expect(t.query(api.console.alerts, {})).rejects.toThrow('Not authenticated')
})

test('users with no platform linkage are rejected', async () => {
  const t = convexTest(schema, modules).withIdentity(OUTSIDER)
  await seed(t)
  await expect(t.query(api.console.whoami, {})).rejects.toThrow(
    'Account is not linked to the platform',
  )
})

test('org staff see only their org, no feed rows, no double counting', async () => {
  const t = convexTest(schema, modules).withIdentity(ORG_STAFF)
  await seed(t)

  const me = await t.query(api.console.whoami, {})
  expect(me).toEqual({ userId: ORG_STAFF.subject, view: 'org' })

  const rows = await t.query(api.console.transactions, {})
  const codes = rows.map((r) => r.code).sort()
  expect(codes).toEqual(['ORPHAN1', 'RCP-A1'])
  expect(rows.every((r) => r.source !== 'feed')).toBe(true)
  const rent = rows.find((r) => r.code === 'RCP-A1')!
  expect(rent.payerName).toBe('Alice Rent')
  expect(rent.status).toBe('success')
  const orphan = rows.find((r) => r.code === 'ORPHAN1')!
  expect(orphan.status).toBe('pending')
  expect(orphan.source).toBe('c2b')

  const alerts = await t.query(api.console.alerts, {})
  expect(alerts.map((a) => a.title)).toEqual(['Orphan C2B in Org A'])

  const health = await t.query(api.console.webhookHealth, {})
  expect(health.logs.map((l) => l.event)).toEqual(['/c2b/confirmation'])
})

test('platform admins see the cross-org view including the feed', async () => {
  const t = convexTest(schema, modules).withIdentity(PLATFORM_ADMIN)
  await seed(t)

  const me = await t.query(api.console.whoami, {})
  expect(me).toEqual({ userId: PLATFORM_ADMIN.subject, view: 'platform' })

  const rows = await t.query(api.console.transactions, {})
  const codes = rows.map((r) => r.code).sort()
  expect(codes).toEqual(['FEED1', 'ORPHAN1', 'ORPHANB1', 'RCP-A1', 'RCP-B1'])
  expect(rows.some((r) => r.source === 'feed')).toBe(true)

  const alerts = await t.query(api.console.alerts, {})
  expect(alerts.map((a) => a.title).sort()).toEqual([
    'Forward failed in Org B',
    'Orphan C2B in Org A',
  ])
})
