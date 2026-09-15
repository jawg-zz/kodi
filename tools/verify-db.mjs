/**
 * Dev-only verification: applies the auth shim + all Supabase migrations to a
 * disposable embedded Postgres, then exercises RLS isolation and the business
 * functions (invoice generation, FIFO allocation, receipt numbering).
 *
 *   npm run db:verify
 *
 * This never touches a hosted Supabase project and the data dir is deleted
 * afterwards.
 */
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 54329;
const dataDir = join(root, "tools", ".pgdata");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectError(name, fn, needle) {
  try {
    await fn();
    check(name, false, "expected an error but none was thrown");
  } catch (e) {
    check(name, String(e.message).toLowerCase().includes(needle.toLowerCase()),
      `got: ${e.message}`);
  }
}

async function removeDataDir(dir) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  return false;
}

import { execSync } from "node:child_process";

/** Kill an orphaned embedded-postgres still listening on our port, if any. */
function killOrphans() {
  try {
    const out = execSync("netstat -ano", { encoding: "utf8" });
    const pids = new Set(
      out
        .split("\n")
        .filter((l) => l.includes(`:${PORT}`) && l.includes("LISTENING"))
        .map((l) => l.trim().split(/\s+/).pop())
        .filter(Boolean)
    );
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`);
        console.log(`killed orphaned postgres (pid ${pid})`);
      } catch {}
    }
  } catch {}
}

async function main() {
  killOrphans();
  if (!(await removeDataDir(dataDir))) {
    console.log("warning: could not clear previous data dir; continuing");
  }
  console.log("starting embedded postgres…");
  const ep = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "kodi-dev",
    username: "postgres",
    port: PORT,
    persistent: false,
  });
  await ep.initialise();
  await ep.start();

  const client = new Client({
    host: "127.0.0.1",
    port: PORT,
    user: "postgres",
    password: "kodi-dev",
    database: "postgres",
  });
  await client.connect();

  try {
    // --- apply shim + migrations -------------------------------------------
    console.log("applying dev auth shim…");
    await client.query(readFileSync(join(root, "tools", "dev-auth-shim.sql"), "utf8"));

    const migDir = join(root, "supabase", "migrations");
    const migrations = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
    for (const m of migrations) {
      console.log(`applying migration ${m}…`);
      await client.query(readFileSync(join(migDir, m), "utf8"));
    }

    console.log("applying dev grants…");
    await client.query(readFileSync(join(root, "tools", "dev-auth-grants.sql"), "utf8"));

    const q = (sql, params) => client.query(sql, params);

    // --- seed: two orgs, staff, tenants, one tenant portal user -------------
    const month = (await q("select to_char(now() at time zone 'utc', 'YYYY-MM') as m"))
      .rows[0].m;

    const seed = async (sql, params = []) => (await q(sql, params)).rows[0];
    const userA = (await seed(
      "insert into auth.users (email) values ('landlord1@test.dev') returning id")).id;
    const userB = (await seed(
      "insert into auth.users (email) values ('landlord2@test.dev') returning id")).id;
    const userT = (await seed(
      "insert into auth.users (email) values ('tenant1@test.dev') returning id")).id;

    const org1 = (await seed(
      "insert into orgs (name, invoice_due_day) values ('Baraka Court', 5) returning id")).id;
    const org2 = (await seed(
      "insert into orgs (name) values ('Other Villas') returning id")).id;

    await q("insert into org_members (org_id, user_id, role) values ($1,$2,'owner'), ($3,$4,'owner')",
      [org1, userA, org2, userB]);

    const prop1 = (await seed(
      "insert into properties (org_id, name, location) values ($1,'Baraka Court','Kilimani') returning id",
      [org1])).id;
    const prop2 = (await seed(
      "insert into properties (org_id, name) values ($1,'Other Villas') returning id",
      [org2])).id;

    const u1 = (await seed(
      "insert into units (org_id, property_id, label, unit_type, rent_amount, water_charge, garbage_charge) values ($1,$2,'A1','one_br',15000,300,200) returning id",
      [org1, prop1])).id;
    await seed(
      "insert into units (org_id, property_id, label, unit_type, rent_amount, water_charge, garbage_charge) values ($1,$2,'A2','bedsitter',8000,200,100) returning id",
      [org1, prop1]);
    const u4 = (await seed(
      "insert into units (org_id, property_id, label, unit_type, rent_amount) values ($1,$2,'B1','bedsitter',9000) returning id",
      [org2, prop2])).id;

    const t1 = (await seed(
      "insert into tenants (org_id, full_name, phone, unit_id, move_in_date, deposit_held) values ($1,'Jane Wanjiku','0712345678',$2,'2026-01-10',15500) returning id",
      [org1, u1])).id;
    await seed(
      "insert into tenants (org_id, full_name, phone, unit_id) values ($1,'John Otieno','0723456789',$2)",
      [org1, (await q("select id from units where label='A2' and org_id=$1", [org1])).rows[0].id]);
    const org2Tenant = (await seed(
      "insert into tenants (org_id, full_name, phone, unit_id) values ($1,'Mary Achieng','0734567890',$2) returning id",
      [org2, u4])).id;

    await q("insert into tenant_users (tenant_id, user_id) values ($1,$2)", [t1, userT]);

    // trigger sanity
    const u1status = (await q("select status from units where id=$1", [u1])).rows[0].status;
    check("trigger: assigning tenant marks unit occupied", u1status === "occupied", u1status);

    // --- RLS as landlord A ----------------------------------------------------
    const asUser = async (id) => {
      await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id })]);
      await q("set role authenticated");
    };
    const asSuper = async () => {
      await q("reset role");
    };

    await asUser(userA);
    const props = await q("select count(*)::int as n from properties");
    check("RLS: landlord A sees only own property", props.rows[0].n === 1, `got ${props.rows[0].n}`);

    const hacked = await q("update orgs set name='hacked' where id=$1", [org2]);
    check("RLS: A cannot update org2's org (0 rows)", hacked.rowCount === 0,
      `updated ${hacked.rowCount} rows`);

    // --- invoice generation ---------------------------------------------------
    const r1 = await q("select generate_monthly_invoices($1,$2) as n", [org1, month]);
    check("generate_monthly_invoices creates 2 invoices", r1.rows[0].n === 2, `got ${r1.rows[0].n}`);
    const r2 = await q("select generate_monthly_invoices($1,$2) as n", [org1, month]);
    check("generation is idempotent (second run = 0)", r2.rows[0].n === 0, `got ${r2.rows[0].n}`);

    const inv1 = (await q(
      "select id, total, balance, extract(day from due_date)::int as due_day, status from invoices where tenant_id=$1 order by month",
      [t1])).rows[0];
    check("invoice total = rent+water+garbage (15500)", inv1.total === 15500, String(inv1.total));
    check("invoice balance initialised to total", inv1.balance === 15500, String(inv1.balance));
    check("invoice due day = org due day (5th)", inv1.due_day === 5, String(inv1.due_day));

    // cross-org generate denied
    await expectError("generate_monthly_invoices for another org denied", () =>
      q("select generate_monthly_invoices($1,$2)", [org2, month]), "not a member");

    // --- payments: FIFO allocation + receipts ---------------------------------
    const pay1 = await q("select record_payment($1,$2,$3,'mpesa_manual',null,null,'test') as id",
      [org1, t1, 12000]);
    check("record_payment returns payment id", !!pay1.rows[0].id);

    const invAfter = (await q("select balance, status from invoices where id=$1", [inv1.id])).rows[0];
    check("FIFO: balance reduced to 3500", invAfter.balance === 3500, String(invAfter.balance));
    check("FIFO: status partial", invAfter.status === "partial", invAfter.status);

    const p1row = (await q("select receipt_no, allocations from payments order by receipt_no limit 1")).rows[0];
    check("receipt numbering RCP-0001", p1row.receipt_no === "RCP-0001", p1row.receipt_no);
    const alloc = p1row.allocations[0];
    check("allocations recorded",
      alloc && alloc.invoiceId === inv1.id && alloc.amount === 12000,
      JSON.stringify(p1row.allocations));

    await q("select record_payment($1,$2,$3,'cash')", [org1, t1, 4000]);
    const invPaid = (await q("select balance, status from invoices where id=$1", [inv1.id])).rows[0];
    check("overpayment: invoice paid", invPaid.status === "paid", invPaid.status);
    check("overpayment: balance floored at 0", invPaid.balance === 0, String(invPaid.balance));

    const rcp2 = (await q("select receipt_no from payments order by receipt_no offset 1 limit 1")).rows[0].receipt_no;
    check("receipt numbering increments (RCP-0002)", rcp2 === "RCP-0002", rcp2);

    await expectError("direct insert into payments denied (ledger is function-only)", () =>
      q("insert into payments (org_id, tenant_id, amount, method, receipt_no) values ($1,$2,1,'cash','RCP-9999')",
        [org1, t1]), "row-level security");

    await expectError("record_payment for other org's tenant denied", () =>
      q("select record_payment($1,$2,$3,'cash')", [org1, org2Tenant, 1000]),
      "tenant not found");

    const org2Inv = await q("select count(*)::int as n from invoices i join orgs o on o.id=i.org_id where o.id=$1", [org2]);
    check("RLS: A sees none of org2's invoices", org2Inv.rows[0].n === 0, String(org2Inv.rows[0].n));

    const creds = await q("select count(*)::int as n from mpesa_credentials");
    check("RLS: mpesa_credentials hidden from staff", creds.rows[0].n === 0, String(creds.rows[0].n));

    // --- RLS as tenant portal user --------------------------------------------
    await asUser(userT);
    const tInv = await q("select count(*)::int as n from invoices");
    check("tenant sees own invoices", tInv.rows[0].n === 1, String(tInv.rows[0].n));
    const tPay = await q("select count(*)::int as n from payments");
    check("tenant sees own payments", tPay.rows[0].n === 2, String(tPay.rows[0].n));
    const tTenants = await q("select count(*)::int as n from tenants");
    check("tenant sees only own tenant row", tTenants.rows[0].n === 1, String(tTenants.rows[0].n));

    await expectError("tenant cannot insert invoices", () =>
      q("insert into invoices (org_id, tenant_id, month, due_date, total, balance) values ($1,$2,'2026-01','2026-01-05',1,1)", [org1, t1]),
      "row-level security");
    await expectError("tenant cannot record payments", () =>
      q("select record_payment($1,$2,$3,'cash')", [org1, t1, 100]), "not a member");

    // --- RLS as landlord B (org2) ----------------------------------------------
    await asUser(userB);
    const bProps = await q("select count(*)::int as n from properties");
    check("landlord B sees only own property", bProps.rows[0].n === 1, String(bProps.rows[0].n));
    const bInv = await q("select count(*)::int as n from invoices");
    check("landlord B has no invoices yet", bInv.rows[0].n === 0, String(bInv.rows[0].n));

    await asSuper();
  } finally {
    await client.end().catch(() => {});
    await ep.stop().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    if (!(await removeDataDir(dataDir))) {
      console.log("warning: could not delete tools/.pgdata (locked by a process); remove it manually");
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("failed checks:", failures.join(" | "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("verify-db crashed:", e);
  process.exit(1);
});
