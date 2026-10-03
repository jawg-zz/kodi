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

/**
 * Nightly auto-forward sweep: settled-after-hold platform collections go
 * to each landlord's registered rail, net of the platform fee. Idempotent
 * per row (settledAt claim) and failure-tolerant (alert + retry tomorrow).
 */
crons.daily(
  "auto-forward platform collections",
  { hourUTC: 1, minuteUTC: 0 },
  internal.forwarder.sweepForward,
  {},
);

export default crons;
