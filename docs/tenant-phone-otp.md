# Tenant phone-OTP login — enablement guide

Tenants today claim portal access with an **email-based invite** (Logto
sign-in + invite token). Many Kenyan tenants don't use email, but every
tenant has a Safaricom number. Switching tenant login to **SMS OTP**
removes the biggest tenant-side onboarding friction — and the same SMS
channel later unlocks rent-reminder SMS.

## What's already in place

- Tenants are linked to logins via `tenantUsers` (userId → tenantId), and
  the portal resolves through `myOrg`'s tenant branch — no email anywhere
  in that path. OTP only changes *how the userId is minted*, not the link.
- The landlord-side invite flow (`inviteUser` → token → `claimInvite`)
  already captures the tenant's **phone** alongside email. For OTP, the
  phone becomes the identifier and the token step can stay as-is.
- The portal's Paybill/STK payment paths never require login, so OTP is a
  value-add for balance/statement views — safe to roll out incrementally.

## Steps to enable (operator)

1. **Pick an OTP provider.** Africa's Talking is the cheap Kenyan path
   (~KES 0.8–1.2/SMS in 2025 pricing). Alternatives: Twilio Verify.
2. **Get a sender ID.** Register an alphanumeric sender ID (e.g. "KODI")
   with the provider + Safaricom approval. This is the slow step — start
   it before any code.
3. **Logto: add an SMS connector.** Logto Console → Connectors → add the
   matching SMS connector (Africa's Talking community connector or
   Twilio). Configure API key / sender ID / template:
   `Your Kodi code is {code}. It expires in 10 minutes.`
4. **Logto: enable phone sign-in.** Sign-in Experience → Sign-up and
   Sign-in → add "Phone number + verification code" as a method. Keep
   email+password for staff (they already have emails).
5. **Kodi: invite by phone.** Change `InviteTenantButton` to send the
   invite link via the tenant's phone (WhatsApp share already exists —
   reuse it) and instruct the tenant to sign in with that number. The
   `claimInvite` token flow is unchanged: after OTP sign-in, the token
   links the new userId to the tenant row.
6. **Test with KES-1 discipline.** Invite a test tenant on your own line,
   sign in via OTP, claim, confirm the portal shows the right tenant.
   Cost: one SMS.

## Cost estimate

Tenants log in roughly monthly. 50 active tenants × ~KES 1/SMS ≈
KES 50/month. Negligible at Kodi's scale; revisit if reminder-SMS
volume grows. If SMS ever bites, WhatsApp delivery is the natural
fallback (Kodi already shares QRs/captions to WhatsApp).

## What NOT to change

- Staff keep email login. Phone OTP is tenant-only.
- `tenantUsers` linking, `myOrg` tenant branch, and the payment paths
  stay exactly as they are.
- No schema changes are needed for OTP itself.
