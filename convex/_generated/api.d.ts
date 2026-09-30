/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as billManager from "../billManager.js";
import type * as billManagerInternal from "../billManagerInternal.js";
import type * as bonga from "../bonga.js";
import type * as bongaInternal from "../bongaInternal.js";
import type * as c2b from "../c2b.js";
import type * as collect from "../collect.js";
import type * as collectInternal from "../collectInternal.js";
import type * as crons from "../crons.js";
import type * as darajaJobs from "../darajaJobs.js";
import type * as demo from "../demo.js";
import type * as export_ from "../export.js";
import type * as fraud from "../fraud.js";
import type * as fraudInternal from "../fraudInternal.js";
import type * as hakikishaInternal from "../hakikishaInternal.js";
import type * as helpers from "../helpers.js";
import type * as http from "../http.js";
import type * as invites from "../invites.js";
import type * as invitesInternal from "../invitesInternal.js";
import type * as invoices from "../invoices.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_credit from "../lib/credit.js";
import type * as lib_daraja from "../lib/daraja.js";
import type * as lib_initiator from "../lib/initiator.js";
import type * as lib_initiatorJobs from "../lib/initiatorJobs.js";
import type * as lib_ledger from "../lib/ledger.js";
import type * as lib_mpesaCrypto from "../lib/mpesaCrypto.js";
import type * as mpesa from "../mpesa.js";
import type * as mpesaInternal from "../mpesaInternal.js";
import type * as orgs from "../orgs.js";
import type * as payments from "../payments.js";
import type * as payouts from "../payouts.js";
import type * as payoutsInternal from "../payoutsInternal.js";
import type * as properties from "../properties.js";
import type * as ratiba from "../ratiba.js";
import type * as ratibaInternal from "../ratibaInternal.js";
import type * as reconcileInternal from "../reconcileInternal.js";
import type * as reports from "../reports.js";
import type * as seed from "../seed.js";
import type * as tenants from "../tenants.js";
import type * as verify from "../verify.js";
import type * as verifyInternal from "../verifyInternal.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  billManager: typeof billManager;
  billManagerInternal: typeof billManagerInternal;
  bonga: typeof bonga;
  bongaInternal: typeof bongaInternal;
  c2b: typeof c2b;
  collect: typeof collect;
  collectInternal: typeof collectInternal;
  crons: typeof crons;
  darajaJobs: typeof darajaJobs;
  demo: typeof demo;
  export: typeof export_;
  fraud: typeof fraud;
  fraudInternal: typeof fraudInternal;
  hakikishaInternal: typeof hakikishaInternal;
  helpers: typeof helpers;
  http: typeof http;
  invites: typeof invites;
  invitesInternal: typeof invitesInternal;
  invoices: typeof invoices;
  "lib/auth": typeof lib_auth;
  "lib/credit": typeof lib_credit;
  "lib/daraja": typeof lib_daraja;
  "lib/initiator": typeof lib_initiator;
  "lib/initiatorJobs": typeof lib_initiatorJobs;
  "lib/ledger": typeof lib_ledger;
  "lib/mpesaCrypto": typeof lib_mpesaCrypto;
  mpesa: typeof mpesa;
  mpesaInternal: typeof mpesaInternal;
  orgs: typeof orgs;
  payments: typeof payments;
  payouts: typeof payouts;
  payoutsInternal: typeof payoutsInternal;
  properties: typeof properties;
  ratiba: typeof ratiba;
  ratibaInternal: typeof ratibaInternal;
  reconcileInternal: typeof reconcileInternal;
  reports: typeof reports;
  seed: typeof seed;
  tenants: typeof tenants;
  verify: typeof verify;
  verifyInternal: typeof verifyInternal;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
