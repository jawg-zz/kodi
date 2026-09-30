# Daraja API Developer Guide (Daraja 3.0)

How to integrate every Safaricom Daraja API: auth, requests, callbacks,
errors, and how Kodi uses each one. Read front to back for onboarding, or
jump to one API section for reference.

 Bussiness context: Kodi is a rent manager. Money flows tenant → Paybill
 (collections) and business → tenant (refunds). Fraud and KYC APIs guard
 both directions.

---

## 1. First principles (read this once)

### 1.1 Environments

| | Sandbox | Production |
|---|---|---|
| Host | `https://sandbox.safaricom.co.ke` | `https://api.safaricom.co.ke` |
| Shortcodes | Test codes from the simulator | Your live Paybill/Till (go-live) |
| Callbacks | HTTP allowed | HTTPS only, public, no tunnel URLs |

### 1.2 Auth (OAuth client-credentials — the ONLY GET on the platform)

```
GET /oauth/v1/generate?grant_type=client_credentials
Authorization: Basic base64(consumerKey:consumerSecret)
```

Response: `{ "access_token": "...", "expires_in": 3599 }`.

Rules that bite:

- Tokens live 3600s. **Minting a new token invalidates the previous one.**
  Cache the token with its expiry; never mint per API call (concurrent
  calls will kill each other's tokens).
- Every other Daraja call is POST with `Authorization: Bearer <token>`.

### 1.3 Async pattern (almost every money API)

1. You POST a request → Daraja answers synchronously (`ResponseCode 0` =
   accepted, not completed).
2. M-Pesa processes → Daraja POSTs the result to your `ResultURL`
   (and timeouts to `QueueTimeOutURL`).
3. **No automatic retries.** If your callback is down, the result is
   discarded (503 logged). Poll Transaction Status yourself.

### 1.4 SecurityCredential (initiator APIs: B2C/B2B/Status/Balance/Reversal)

1. Base64-encode the initiator password.
2. Encrypt with the M-Pesa X509 public key (portal download — use the
   Sandbox cert for sandbox, Production cert for production),
   RSA with **PKCS#1.5 padding (not OAEP)**.
3. Base64-encode the ciphertext. That string is the credential.

Initiator setup (org portal): Business Admin creates API operator →
assign per-API role → Business Manager sets password (avoid `@` and `.`,
valid 90 days). Roles: ORG B2C API initiator, Business Paybill/BuyGoods
initiator, Transaction Status query, Org Reversals Initiator, Balance
Query, Set Restricted ORG API PASSWORD.

### 1.5 Callback hygiene (applies to every URL you register)

- Public HTTPS, reachable, POST listener.
- Must NOT contain: `mpesa`/`M-PESA`, `safaricom`, `exe`, `exec`,
  `cmd`, `sql`, `query` (Daraja rejects with 400.003.02).
- Accept Safaricom gateway IPs (whitelist these):
  `196.201.214.200`, `.206`, `196.201.213.114`, `196.201.214.207`,
  `196.201.214.208`, `196.201.213.44`, `196.201.212.127`, `.138`,
  `.129`, `.136`, `.74`, `.69`.
- Org accounts: Utility receives, Working/MMF holds, Charges Paid goes
  negative, Settlement auto-moves Utility→MMF. B2C debits Utility —
  fund it from MMF first (manual portal step or B2B
  `BusinessTransferFromMMFToUtility`).

---

## 2. Collections (money IN)

### 2.1 M-Pesa Express / STK Push — LIVE IN KODI

Business-initiated prompt to the customer's phone. No URL registration:
each request carries its own `CallBackURL`.

**Simulate (send the prompt):** `POST mpesa/stkpush/v1/processrequest`

```json
{
  "BusinessShortCode": 615395,
  "Password": "base64(shortcode+passkey+Timestamp)",
  "Timestamp": "20260101120000",
  "TransactionType": "CustomerPayBillOnline",
  "Amount": 15000,
  "PartyA": "254722000001",
  "PartyB": 615395,
  "PhoneNumber": "254722000001",
  "CallBackURL": "https://your.site/stk-callback",
  "AccountReference": "GC-A1",
  "TransactionDesc": "Rent"
}
```

Field limits: AccountReference ≤ 12 chars, TransactionDesc ≤ 13.
Use `CustomerBuyGoodsOnline` with PartyB = till for Till numbers.
Response: `{MerchantRequestID, CheckoutRequestID, ResponseCode 0}`.

**Callback** `Body.stkCallback`: ResultCode `0` success /
`1032` cancelled / `1037` timeout; on success CallbackMetadata holds
Amount, MpesaReceiptNumber, TransactionDate, PhoneNumber.

**Query (poll):** `POST mpesa/stkpushquery/v1/query`
`{BusinessShortCode, Password, Timestamp, CheckoutRequestID}`.

Money limits: 1 – 250,000 per push, 500k account/day.
"Unable to lock subscriber" → wait 1 minute between pushes.
Express transactions ARE reversible via the Reversal API.
Kodi: `convex/mpesa.ts` (initiate/poll), `convex/http.ts` /stk-callback.

### 2.2 C2B (Paybill self-serve) — LIVE IN KODI (v2)

Tenant pays from their own M-Pesa menu. Requires one-time URL
registration per shortcode (portal Self Services → URL Management to
change; API re-register is rejected once live).

**Register:** `POST mpesa/c2b/v2/registerurl`
`{ShortCode, ResponseType: "Completed", ConfirmationURL, ValidationURL}`.

**Validation** (optional; enable via apisupport email, ~6h; 8s window):
accept `{ResultCode: "0", ResultDesc: "Accepted"}`,
reject with C2B00011–16 (MSISDN / account / amount / KYC / shortcode /
other) — the tenant sees the reason on their phone.

**Confirmation fields:** TransID, TransAmount (whole KES),
BusinessShortCode, BillRefNumber (≤ 20, paybill only), TransTime,
First/Middle/LastName.
**v1** payloads hash the MSISDN (SHA-256). **v2 masks it**
(`2547***126`) — exact phone lookup is impossible; match on account
code first.
Kodi: `convex/c2b.ts`, routes `/c2b-validation`, `/c2b-confirmation`.

### 2.3 Bill Manager — LIVE IN KODI

Safaricom-hosted e-invoicing + reminders + receipts.

1. Opt in: `POST v1/billmanager-invoice/optin`
   `{shortcode, email, officialContact, sendReminders 0|1, logo?, callbackurl}`
   → `{app_key}` (send as header on later calls). `sendReminders: 1` =
   Safaricom SMSes the customer 7/3/0 days before due.
2. Invoice one: `POST .../single-invoicing`. Invoice many (≤ 1000/call):
   `POST .../bulk-invoicing` with a `bulk` array. Fields per invoice:
   externalReference (= your invoice id), billedFullName/Phone,
   billedPeriod, invoiceName, dueDate, **accountReference (= tenant
   Paybill code)**, amount, invoiceItems[].
3. Customer gets SMS, pays via any channel with the ref. Payment pushes
   to your callback `{transactionId, paidAmount, msisdn FULL,
   dateCreated, accountReference, shortCode}` (retried 5×).
4. You reconcile, then acknowledge → Safaricom sends the e-receipt.
5. Cancel single/bulk while unpaid (409 once paid).

Kodi: `convex/billManager.ts` (optIn/mirror/cancel/update), `/billmanager-callback` ingest → ledger, Settings → Bill Manager card.

### 2.4 Dynamic QR — LIVE IN KODI

`POST mpesa/qrcode/v1/generate`:
`{MerchantName, RefNo, Amount, TrxCode: "PB", CPI: "<shortcode>", Size}`
→ `{QRCode: "<base64 png>"}`. Tenant scans with the M-Pesa app; no
typing. Kodi: `convex/collect.ts` mintInvoiceQr (cached on invoiceQrs) + QR button on each invoice row.

### 2.5 Lipa na Bonga — LIVE IN KODI

Loyalty points at 0.2 KES/point. `calculate-points` then
`redeem-paybill` (`v1/lipa/na/bonga/*`, own SHA256 user/pass auth),
PIN-confirmed STK-style flow; funds land on the Paybill and the C2B
callback fires on our registered URLs. Kodi: `convex/bonga.ts` quote/redeem + review-queue Bonga buttons + Settings operator card.

### 2.6 Ratiba (standing orders) — LIVE IN KODI (needs contract)

Commercial API: `POST standingorder/v1/createStandingOrderExternal`.
Tenant PIN-consents once; debits recur (Frequency 5 = Monthly).
Account ref ≤ 12, names unique per customer (1050 on clash), masked
MSISDN callbacks. Pricing ~5% capped 5 KES/execution + C2B tariffs.
Kodi: `convex/ratiba.ts` mandate tracking (create/amend/cancel/confirm) + tenant-page Mandates card.

### 2.7 C2B Hakikisha — HOST LIVE IN KODI (needs onboarding)

Reversed direction: **Safaricom calls you**.
`POST c2b_hakikisha/v1/notify` → you return `{accountName}` for
`{accountNumber, shortcode}`; the payer sees the name pre-confirm on
STK/USSD/app. Requires apisupport onboarding + reciprocal B2C
Hakikisha contract + you hosting token and notify endpoints.
Kodi: `/hakikisha-token` + `/hakikisha-notify` host (`convex/hakikishaInternal.ts`) returning tenant names.

---

## 3. Disbursements (money OUT — all need initiator credential + role)

All async with ResultURL/QueueTimeOutURL callbacks. Limits ~10–250k per
transaction unless noted.

### 3.1 B2C v3 — LIVE IN KODI (deposit refunds)

`POST mpesa/b2c/v3/paymentrequest`. Requires Bulk/One-account shortcode.
`OriginatorConversationID` dedupes double disbursement (reuse the
pattern). BusinessPayment/SalaryPayment/PromotionPayment. Callback
reveals receiver name + balances. Status-queryable. No passkey; credential
reusable. Fund Utility from MMF first. **B2C reversals API-unsupported —
portal only.**
Kodi: `convex/payouts.ts` payB2cRefund (settlement link + Hakikisha pre-flight checkbox) + Reports → Payouts card.

### 3.2 B2C Account Top Up — LIVE IN KODI (float funding)

`b2b/v1/paymentrequest`, CommandID `BusinessPayToBulk`: MMF → B2C
utility. Kodi: `convex/payouts.ts` topUpFloat + Reports → Payouts card.

### 3.3 Business To Pochi — LIVE IN KODI (niche)

`b2pochi/v1/paymentrequest`, `BusinessPayToPochi` to micro-SME wallets.
Kodi: `convex/payouts.ts` payToPochi (owner action).

### 3.4 Business Pay Bill / Buy Goods — LIVE IN KODI (ops)

`b2b/v1/paymentrequest`, `BusinessPayBill` / `BusinessBuyGoods`:
MMF → utility/merchant, optional `Requester` (pay on someone's behalf),
account ref ≤ 13. Kodi: `convex/payouts.ts` payBusinessBill (PayBill/BuyGoods/MMF→Utility) — owner action.

### 3.5 B2B Express Checkout — LIVE IN KODI (ops completeness)

`v1/ussdpush/get-msisdn`: USSD push to till operators (operator ID+PIN).
Merchant till→paybill only. Kodi: `convex/payouts.ts` expressCheckoutPush (owner action, PIN never stored).

### 3.6 Tax Remittance — LIVE IN KODI

`b2b/v1/remittax`, `PayTaxToKRA`, fixed PartyB 572572, ref = KRA PRN
(requires prior KRA integration). Kodi: `convex/payouts.ts` remitTax (owner action, fixed PartyB 572572).

### 3.7 B2C Hakikisha — LIVE IN KODI (pairs with B2C)

We call `b2c/hakikisha/v1/hakikisha` (MSISDN+shortcode) → first name +
masked rest. Kodi: `convex/payouts.ts` hakikishaB2c — runs automatically before every B2C refund in the settle modal.

---

## 4. Verify, reconcile, know-your-customer

### 4.1 Transaction Status v1 — LIVE IN KODI

`POST mpesa/transactionstatus/v1/query`: receipt OR
OriginatorConversationID + PartyA + initiator credential. Covers
C2B/B2B/B2C/IMT/Reversal. Async with ResultURL. Tiers: Initiated →
Authorized → Completed/Cancelled/Declined/Expired.
Kodi: `convex/verify.ts` queryTransactionStatus + review-queue Verify-at-Daraja button + job history.

### 4.2 Account Balance v1 — LIVE IN KODI

`POST mpesa/accountbalance/v1/query` (initiator credential), async
ResultURL callback (**no retries** — poll status on silence). Response
is pipe-delimited per-account balances. Own-shortcode-only, schedulable.
Kodi: `convex/verify.ts` queryAccountBalance + latestBalance + Reports → Payouts card.

### 4.3 Pull Transactions — LIVE IN KODI (safety net)

One-time `pulltransactions/v1/register`, then query 48h windows with
offset pagination (C2B only). **Pull rows carry FULL numeric MSISDN** —
the authoritative phone source for reconciling masked v2 hits.
Kodi: `convex/verify.ts` registerPull + pullC2bWindow (auto-ingest → ledger) + due-org selectors.

### 4.4 Reversals v1 — LIVE IN KODI (inbound + outbound)

`POST mpesa/reversal/v1/request`: C2B-only, receipt as TransactionID,
ReceiverParty + id 11. R000001 already-reversed / R000002 invalid
receipt. Needs Org Reversals Initiator. B2C outbound reversals
unsupported (portal only).
Kodi: `convex/payouts.ts` reverseDarajaPayment + receipt Reverse-at-Daraja button; completion auto-voids.

### 4.5 Mobile Number Validation (KYC) — LIVE IN KODI

`POST v1/KYC-validation/validateID`: phone + idType
(01 NationalID / 02 Military / 05 Passport) + idNumber → TRUE/FALSE,
no PII. Commercial ~4.5 KES tapering. Needs apisupport onboarding.
Kodi: `convex/fraud.ts` validateTenantId + tenant-page KYC card (cached).

### 4.6 SIM Swap / IMSI / Age on Network — LIVE IN KODI (fraud trio)

- Swap `imsi/v2/checkATI`: last swap date (>3mo → 1900-01-01). 50k KES
  connection, 200k free, 1 KES/req.
- IMSI V1/V2/V3: hashed IMSI + age + swap bundles. 20 KES/call.
- Age `registration/lookup/v1/checkATI`: SIM registration date,
  ~4 KES tapering, failed calls unbilled.
Kodi: `convex/fraud.ts` checkSimSwap/checkSimAge/checkImsi + tenant-page KYC card (cached).

### 4.7 B2B Hakikisha (QueryOrgInfo) — LIVE IN KODI (setup guard)

`POST sfcverify/v1/query/info`: shortcode + type 4/2 → org name +
charge profile, sync, OAuth only. Tariffs: Mgao split vs Bouquet variants.
Kodi: `convex/collect.ts` verifyShortcodeOwner + Settings → Smart collections card.

---

## 5. No Kodi relevance

Mobile Data Bundles (dynamic offers/top-ups), IoT SIM Management
(`simportal/*` SIM lifecycle + messaging).

## 6. Error-code quick index

| Code | Meaning | Typical fix |
|---|---|---|
| 0 | Success / accepted (async: accepted, result follows) | — |
| 1032 / 1031 | STK cancelled / timed out at handset | Retry after 2–3 min with consent |
| 1037 | STK never reached phone / no response | Check SIM age, retry |
| 1001 | Subscriber locked (parallel USSD/STK session) | One push at a time, 1 min gap |
| 2001 | Initiator credentials invalid | Username, encryption, cert |
| 21 / 2028 | Initiator lacks the API role | Assign role on org portal |
| 8006 | Security credential locked | Business Admin unlocks |
| 400.003.02 | Bad request (incl. banned URL words) | Fix payload/URLs |
| 404.001.03/.04 | Bad/expired token, wrong endpoint/method | Refresh token, check POST |
| 500.003.1001 | Internal (incl. URLs already registered) | Check setup; treat re-register as success |
| R000001 / R000002 | Already reversed / invalid receipt | Dedupe / verify receipt |
| C2B00011–16 | Validation reject (MSISDN/account/amount/KYC/code/other) | Show reason to payer |
| 1050 | Ratiba duplicate standing-order name | Unique name per customer |
| 15 / 24 / 25 | Duplicate conversation ID / missing / bad params | Unique IDs, validate payload |
