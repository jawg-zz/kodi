import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/** Sweep stale pending M-Pesa rows every 30 minutes. */
crons.interval(
  "expire pending mpesa transactions",
  { minutes: 30 },
  internal.mpesaInternal.expirePending,
  {},
);

export default crons;
