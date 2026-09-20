/* eslint-disable */
/**
 * TEMPORARY SHIM — see api.js. Overwritten by `npx convex dev` codegen.
 * Re-exports the standard Convex server bindings.
 */
export {
  query,
  mutation,
  action,
  internalQuery,
  internalMutation,
  internalAction,
  httpAction,
  httpRouter,
} from "convex/server";
export type {
  QueryCtx,
  MutationCtx,
  ActionCtx,
  HttpRouter,
} from "convex/server";
