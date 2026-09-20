/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as export_ from "../export.js";
import type * as helpers from "../helpers.js";
import type * as http from "../http.js";
import type * as invites from "../invites.js";
import type * as invitesInternal from "../invitesInternal.js";
import type * as invoices from "../invoices.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_mpesaCrypto from "../lib/mpesaCrypto.js";
import type * as mpesa from "../mpesa.js";
import type * as mpesaInternal from "../mpesaInternal.js";
import type * as orgs from "../orgs.js";
import type * as payments from "../payments.js";
import type * as properties from "../properties.js";
import type * as seed from "../seed.js";
import type * as tenants from "../tenants.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  crons: typeof crons;
  export: typeof export_;
  helpers: typeof helpers;
  http: typeof http;
  invites: typeof invites;
  invitesInternal: typeof invitesInternal;
  invoices: typeof invoices;
  "lib/auth": typeof lib_auth;
  "lib/mpesaCrypto": typeof lib_mpesaCrypto;
  mpesa: typeof mpesa;
  mpesaInternal: typeof mpesaInternal;
  orgs: typeof orgs;
  payments: typeof payments;
  properties: typeof properties;
  seed: typeof seed;
  tenants: typeof tenants;
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
