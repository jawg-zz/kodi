# Daraja API — Full Capability Map (Daraja 3.0)

Compiled from reading every catalogue doc on developer.safaricom.co.ke.
Purpose: what each API does, exact versions/paths observed, and Kodi relevance.

## 0. Platform fundamentals (Getting Started + Authorization)

- REST, GET only for OAuth token, everything else POST, JSON.
- OAuth: `oauth/v1/generate?grant_type=client_credentials` (Basic key:secret), 3600s expiry. **Each new token invalidates the previous** → cache tokens, don't mint per call.
- Async APIs answer synchronously (accepted) then callback to ResultURL/QueueTimeOutURL. **No auto-retries on callback failure** — poll status manually.
- Callback IP whitelist (Safaricom gateway): 196.201.214.200, .206, 196.201.213.114, 196.201.214.207, 196.201.214.208, 196.201.213.44, 196.201.212.127, .138, .129, .136, .74, .69.
- SecurityCredential = base64(RSA_X509_PKCS1.5(base64(password))). Downloadable sandbox/production certs on portal. Initiator password: avoid @ or . ; valid 90 days.
- Callback URLs must be public HTTPS, no "MPESA"/Safaricom/exe/cmd/sql/query substrings, no ngrok/mockbin in production.
- Org portal: org.ke.m-pesa.com. Accounts: Utility (receives), Working/MMF (holding), Charges Paid (negative), Settlement (auto-moves Utility→MMF). Roles: Business Admin (creates users, no tx view), Manager (approve/balances/withdraw), API initiator (per-API roles), Auditor read-only.

## 1. Collections (money IN)

### 1.1 M-Pesa Express / STK Push — LIVE IN KODI
- Simulate: `mpesa/stkpush/v1/processrequest`. Query: `mpesa/stkpushquery/v1/query`. Both v1, current.
- Request: BusinessShortCode, Password=base64(shortcode+passkey+timestamp), Timestamp YYYYMMDDHHmmss, CustomerPayBillOnline/CustomerBuyGoodsOnline, Amount, PartyA/PhoneNumber 2547XXXXXXXX, CallBackURL, AccountReference max 12 chars (why Kodi slices tenantId), TransactionDesc max 13.
- Callback: Body.stkCallback {ResultCode 0/1032/1037, CallbackMetadata Amount/MpesaReceiptNumber/TransactionDate/PhoneNumber/Balance}.
- Limits: 250k/txn, 500k account, 500k/day, min 1. "Unable to lock subscriber": wait 1 min between pushes. Till works via CustomerBuyGoodsOnline (PartyB=till).
- Express IS reversible via Reversal API. History in org portal.

### 1.2 C2B v2 — LIVE IN KODI (migrated v1→v2)
- Register: `mpesa/c2b/v2/registerurl`. Production one-time; changes via Self Services → URL Management (2 operators) or apisupport.
- v1 payloads: SHA-256 hashed MSISDN. **v2 payloads: masked MSISDN (2547***126)** → exact phone matching impossible; Kodi uses prefix/suffix pattern-as-hint.
- Validation (optional, email activation ~6h, 8s window): accept `{ResultCode 0, Accepted}`, reject C2B00011–16 (MSISDN/account/amount/KYC/shortcode/other).
- Confirmation fields: TransID, TransAmount (whole numbers), BusinessShortCode, BillRefNumber (≤20 chars, paybill only), TransTime, First/Middle/LastName.
- Kodi mapping: account code → tenant, national-ID fallback, masked-phone hint, review queue, TransID dedupe.

### 1.3 Bill Manager — LIVE IN KODI
- Opt-in: `v1/billmanager-invoice/optin` (shortcode, email, officialContact, sendReminders 0/1, logo, callbackurl) → app_key, whitelists shortcode.
- Single: `.../single-invoicing`. Bulk: `.../bulk-invoicing` (≤1000/call, appKey header). Fields: externalReference (Kodi invoice id), billedFullName/Phone, billedPeriod, invoiceName, dueDate, **accountReference (our tenant code)**, amount, invoiceItems[].
- Safaricom sends e-invoice SMS + **7/3/0-day reminders itself**. Customer may still pay via USSD/STK/app with correct ref.
- Payments push to our callback `{transactionId, paidAmount, msisdn FULL, dateCreated, accountReference, shortCode}` retried 5×; we reconcile + acknowledge → Safaricom sends e-receipt.
- Cancel single/bulk (409 if paid). Change-optin-details available.
- Kodi fit: generate Kodi invoices → mirror to Bill Manager bulk (externalReference = invoice id) → Safaricom handles SMS + reminders + receipts; payments arrive on a dedicated callback with full phone.

### 1.4 Dynamic QR — LIVE IN KODI
- `mpesa/qrcode/v1/generate`: MerchantName, RefNo, Amount, TrxCode (BG/WA/**PB**/SM/SB), CPI (shortcode for PB), Size → base64 QR image.
- Kodi fit: per-invoice QR (PB + shortcode + account-code RefNo + balance) on invoice/statement prints. Open Q: does scanned payment carry RefNo into BillRefNumber (likely, unconfirmed).

### 1.5 Lipa na Bonga — LIVE IN KODI
- calculate-points + redeem-paybill (`v1/lipa/na/bonga/*`), 0.2 KES/point, PIN-auth STK-style flow, funds land on Paybill → C2B callback to our URLs. Own SHA256 user/pass auth.
- Kodi fit: part-pay rent with points; confirmations reuse C2B path.

### 1.6 Ratiba (standing orders) — LIVE IN KODI
- `standingorder/v1/createStandingOrderExternal`. Commercial: signed agreement, 5% capped 5 KES/execution + C2B tariffs.
- PIN-consent mandate creation, Frequency 5=Monthly, account ref ≤12, unique names/customer (1050), masked MSISDN callbacks.
- Kodi fit: tenant authorizes monthly rent once; executions arrive as C2B. Needs mandate tracking (create/amend/cancel).

### 1.7 C2B Hakikisha — HOST LIVE IN KODI
- REVERSED direction: Safaricom calls us (`c2b_hakikisha/v1/notify`, we host token + notify endpoints) with accountNumber+shortcode; we return accountName shown on payer's STK/USSD/app screen.
- Needs apisupport onboarding + reciprocal B2C Hakikisha contract.
- Kodi fit: return tenant name for account codes → typos caught pre-payment, review queue shrinks to phone-only cases.

## 2. Disbursements (money OUT, all need initiator cert + roles)

### 2.1 B2C v3 — LIVE IN KODI (deposit refunds)
- `mpesa/b2c/v3/paymentrequest`. Needs Bulk/One-account shortcode. OriginatorConversationID dedupes. BusinessPayment/SalaryPayment/PromotionPayment. Limits 10–250k, 500k balance/day. Callback reveals receiver name + balances. Status-queryable. Passkey NOT needed, credential reusable. MMF→Utility funding manual or via B2B BusinessTransferFromMMFToUtility. **B2C reversals API-unsupported (portal only).**
- Kodi fit: in-app deposit refunds to tenant wallets.

### 2.2 B2C Account Top Up — LIVE IN KODI (float funding)
- `b2b/v1/paymentrequest` CommandID BusinessPayToBulk, MMF→B2C utility. Role: Org Business Pay to Bulk initiator.

### 2.3 Business To Pochi — LIVE IN KODI (niche)
- `b2pochi/v1/paymentrequest`, BusinessPayToPochi to micro-SME wallets. Only if refunds go to Pochi wallets.

### 2.4 Business Pay Bill / Buy Goods — LIVE IN KODI (ops automation)
- `b2b/v1/paymentrequest`, BusinessPayBill/BusinessBuyGoods, MMF→utility/merchant, optional Requester (pay on behalf of). Kodi fit: automate MMF→Utility funding, supplier payments.

### 2.5 B2B Express Checkout — LIVE IN KODI
- `v1/ussdpush/get-msisdn`, USSD push to till operators (operator ID+PIN). Merchant till→paybill. No Kodi tenant use.

### 2.6 Tax Remittance — LIVE IN KODI
- `b2b/v1/remittax`, PayTaxToKRA, fixed PartyB 572572, ref = KRA PRN (needs prior KRA integration). Rental-income tax from Kodi later.

### 2.7 B2C Hakikisha — LIVE IN KODI (pairs with B2C)
- We call `b2c/hakikisha/v1/hakikisha` (MSISDN+shortcode) → first name + masked rest. Pre-flight before deposit refunds. Reciprocal contract with C2B Hakikisha.

## 3. Verification, reconciliation, fraud signals

### 3.1 Transaction Status v1 — LIVE IN KODI
- `mpesa/transactionstatus/v1/query`, works on C2B/B2B/B2C/IMT/Reversal via receipt or OriginatorConversationID. Async with ResultURL, three tiers (Initiated→Authorized→Completed/Cancelled/Declined/Expired). Needs initiator + RSA credential.
- Kodi fit: genuine TransID verification for queued hits once cert flow done.

### 3.2 Account Balance v1 — LIVE IN KODI
- `mpesa/accountbalance/v1/query`, async ResultURL callback (no retries), pipe-delimited per-account balances. Own-shortcode-only, schedulable.
- Kodi fit: nightly M-Pesa-vs-ledger diff (diversion/hold detection).

### 3.3 Pull Transactions — LIVE IN KODI (safety net)
- Register once (`pulltransactions/v1/register`), query 48h window with offset pagination, C2B-only. **Pull rows carry FULL numeric msisdn** → authoritative phone source reconciling masked v2 hits.
- Kodi fit: nightly pull-and-diff job catching webhook misses (e.g. expired-domain reroutes).

### 3.4 Reversals v1 — LIVE IN KODI (inbound + outbound)
- `mpesa/reversal/v1/request`, C2B-only, receipt as TransactionID, ReceiverParty + id 11, R000001 already-reversed / R000002 invalid. Needs Org Reversals Initiator.
- Kodi fit: staff-initiated reversals from the receipt page (duplicate debits refunded without shop visits). B2C outbound reversals unsupported — portal only.

### 3.5 Mobile Number Validation (KYC) — LIVE IN KODI
- `v1/KYC-validation/validateID`: phone + idType (01/02/05) + idNumber → TRUE/FALSE, no PII returned. Commercial ~4.5 KES tapering.
- Kodi fit: authoritative check behind national-ID fallback + onboarding verification.

### 3.6 SIM Swap / IMSI / Age on Network — LIVE IN KODI (fraud trio)
- Swap `imsi/v2/checkATI`: last swap date (>3mo → 1900-01-01). 50k connection, 200k free, 1 KES/req.
- IMSI V1/V2/V3: hashed IMSI + age + swap bundles (V2 age-only). 20 KES/call.
- Age `registration/lookup/v1/checkATI`: SIM registration date, ~4 KES tapering, unsuccessful calls unbilled.
- Kodi fit: recent-swap / brand-new-SIM signals in risk engine (portal signup, large refunds).

### 3.7 B2B Hakikisha (QueryOrgInfo) — LIVE IN KODI (setup guard)
- `sfcverify/v1/query/info`, shortcode + type 4/2 → org name + charge profile, sync OAuth-only. Tariffs: Mgao split / Bouquet variants.
- Kodi fit: "615395 belongs to X on tariff Y" check at Settings setup.

## 4. No Kodi relevance
- Mobile Data Bundles (dynamic offers/top-ups), IoT SIM Management (simportal SIM lifecycle/messaging).

## 5. Cross-cutting integration notes (from docs)
- Endpoint families observed: oauth/v1, stkpush/v1, stkpushquery/v1, c2b/v2, b2c/v3, b2b/v1, b2pochi/v1, qrcode/v1, sfcverify/v1, imsi/v2, registration/lookup/v1, KYC-validation/v1, lipa/na/bonga/v1, dynamic-offers/v1+v2, ussdpush/v1, standingorder/v1, billmanager-invoice/v1, pulltransactions/v1, accountbalance/v1, transactionstatus/v1, reversal/v1, remittax (b2b/v1), c2b_hakikisha/v1, b2c/hakikisha/v1, simportal/*.
- New OAuth token invalidates previous → cached per org on the mpesaCredentials row (lib/daraja.ts + get/storeCachedDarajaToken), reused with a 2-minute skew margin.
- STK limits 250k/txn; "lock subscriber" → 1-min throttle on repeat pushes.
- AccountReference ≤12 (STK) / ≤13 (B2B) / ≤20 (C2B BillRef).
- Production C2B registration one-time; changes via portal URL Management (2 operators) or apisupport.
- Password rules: no @ or . ; 90-day validity. Initiator roles per API.
- Sandbox simulators + Postman collections per API (login-gated).

## 6. Recommended build order for Kodi
1. OAuth token cache (correctness fix from Authorization doc).
2. C2B external validation activation + specific C2B0001x codes (queue reduction).
3. Pull reconciliation nightly job (safety net; full phones).
4. B2B Hakikisha setup guard (misconfig catcher).
5. Bill Manager mirror (SMS + reminders + receipts outsourced).
6. Dynamic QR per invoice (typo killer for smartphones).
7. Initiator-cert track: Transaction Status verify → outbound Reversals → B2C refunds (+Top Up float, B2C Hakikisha pre-flight).
8. Ratiba autopay (commercial agreement track in parallel).
9. Fraud trio (Swap/Age/IMSI) + Mobile Number Validation in risk engine.
10. Lipa na Bonga part-payments; Tax Remittance later.
