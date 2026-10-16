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

/** Dashboard: mark transactions stuck pending over 2h as failed. */
crons.interval(
  "expire stuck pendings",
  { minutes: 60 },
  internal.settlements.expireStuckPendings,
  {},
);

/** Dashboard: queue daily expected-settlement batch from success volume. */
crons.interval(
  "roll up settlement batch",
  { hours: 24 },
  internal.settlements.rollUpBatch,
  {},
);

export default crons;
