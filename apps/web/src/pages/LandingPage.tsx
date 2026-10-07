import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { PLANS, formatKES } from "@kodi/shared";
import { useAuth } from "../lib/auth";
import { Badge } from "../components/ui";

/**
 * Public landing page at `/`. Signed-in visitors never see it — they are
 * sent on to the portal, onboarding, or the app, mirroring HomeRedirect.
 */
export function LandingPage() {
  const { loading, isAuthenticated, org, tenant, membership } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900">
        <p className="text-xl font-bold text-white">Kodi</p>
      </div>
    );
  }
  if (isAuthenticated) {
    if (tenant && !membership) return <Navigate to="/portal" replace />;
    if (!org) return <Navigate to="/onboarding" replace />;
    return <Navigate to="/app" replace />;
  }

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <SiteHeader />
      <main>
        <Hero />
        <HowAMonthWorks />
        <MpesaSection />
        <BothSides />
        <ReportsSection />
        <PricingSection />
        <FaqSection />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  const [open, setOpen] = useState(false);
  const links = [
    { href: "#how", label: "How a month works" },
    { href: "#mpesa", label: "M-Pesa" },
    { href: "#reports", label: "Reports" },
    { href: "#pricing", label: "Pricing" },
  ];
  return (
    <header className="sticky top-0 z-50 bg-slate-900 text-slate-200">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <a href="#top" className="text-xl font-bold text-white">
          Kodi
        </a>
        <nav className="hidden items-center gap-6 md:flex" aria-label="Site">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="text-sm text-slate-300 hover:text-white">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          <Link to="/login" className="rounded-lg px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 hover:text-white">
            Sign in
          </Link>
          <Link to="/signup" className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-200">
            Create account
          </Link>
        </div>
        <button
          className="rounded-lg p-2 text-slate-300 hover:bg-slate-800 hover:text-white md:hidden"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            {open ? (
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            ) : (
              <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </div>
      {open && (
        <nav className="border-t border-slate-700 px-4 py-3 md:hidden" aria-label="Site">
          <div className="flex flex-col gap-1">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 hover:text-white"
              >
                {l.label}
              </a>
            ))}
            <div className="mt-2 flex gap-2 border-t border-slate-700 pt-3">
              <Link to="/login" className="flex-1 rounded-lg border border-slate-600 px-4 py-2 text-center text-sm font-medium text-white">
                Sign in
              </Link>
              <Link to="/signup" className="flex-1 rounded-lg bg-white px-4 py-2 text-center text-sm font-medium text-slate-900">
                Create account
              </Link>
            </div>
          </div>
        </nav>
      )}
    </header>
  );
}

/** The hero is a rent book, not a dashboard screenshot: the month's money. */
function Hero() {
  return (
    <section id="top" className="bg-slate-900 pb-16 pt-12 text-slate-200 sm:pt-16">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-2">
        <div>
          <h1 className="text-4xl font-bold leading-tight text-white sm:text-5xl">
            Every shilling of rent, accounted for.
          </h1>
          <p className="mt-4 max-w-lg text-lg text-slate-300">
            Kodi bills your tenants each month, collects through M-Pesa, and
            matches every payment to the right invoice on its own. The books
            close themselves.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link to="/signup" className="rounded-lg bg-white px-5 py-2.5 text-base font-medium text-slate-900 hover:bg-slate-200">
              Create a free account
            </Link>
            <a href="#how" className="rounded-lg border border-slate-600 px-5 py-2.5 text-base font-medium text-white hover:bg-slate-800">
              See how a month works
            </a>
          </div>
          <p className="mt-4 text-sm text-slate-400">
            Free for up to 10 units. No card required. Tenants pay from any phone.
          </p>
        </div>

        {/* Sample rent book: the document landlords already understand. */}
        <div className="rounded-xl bg-white p-5 text-slate-900 shadow-2xl" aria-label="Sample rent book">
          <div className="flex items-baseline justify-between">
            <h2 className="font-bold">October rent book</h2>
            <p className="text-xs text-slate-500">Sample</p>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            <span className="font-mono tabular-nums text-brand-700">KES 186,000</span> received of{" "}
            <span className="font-mono tabular-nums">KES 240,000</span> expected
          </p>
          <div
            className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100"
            role="progressbar"
            aria-valuenow={78}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="78 percent of expected rent collected"
          >
            <div className="h-full rounded-full bg-brand-500" style={{ width: "78%" }} />
          </div>
          <ul className="mt-4 divide-y divide-slate-100 text-sm">
            <LedgerRow name="Wanjiku · A1" amount="KES 15,000" status="paid" />
            <LedgerRow name="Otieno · B3" amount="KES 22,000" status="paid" />
            <LedgerRow name="Achieng · A4" amount="KES 9,000 of 18,000" status="partial" />
            <LedgerRow name="Mwangi · C2" amount="KES 25,000" status="unpaid" />
            <LedgerRow name="Njeri · B1" amount="KES 20,000" status="paid" />
          </ul>
          <p className="mt-4 text-xs text-slate-400">
            Balances carry forward automatically. Overpayments become credit on the next invoice.
          </p>
        </div>
      </div>
    </section>
  );
}

function LedgerRow({ name, amount, status }: {
  name: string;
  amount: string;
  status: "paid" | "partial" | "unpaid";
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <span className="font-medium">{name}</span>
      <span className="flex items-center gap-3">
        <span className={`font-mono tabular-nums ${status === "paid" ? "text-brand-700" : "text-slate-600"}`}>
          {amount}
        </span>
        <Badge tone={status === "paid" ? "green" : status === "partial" ? "amber" : "red"}>
          {status === "paid" ? "Paid" : status === "partial" ? "Partial" : "Unpaid"}
        </Badge>
      </span>
    </li>
  );
}

/** A month in Kodi genuinely is a sequence, so numbered steps earn their place. */
function HowAMonthWorks() {
  const steps = [
    {
      title: "Set up once",
      body: "Add the property, its units with monthly rent, and each tenant from their move-in date. Bedsitters, single rooms, one to three bedrooms, shops.",
    },
    {
      title: "Generate the month's invoices",
      body: "One tap creates every bill — rent plus water, garbage, and any extras. Tenants with credit have it applied before the invoice even lands.",
    },
    {
      title: "Collect through M-Pesa",
      body: "Send a payment prompt to the tenant's phone, or let them pay the paybill themselves with their own account code. Each payment matches itself to the oldest open invoice.",
    },
    {
      title: "Close the books",
      body: "Receipts, statements, and deposit settlements print on A4. Arrears get a WhatsApp reminder with the balance pre-written. The rent book writes itself.",
    },
  ];
  return (
    <section id="how" className="scroll-mt-16 bg-white py-16">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-[1fr_1.5fr]">
        <div>
          <h2 className="text-3xl font-bold">How a month works</h2>
          <p className="mt-3 text-slate-500">
            From empty spreadsheet to closed books in four moves. Cash and bank
            payments fit the same flow — record them by hand and the matching
            works exactly the same.
          </p>
          <Link to="/signup" className="mt-5 inline-block rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-700">
            Start with this month
          </Link>
        </div>
        <ol className="space-y-8">
          {steps.map((s, i) => (
            <li key={s.title} className="flex gap-4">
              <span className="font-mono text-2xl font-semibold text-slate-300" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <h3 className="font-semibold">{s.title}</h3>
                <p className="mt-1 max-w-xl text-slate-500">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function MpesaSection() {
  return (
    <section id="mpesa" className="scroll-mt-16 bg-slate-50 py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2 className="text-3xl font-bold">Tenants pay the way they already pay</h2>
        <p className="mt-3 max-w-2xl text-slate-500">
          No app to install, no new habits. Both ways record themselves —
          nobody types a transaction code into a spreadsheet afterward.
        </p>
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <h3 className="font-semibold">You send a prompt to their phone</h3>
            <p className="mt-2 text-sm text-slate-500">
              Enter the amount, and the tenant gets an M-Pesa PIN prompt. You
              watch it move from sent to PIN entry to confirmed. If they cancel
              or the line is unreachable, the screen says so plainly — and
              late confirmations still record when the money lands.
            </p>
          </div>
          <div className="rounded-xl border border-brand-100 bg-brand-50 p-6">
            <h3 className="font-semibold text-brand-800">Or they pay from the M-Pesa menu</h3>
            <p className="mt-2 text-sm text-slate-700">
              Each tenant gets a permanent account code. They open Lipa na
              M-Pesa, enter the business number and their code, and the
              confirmation matches their rent in seconds. Works on a kabambe.
              Scanning a QR fills the whole bill in — no typing at all.
            </p>
            <p className="mt-4 font-mono text-sm tracking-wide text-slate-900">
              Business 123456 · Account A3F9K2
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Bring your own paybill, or collect through the Kodi Paybill to start immediately.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function BothSides() {
  return (
    <section id="tenants" className="scroll-mt-16 bg-white py-16">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-2">
        <div>
          <h2 className="text-3xl font-bold">Tenants see their own side</h2>
          <p className="mt-3 text-slate-500">
            Every tenant gets a simple portal: what they owe, what they have
            paid, and a button that pays the balance by M-Pesa. Statements
            print straight from the page, so “send me my statement” stops
            being a phone call.
          </p>
        </div>
        <div>
          <h2 className="text-3xl font-bold">Deposits stop leaking</h2>
          <p className="mt-3 text-slate-500">
            Deposits held, deductions itemised, refunds settled — each
            move-out closes with a settlement both sides can read. Credit from
            overpayments applies itself to the next invoice, oldest debt
            first, without anyone remembering to do it.
          </p>
        </div>
      </div>
    </section>
  );
}

function ReportsSection() {
  const items = [
    ["Collection by month", "Actual cash received each month, against what was billed — never one minus the other."],
    ["Arrears aging", "Who owes what, since when, sorted into current, 30, 60, and 90-plus days — each row one tap from a WhatsApp reminder."],
    ["Property performance", "Billed, collected, and outstanding per building, so the weak block shows itself."],
    ["Payment timeliness", "Who pays on time and who drifts, scored per tenant across every paid invoice."],
    ["Daily close", "Each day's cash with method and recorder split, ready to sign off."],
    ["Deposits and credits", "What you hold, what you settled, and what tenants prepaid — in one glance."],
    ["Rent roll and occupancy", "Units, occupancy rate, and the rent each building should earn full."],
    ["Audit trail", "Every payment, void, refund, and match recorded with when and who. Exports to CSV throughout."],
  ];
  return (
    <section id="reports" className="scroll-mt-16 bg-slate-900 py-16 text-slate-200">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2 className="text-3xl font-bold text-white">Reports your accountant will believe</h2>
        <p className="mt-3 max-w-2xl text-slate-400">
          Cash-basis throughout: collected means money received, dated the day
          it arrived. Everything exports to CSV.
        </p>
        <dl className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {items.map(([title, body]) => (
            <div key={title}>
              <dt className="font-semibold text-white">{title}</dt>
              <dd className="mt-1 text-sm text-slate-400">{body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function PricingSection() {
  const blurbs: Record<string, string> = {
    starter: "One plot or a handful of units — learn the ropes free.",
    growth: "Several buildings with steady monthly billing.",
    pro: "Estates and managers running up to two hundred units.",
  };
  return (
    <section id="pricing" className="scroll-mt-16 bg-white py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2 className="text-3xl font-bold">Pricing that fits the plot</h2>
        <p className="mt-3 max-w-2xl text-slate-500">
          Priced by units, not by features — every plan gets invoices,
          M-Pesa collection, the tenant portal, and all reports.
        </p>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {PLANS.map((p) => (
            <div
              key={p.code}
              className={`flex flex-col rounded-xl border bg-white p-6 ${
                p.code === "growth" ? "border-slate-900 ring-2 ring-slate-900/10" : "border-slate-200"
              }`}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{p.name}</h3>
                {p.code === "growth" && <Badge tone="slate">Most common</Badge>}
              </div>
              <p className="mt-3 text-3xl font-bold tabular-nums">
                {p.priceKes === 0 ? "Free" : formatKES(p.priceKes)}
                {p.priceKes > 0 && <span className="text-base font-normal text-slate-500">/month</span>}
              </p>
              <p className="mt-1 text-sm text-slate-500">Up to {p.maxUnits} units</p>
              <p className="mt-2 text-sm text-slate-500">{blurbs[p.code] ?? ""}</p>
              <Link
                to="/signup"
                className={`mt-5 rounded-lg px-4 py-2 text-center text-sm font-medium ${
                  p.code === "growth"
                    ? "bg-slate-900 text-white hover:bg-slate-700"
                    : "border border-slate-300 text-slate-800 hover:bg-slate-50"
                }`}
              >
                {p.priceKes === 0 ? "Start free" : `Start with ${p.name}`}
              </Link>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-slate-500">
          Paid plans are arranged over M-Pesa with our team after you sign up —
          no card, no automatic charges.
        </p>
      </div>
    </section>
  );
}

function FaqSection() {
  const faqs: [string, string][] = [
    [
      "Do I need my own paybill?",
      "No. You can collect through the Kodi Paybill from day one and settle with your business on a schedule. When you are ready, connect your own paybill or till in Settings and tenants keep paying the same way.",
    ],
    [
      "What about cash and bank payments?",
      "Record them in seconds from the Payments page. They follow the same matching — oldest invoice first, receipt numbered, leftover kept as credit — as M-Pesa payments.",
    ],
    [
      "A tenant paid too much. Now what?",
      "Nothing — the extra sits as credit on their account and applies itself to the next invoice. You see the credit balance on their page and in reports.",
    ],
    [
      "Do tenants need smartphones?",
      "No. STK prompts and paybill payments work on any Safaricom line. The portal and QR codes are a bonus for those with smartphones, not a requirement.",
    ],
    [
      "Can I get my data out?",
      "Yes. Collections, arrears, properties, timeliness, payments, and the rent roll all export to CSV, and receipts and statements print to A4.",
    ],
  ];
  return (
    <section id="faq" className="scroll-mt-16 bg-slate-50 py-16">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <h2 className="text-3xl font-bold">Questions landlords ask</h2>
        <div className="mt-8 space-y-3">
          {faqs.map(([q, a]) => (
            <details key={q} className="rounded-xl border border-slate-200 bg-white px-5 py-4">
              <summary className="cursor-pointer font-medium">{q}</summary>
              <p className="mt-2 text-sm text-slate-500">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="bg-slate-900 py-16 text-center text-slate-200">
      <div className="mx-auto max-w-2xl px-4 sm:px-6">
        <h2 className="text-3xl font-bold text-white">This month's invoices write themselves.</h2>
        <p className="mt-3 text-slate-400">
          Set up your building today, generate the month's bills, and watch
          the rent book fill in.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link to="/signup" className="rounded-lg bg-white px-5 py-2.5 text-base font-medium text-slate-900 hover:bg-slate-200">
            Create a free account
          </Link>
          <Link to="/login" className="rounded-lg border border-slate-600 px-5 py-2.5 text-base font-medium text-white hover:bg-slate-800">
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-slate-800 bg-slate-900 px-4 py-8 text-sm text-slate-400 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-base font-bold text-white">Kodi</p>
          <p className="mt-1">Rent management for Kenyan landlords.</p>
        </div>
        <div className="flex gap-5">
          <Link to="/signup" className="hover:text-white">Create account</Link>
          <Link to="/login" className="hover:text-white">Sign in</Link>
        </div>
      </div>
    </footer>
  );
}
