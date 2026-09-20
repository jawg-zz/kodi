/* eslint-disable */
/**
 * TEMPORARY SHIM — see api.js. Overwritten by `npx convex dev` codegen.
 */
import type { GenericId } from "convex/values";

export type Id<TableName extends string> = GenericId<TableName>;
export type Doc<TableName extends string> = Record<string, unknown> & {
  _id: GenericId<TableName>;
  _creationTime: number;
};
