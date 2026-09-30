# M-Pesa Daraja API Integration Handbook (Daraja 3.0)

A general-purpose developer guide to integrating Safaricom M-Pesa via the
Daraja API platform — covering every API in the catalogue: what it does,
exact endpoints and versions observed, request/response shapes, error
handling, testing, go-live, and how the pieces fit together in a real
system. Framework-agnostic: examples are raw HTTPS so they apply whether
you build in Node, Python, PHP, Java, or anything else.

Companion: `daraja-developer-guide.md` maps these same APIs onto Kodi's
rent-management domain. This file is the general reference.

> **Document status — read before trusting versions.**
> Endpoint versions below were observed live against the Daraja 3.0 portal
> and production responses in September 2026. Daraja revs endpoints without
> fanfare (we migrated C2B v1 → v2 for the masked-MSISDN change). If a call
> starts returning version/route errors, re-check the portal first — see
> the [Endpoint version log](#24-endpoint-version-log) and treat it as the
> source of truth for staleness.

---

## Table of contents

1. [Mental model: how Daraja works](#1-mental-model-how-daraja-works)
2. [Environments, apps & go-live](#2-environments-apps--go-live)
3. [Authentication (OAuth)](#3-authentication-oauth)
4. [Async pattern, callbacks & reliability](#4-async-pattern-callbacks--reliability)
5. [Initiator credentials (SecurityCredential)](#5-initiator-credentials-securitycredential)
6. [Callback URL rules & gateway IPs](#6-callback-url-rules--gateway-ips)
7. [M-Pesa accounts & org portal roles](#7-m-pesa-accounts--org-portal-roles)
8. [Collections — STK Push](#8-collections--stk-push-express)
9. [Collections — C2B Paybill self-serve](#9-collections--c2b-paybill-self-serve)
10. [Collections — Bill Manager](#10-collections--bill-manager)
11. [Collections — Dynamic QR](#11-collections--dynamic-qr)
12. [Collections — Lipa na Bonga](#12-collections--lipa-na-bonga)
13. [Collections — Ratiba standing orders](#13-collections--ratiba-standing-orders)
14. [Collections — C2B Hakikisha](#14-collections--c2b-hakikisha-name-check)
15. [Disbursements — B2C](#15-disbursements--b2c)
16. [Disbursements — float, Pochi, B2B payments](#16-disbursements--float-pochi-b2b-payments)
17. [Disbursements — B2C Hakikisha + Tax](#17-disbursements--b2c-hakikisha--tax)
18. [Verification & reconciliation](#18-verification--reconciliation)
19. [KYC & fraud signals](#19-kyc--fraud-signals)
20. [Out of scope for payments](#20-out-of-scope-for-payments)
21. [First payment in 30 minutes (tutorial)](#21-first-payment-in-30-minutes-tutorial)
22. [Commercial cost table](#22-commercial-cost-table)
23. [Security checklist](#23-security-checklist)
24. [Endpoint version log](#24-endpoint-version-log)
25. [Failure-mode plays](#25-failure-mode-plays)
26. [Testing strategy](#26-testing-strategy)
27. [Production runbook](#27-production-runbook)
28. [Error-code index](#28-error-code-index)

---

## 1. Mental model: how Daraja works

Daraja is an API gateway between your server and M-Pesa Core. You never
talk to the money system directly:

```
Your server ──HTTPS──▶ Daraja (auth, validate, route) ──▶ M-Pesa Core
Your server ◀──HTTPS── Daraja (callbacks, results) ◀──── M-Pesa Core
```

Consequences that shape every integration:

- **Two money directions.** Collections move customer → business
  (STK Push, C2B, Bill Manager, QR, Bonga, Ratiba). Disbursements move
  business → customer (B2C family). Different APIs, different shortcode
  requirements, different credentials.
- **Almost everything is asynchronous.** Your POST gets a synchronous
  "accepted" response; the real result arrives later on a callback URL
  you supply per request (or register once for C2B). Design for
  pending states from day one.
- **Callbacks are fire-and-forget.** If your endpoint is down, the
  result is logged as 503 and discarded — no retries. You must reconcile
  by polling (Transaction Status, Pull Transactions, Account Balance).
- **Shortcodes are the unit of permission.** Each API capability is
  granted per shortcode (Paybill 5–6 digits, Till/Store numbers). A
  Paybill that collects cannot disburse until it is enabled as a
  Bulk/One-account shortcode.

---

## 2. Environments, apps & go-live

| | Sandbox | Production |
|---|---|---|
| Host | `https://sandbox.safaricom.co.ke` | `https://api.safaricom.co.ke` |
| Shortcodes | Test codes from the simulator | Your live Paybill/Till |
| Callback URLs | HTTP allowed | HTTPS only, public, no tunnels |
| Simulator | Per-API, login-gated | N/A (use Postman/own app) |

Flow: Daraja account → create app → subscribe to API products →
test with simulator/test codes → Go Live tab (shortcode, org name,
admin/manager username, OTP) → production keys to your email.

---

## 3. Authentication (OAuth)

The **only GET** on the platform; everything else is POST.

```
GET /oauth/v1/generate?grant_type=client_credentials
Authorization: Basic base64(consumerKey:consumerSecret)
→ { "access_token": "...", "expires_in": 3599 }
```

Hard rules:

- Tokens live **3600 seconds**. **Each new token invalidates the
  previous one.** Cache the token with its expiry and share it across
  concurrent calls; never mint per request or parallel workers will
  kill each other's tokens.
- All other calls: `Authorization: Bearer <token>`, JSON bodies.

---

## 4. Async pattern, callbacks & reliability

Standard flow for STK, B2C, B2B, Reversal, Balance, Status:

1. POST request with `ResultURL` (+ `QueueTimeOutURL`) →
   `{ResponseCode: "0"}` means **accepted**, not completed.
2. M-Pesa processes; result POSTs to your ResultURL.
3. On timeout/silence, result goes to QueueTimeOutURL or nowhere.

Reliability checklist:

- Idempotency keys on every write path (Daraja gives you
  OriginatorConversationID semantics; enforce your own too).
- A `pending` state per transaction, resolved by callback OR poll.
- Poll fallback: Transaction Status Query by receipt/originator ID.
- Nightly reconciliation: Pull Transactions (48h C2B window) and/or
  Account Balance diffs.
- Treat "accepted" as pending in UX; never as paid.

---

## 5. Initiator credentials (SecurityCredential)

Needed for B2C, B2B payments, Transaction Status, Account Balance,
Reversal (not for STK/C2B collect flows, which use passkey or nothing).

Recipe:

1. Base64-encode the initiator's plain password.
2. Encrypt with the M-Pesa X509 public key (download Sandbox vs
   Production cert from the portal), RSA with **PKCS#1.5 (not OAEP)**.
3. Base64-encode the ciphertext → `SecurityCredential`.

Setup: Business Admin creates API operator (access channel API) →
assign per-API role → Business Manager sets password (avoid `@` and
`.`, 90-day validity). Roles include ORG B2C API initiator, Business
Paybill/BuyGoods initiator, Transaction Status query, Org Reversals
Initiator, Balance Query. The same credential is reusable across
requests until the password rotates.

---

## 6. Callback URL rules & gateway IPs

Daraja rejects callback URLs containing (400.003.02): `mpesa`/`M-PESA`,
`safaricom`, `exe`, `exec`, `cmd`, `sql`, `query` — in ANY casing, in
host or path. Name routes accordingly (`/stk-callback`, `/c2b-*`).

Whitelist the Safaricom gateway IPs on your callback ingress:

```
196.201.214.200  196.201.214.206  196.201.213.114  196.201.214.207
196.201.214.208  196.201.213.44   196.201.212.127  196.201.212.138
196.201.212.129  196.201.212.136  196.201.212.74   196.201.212.69
```

---

## 7. M-Pesa accounts & org portal roles

`https://org.ke.m-pesa.com` — Business Admin (creates users, no tx
view) → Business Manager (approves, balances, withdraws) → API
operators → Auditor (read-only).

Per shortcode: **Utility** receives customer payments; **Working/MMF**
holds pre-settlement money; **Charges Paid** accrues negative;
**Settlement** auto-moves Utility→MMF. B2C debits **Utility** — fund it
from MMF first (portal step, or B2B `BusinessTransferFromMMFToUtility`
where whitelisted).

---

## 8. Collections — STK Push (Express)

Business-initiated phone prompt. No URL registration; each request
carries `CallBackURL`. Endpoints v1, current:
`mpesa/stkpush/v1/processrequest`, `mpesa/stkpushquery/v1/query`.

```json
{
  "BusinessShortCode": 174379,
  "Password": "base64(shortcode+passkey+YYYYMMDDHHmmss)",
  "Timestamp": "20260101120000",
  "TransactionType": "CustomerPayBillOnline",
  "Amount": 15000,
  "PartyA": "254722000001",
  "PartyB": 174379,
  "PhoneNumber": "254722000001",
  "CallBackURL": "https://your.site/stk-callback",
  "AccountReference": "ORDER-1234",
  "TransactionDesc": "Payment"
}
```

Limits: AccountReference ≤ 12 chars, TransactionDesc ≤ 13.
`CustomerBuyGoodsOnline` + PartyB = till for Till numbers.
Response: `{MerchantRequestID, CheckoutRequestID}`.

Callback `Body.stkCallback`: `ResultCode` 0 success / 1032 cancelled /
1037 unreachable; success carries CallbackMetadata
(Amount, MpesaReceiptNumber, TransactionDate, PhoneNumber, Balance).

Query mirrors the request plus `CheckoutRequestID`.

Limits: 1–250,000 per push; 500k account/day. "Unable to lock
subscriber" → 1-minute gap between pushes to the same phone.
Reversible via Reversal API. Passkey comes with go-live (sandbox: test
data page).

**Build it like this:** pending row per CheckoutRequestID → poll +
callback both resolve through one atomic reconcile → dedupe on receipt.

---

## 9. Collections — C2B Paybill self-serve

Customer pays from their own M-Pesa menu. One-time URL registration:
`POST mpesa/c2b/v2/registerurl`
`{ShortCode, ResponseType: "Completed", ConfirmationURL, ValidationURL}`.
Production: register once; changes via portal Self Services → URL
Management (2 operators) or apisupport. API re-register while live
fails with "already registered" — treat as success after verifying.

**Validation** (optional; enable via apisupport, ~6h, 8s window):
accept `{ResultCode: "0", ResultDesc: "Accepted"}`; reject
C2B00011–16 (MSISDN/account/amount/KYC/shortcode/other) — shown to payer.

**Confirmation:** TransID, TransAmount (whole KES), BusinessShortCode,
BillRefNumber (≤ 20, paybill only), TransTime, First/Middle/LastName.
**v1 hashes MSISDN (SHA-256); v2 masks it (`2547***126`).**
Design matching around the account reference first, phone second.

**Build it like this:** exact account-code match → national-ID-style
fallback → masked-phone hint → human review queue; dedupe per TransID
(retries re-POST on missing 200s).

---

## 10. Collections — Bill Manager

Safaricom-hosted invoicing, reminders, receipts. Opt in once:
`POST v1/billmanager-invoice/optin`
`{shortcode, email, officialContact, sendReminders 0|1, logo?, callbackurl}`
→ `{app_key}` (header on later calls). `sendReminders: 1` = 7/3/0-day
customer SMS.

Invoice singly (`.../single-invoicing`) or bulk (≤ 1000/call,
`.../bulk-invoicing`, `bulk` array): externalReference (= your invoice
id), billedFullName/Phone, billedPeriod, invoiceName, dueDate,
**accountReference**, amount, invoiceItems[].

Customer pays by any channel with the ref; payment pushes to your
callback `{transactionId, paidAmount, msisdn FULL, dateCreated,
accountReference, shortCode}` retried 5×. Reconcile, acknowledge →
Safaricom sends the e-receipt. Cancel single/bulk while unpaid
(409 once paid).

**Why it matters:** outsources invoice SMS, reminders, and receipts;
callbacks carry the full phone number (unlike C2B v2).

---

## 11. Collections — Dynamic QR

`POST mpesa/qrcode/v1/generate`:
`{MerchantName, RefNo, Amount, TrxCode: "PB"|"BG"|"WA"|"SM"|"SB",
CPI: "<shortcode>", Size}` → `{QRCode: "<base64 png>"}`.
Print per-invoice QRs (PB + shortcode + account code + amount); verify
RefNo surfaces as BillRefNumber before matching on it.

## 12. Collections — Lipa na Bonga

Points at 0.2 KES each. `calculate-points` then `redeem-paybill`
(`v1/lipa/na/bonga/*`, separate SHA256 user/pass auth). PIN-confirmed
flow; funds land on the Paybill and your C2B callback fires. Offer
points as part-payment; confirmations reuse the C2B path.

## 13. Collections — Ratiba standing orders

Commercial (contract + ~5% capped 5 KES/execution + C2B tariffs).
`POST standingorder/v1/createStandingOrderExternal`: customer
PIN-consents once; debits recur (Frequency 5 = Monthly). Ref ≤ 12,
names unique per customer (1050), masked-MSISDN callbacks. Track
mandates (create/amend/cancel) per customer.

## 14. Collections — C2B Hakikisha (name check)

Reversed: **Safaricom calls you** (`c2b_hakikisha/v1/notify`) with
`{accountNumber, shortcode}`; you return `{accountName}`, shown to the
payer pre-confirm on STK/USSD/app. Needs apisupport onboarding,
reciprocal B2C Hakikisha contract, and you hosting token + notify
endpoints. Kills account-number typos at source.

---

## 15. Disbursements — B2C

`POST mpesa/b2c/v3/paymentrequest`. Requires Bulk/One-account shortcode.
`OriginatorConversationID` dedupes. BusinessPayment/SalaryPayment/
PromotionPayment. Limits 10–250k, 500k balance/day. Callback reveals
receiver name + balances. Status-queryable. No passkey; credential
reusable. **Outbound B2C reversals unsupported — portal only.**

---

## 16. Disbursements — float, Pochi, B2B payments

- **B2C Account Top Up** (`b2b/v1/paymentrequest`,
  `BusinessPayToBulk`): MMF → B2C utility. Keeps disbursements funded.
- **Business To Pochi** (`b2pochi/v1/paymentrequest`,
  `BusinessPayToPochi`): payouts to micro-SME wallets.
- **Business Pay Bill / Buy Goods** (same family,
  `BusinessPayBill`/`BusinessBuyGoods`): MMF → utility/merchant,
  optional `Requester`, ref ≤ 13. Supplier payments, MMF→Utility
  automation.
- **B2B Express Checkout** (`v1/ussdpush/get-msisdn`): USSD push to till
  operators. Merchant till→paybill only; skip unless you run tills.

---

## 17. Disbursements — B2C Hakikisha + Tax

- **B2C Hakikisha**: you call `b2c/hakikisha/v1/hakikisha`
  (MSISDN+shortcode) → first name + masked rest. Pre-flight every
  disbursement. Reciprocal contract with C2B Hakikisha.
- **Tax Remittance** (`b2b/v1/remittax`, `PayTaxToKRA`, fixed PartyB
  572572, ref = KRA PRN after prior KRA integration).

---

## 18. Verification & reconciliation

- **Transaction Status** (`transactionstatus/v1/query`): receipt or
  OriginatorConversationID + PartyA + credential. Covers
  C2B/B2B/B2C/IMT/Reversal. Async with ResultURL. Tiers: Initiated →
  Authorized → Completed/Cancelled/Declined/Expired.
- **Account Balance** (`accountbalance/v1/query` + credential, async
  ResultURL **with no retries**): pipe-delimited per-account balances.
  Own-shortcode-only. Schedule nightly diffs ledger-vs-M-Pesa.
- **Pull Transactions**: one-time `pulltransactions/v1/register`, then
  48h windows with offset pagination, C2B-only. **Rows carry FULL
  numeric MSISDN** — the authoritative phone source and the safety net
  for missed webhooks.
- **Reversals (outbound)** (`reversal/v1/request`): C2B-only, receipt as
  TransactionID, ReceiverParty + id 11. R000001 already-reversed,
  R000002 invalid receipt. Needs Org Reversals Initiator. Pair with
  Transaction Status for confirmation.

---

## 19. KYC & fraud signals

- **Mobile Number Validation** (`v1/KYC-validation/validateID`):
  phone + idType (01/02/05) + idNumber → TRUE/FALSE, no PII.
  Commercial ~4.5 KES tapering. Onboarding verification.
- **SIM Swap** (`imsi/v2/checkATI`): last swap date (>3mo → 1900-01-01).
  50k KES connection, 200k free, 1 KES/req.
- **IMSI** (V1/V2/V3): hashed IMSI + age + swap bundles. 20 KES/call.
- **Age on Network** (`registration/lookup/v1/checkATI`): SIM
  registration date, ~4 KES tapering, failed calls unbilled.
- **B2B Hakikisha** (`sfcverify/v1/query/info`, sync OAuth-only):
  shortcode + type 4/2 → org name + charge profile (Mgao vs Bouquet).
  Verify counterparty setup before transacting.

Combine into a risk score: recent swap + new SIM + ID mismatch =
step-up verification before large disbursements.

---

## 20. Out of scope for payments

Mobile Data Bundles (dynamic offers/top-ups), IoT SIM Management
(`simportal/*`).

## 21. First payment in 30 minutes (tutorial)

The fastest path from zero to a verified live shilling. Sandbox only;
production swaps hosts and keys.

**Step 1 — credentials (5 min).** Daraja account → create app →
subscribe to M-Pesa Express → copy Consumer Key + Secret. Shortcode
`174379`, passkey from the simulator test-data page.

**Step 2 — token (2 min).**

```
GET https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials
Authorization: Basic base64(key:secret)
```

Cache `access_token` for ~3500s (see §3).

**Step 3 — send a prompt to your own phone (5 min).** POST
`mpesa/stkpush/v1/processrequest` with §8's body, Amount 10,
PhoneNumber = your Safaricom line, CallBackURL = a request-catcher
(webhook.site) for this first run. Save the `CheckoutRequestID`.

**Step 4 — complete on the handset (2 min).** Enter PIN on the prompt.
Watch the catcher: a `Body.stkCallback` POST with ResultCode 0 and
CallbackMetadata (Amount, MpesaReceiptNumber) should arrive.

**Step 5 — reconcile (5 min).** POST `mpesa/stkpushquery/v1/query`
with the CheckoutRequestID. ResultCode 0 confirms. You now understand
every moving part: token → push → callback → verify.

**Step 6 — productionize.** Go-live (§2), real shortcode + passkey,
your own callback route with idempotency (§4), then the 10 KES live
test from the runbook (§27).

## 22. Commercial cost table

Free unless listed. Prices exclude VAT; confirm on the portal before
budgeting (commercial terms change).

| API | Cost |
|---|---|
| STK Push, C2B, B2C, B2B payments, Reversal, Status, Balance, Pull, QR, Bill Manager, Hakikisha checks | Per-transaction M-Pesa tariffs only (no API fee documented) |
| Ratiba | ~5% of execution value, capped 5 KES + C2B tariffs |
| Mobile Number Validation | ~4.5 KES/call, tapering with volume |
| SIM Swap | 50,000 KES connection + 200k free, then 1 KES/req |
| IMSI | 20 KES/call |
| Age on Network | ~4 KES tapering; failed calls unbilled |

Rule of thumb: collections are tariff-only; KYC/fraud signals are
per-call metered — gate them behind risk thresholds, not every request.

## 23. Security checklist

For audits and pre-launch reviews. One place, everything that protects
money and data:

- [ ] OAuth tokens cached server-side with expiry; never minted per
  call, never logged, never shipped to clients.
- [ ] Initiator passwords in secrets manager; RSA-encrypted per §5;
  90-day rotation scheduled; `@`/`.` avoided.
- [ ] Callback ingress restricted to the §6 gateway IP whitelist.
- [ ] Callback URLs contain no banned substrings; HTTPS public.
- [ ] TransID / OriginatorConversationID dedupe on every write path
  (duplicate delivery is normal Daraja behavior).
- [ ] Reversed-direction endpoints (C2B Hakikisha notify, own token
  endpoint) authenticate Safaricom callers; don't trust shortcode
  alone — C2B confirmations carry no signature.
- [ ] Owner-gate large reversals/disbursements; audit every match,
  void, refund, and bulk operation with actor + reason.
- [ ] PII minimization: log TransIDs and masked numbers; full MSISDNs
  only where Pull reconciliation needs them, with retention limits.
- [ ] Shortcode ownership verified via B2B Hakikisha at setup; tariff
  recorded for cost reporting.

## 24. Endpoint version log

Observed versions with observation context. Re-verify here when a call
starts failing with version/route errors.

| API family | Observed path | Seen | Source |
|---|---|---|---|
| OAuth | `oauth/v1/generate` | Sep 2026 | Portal docs + live use |
| STK simulate/query | `mpesa/stkpush/v1/*`, `mpesa/stkpushquery/v1/*` | Sep 2026 | Portal docs + live use |
| C2B register | `mpesa/c2b/v2/registerurl` | Sep 2026 | Portal docs (v2 current; v1 hashes MSISDN) |
| B2C | `mpesa/b2c/v3/paymentrequest` | Sep 2026 | Portal docs |
| B2B payments/tax | `b2b/v1/*` | Sep 2026 | Portal docs |
| Reversal | `mpesa/reversal/v1/request` | Sep 2026 | Portal docs |
| Status/Balance | `mpesa/transactionstatus/v1/*`, `mpesa/accountbalance/v1/*` | Sep 2026 | Portal docs |
| QR | `mpesa/qrcode/v1/generate` | Sep 2026 | Portal docs |
| Pull | `pulltransactions/v1/*` | Sep 2026 | Portal docs |
| KYC/fraud | `v1/KYC-validation/*`, `imsi/v2/*`, `registration/lookup/v1/*` | Sep 2026 | Portal docs |
| Hakikisha | `c2b_hakikisha/v1/*`, `b2c/hakikisha/v1/*`, `sfcverify/v1/*` | Sep 2026 | Portal docs |
| Ratiba/Bonga/Bundles/IoT | `standingorder/v1/*`, `v1/lipa/na/bonga/*`, `v1/dynamic-offers/*`, `simportal/*` | Sep 2026 | Portal docs |

## 25. Failure-mode plays

What to do when — not just what the code means.

- **Callbacks stop arriving.** Check ResultURL health + gateway IP
  whitelist first (silent firewall change is the usual cause), then
  Transaction Status on recent receipts, then Pull Transactions for the
  window. Backfill from Pull; fix ingress; re-register C2B URLs only if
  the portal shows them changed.
- **Tokens invalidating mid-burst.** Symptom: intermittent 404.001.03
  under concurrency. Cause: two workers minting (each mint kills the
  other). Fix: single shared cache with expiry margin (§3).
- **Pull shows what webhooks missed.** Normal — that is Pull's job.
  Ingest missing TransIDs through the standard reconcile path (dedupe
  makes replays safe), then investigate why callbacks missed (URL
  change? expired domain on the registered host? deploy wiped routes?).
- **Spike arrest / quota (500.003.02/.03).** Back off exponentially,
  shed simulator traffic first, alert. Never retry bursts blindly —
  each retry counts against quota.
- **Shortcode moved/expired.** Confirmations route to registered URLs
  regardless of DNS ownership. If the domain lapsed, treat Pull as
  primary ingestion until Safaricom updates the registration, and
  announce the number change to payers fast.
- **Initiator locked (8006) / dormant roles.** Business Admin unlocks;
  check 90-day password expiry before debugging code.

## 26. Testing strategy

- Sandbox per API + portal simulator (login-gated) + Postman
  collections (login-gated). Simulators accept sandbox codes only.
- Register C2B URLs before each sandbox simulation; production once.
- Contract-test every callback shape (success, cancel, timeout,
  reversal) with fixtures; test masked vs full MSISDN paths.
- Load-test callback idempotency (duplicate delivery is normal).

## 27. Production runbook

1. Go-live per shortcode (org name, admin/manager username, OTP).
2. Register C2B URLs once; verify flag; test with 10 KES live payment.
3. Set up initiator operators + roles + 90-day password rotation.
4. Fund Utility for B2C; schedule nightly Pull + Balance diffs.
5. Monitor ResultURL health, token cache, spike/quota errors; alert on
   new-sender bursts and outliers.
6. Incident path: portal incident management + apisupport@safaricom.co.ke.

## 28. Error-code index

| Code | Meaning | Typical fix |
|---|---|---|
| 0 | Success / accepted (async: result follows) | — |
| 1032 / 1031 | STK cancelled / handset timeout | Retry after 2–3 min with consent |
| 1037 | STK never reached phone | Check SIM age, retry |
| 1001 | Subscriber locked (parallel session) | One push at a time, 1 min gap |
| 1050 | Ratiba duplicate name | Unique name per customer |
| 2001 | Initiator credentials invalid | Username, encryption, cert |
| 21 / 2028 / 2040 | Initiator role / permission / customer type | Roles, product enablement |
| 8006 | Credential locked | Business Admin unlocks |
| 400.003.02 | Bad request (incl. banned URL words) | Fix payload/URLs |
| 404.001.03/.04 | Bad/expired token, wrong endpoint/method | Refresh token, check POST |
| 500.003.1001 | Internal (incl. URLs already registered) | Check setup; re-register = success |
| 500.003.02/.03 | Spike arrest / quota | Back off, reduce rate |
| R000001 / R000002 | Already reversed / invalid receipt | Dedupe / verify receipt |
| C2B00011–16 | Validation reject | Show reason to payer |
| 15 / 24 / 25 | Duplicate conversation ID / missing / bad params | Unique IDs, validate |
| 400 / 401 / 404 | HTTP-level bad/auth/missing | Payload, credentials, path |
