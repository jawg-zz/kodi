/**
 * STK result-code classification, shared by the poll action (mpesa.ts)
 * and the callback route (http.ts).
 *
 * The query endpoint returns transitional states ("still under
 * processing" etc.) while the prompt is alive on the handset — those
 * must stay pending so polling continues. Only documented terminal
 * codes flip the row. A false failure tells staff to resend a live
 * prompt (double-charge risk); a stuck-pending row resolves via callback
 * or the 30-minute sweep.
 */

export type StkOutcome = "success" | "cancelled" | "timeout" | "pending";

/** Map a Daraja ResultCode to its ledger outcome. Unknown → pending. */
export function classifyStkCode(code: string | number | undefined): StkOutcome {
  const c = String(code ?? "").trim();
  if (c === "0") return "success";
  if (c === "1031" || c === "1032") return "cancelled";
  if (c === "1037") return "timeout";
  return "pending";
}
