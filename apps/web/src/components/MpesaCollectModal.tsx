import { useEffect, useRef, useState } from "react";
import { listTenantMpesaAttempts, previewAllocation, stkInitiate, stkStatus } from "../lib/api";
import type { AllocationPreview, MpesaTransaction } from "../lib/types";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Field, Input } from "./Field";
import { Badge, ErrorBanner } from "./ui";
import { formatKES, normalizeKenyanPhone } from "@kodi/shared";

type Phase = "form" | "sending" | "waiting" | "done" | "error";

/** PIN prompts expire after ~60s on the handset; count down so staff know. */
const PIN_TIMEOUT_SECS = 60;
/** Poll every 3s for up to 3 minutes before suggesting to close. */
const MAX_POLLS = 60;
/** Daraja locks the subscriber briefly after a push — resends wait this long. */
const RESEND_COOLDOWN_SECS = 60;

function idempotencyKey(tenantId: string, phone: string, amount: number): string {
  const bucket = Math.floor(Date.now() / 120_000); // 2-minute window
  let h = 0;
  const s = `${tenantId}|${phone}|${amount}|${bucket}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `stk-${(h >>> 0).toString(16)}`;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for PIN",
  success: "Paid",
  failed: "Failed",
  timeout: "Expired",
};

type WaitStep = "sent" | "pin" | "confirming";

type FailureKind =
  | { kind: "cancelled" }
  | { kind: "unreachable" }
  | { kind: "timeout" }
  | { kind: "failed"; desc: string | null };

function classifyFailure(tx: MpesaTransaction): FailureKind {
  if (tx.status === "timeout") return { kind: "timeout" };
  const code = tx.result_code;
  if (code === 1032 || code === 1031) return { kind: "cancelled" };
  if (code === 1037) return { kind: "unreachable" };
  return { kind: "failed", desc: tx.result_desc };
}

const FAILURE_COPY: Record<FailureKind["kind"], { title: string; body: string; next: string }> = {
  cancelled: {
    title: "Tenant cancelled the prompt",
    body: "They pressed Cancel (or let it ring out) on their phone. No money moved.",
    next: "Confirm with them first, then resend — or record a manual payment if they paid another way.",
  },
  unreachable: {
    title: "Phone unreachable",
    body: "The prompt never reached the handset — off, no signal, or wrong number.",
    next: "Verify the number with the tenant, wait a minute, then resend.",
  },
  timeout: {
    title: "No confirmation in 3 minutes",
    body: "The prompt expired without an answer. Late confirmations still record automatically if the tenant pays.",
    next: "Check Payments before resending — the money may still land.",
  },
  failed: {
    title: "Payment failed",
    body: "Daraja rejected the prompt or the handset errored.",
    next: "Check the reason below. You can resend after the cooldown, or record manually.",
  },
};

export function MpesaCollectModal({ tenantId, tenantName, defaultPhone, defaultAmount, onClose, onRecorded }: {
  tenantId: string;
  tenantName: string;
  defaultPhone: string;
  defaultAmount: number;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [phone, setPhone] = useState(defaultPhone);
  const [amount, setAmount] = useState(String(defaultAmount || ""));
  const [phase, setPhase] = useState<Phase>("form");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(PIN_TIMEOUT_SECS);
  const [step, setStep] = useState<WaitStep>("sent");
  const [polls, setPolls] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const [attempts, setAttempts] = useState<MpesaTransaction[]>([]);
  const [preview, setPreview] = useState<AllocationPreview | null>(null);
  const sendingRef = useRef(false);

  const refreshAttempts = () => {
    void listTenantMpesaAttempts(tenantId).then(setAttempts).catch(() => {});
  };

  useEffect(() => {
    refreshAttempts();
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live FIFO preview under the amount: what this push would settle.
  useEffect(() => {
    const value = Math.round(Number(amount));
    if (!Number.isFinite(value) || value < 1) {
      setPreview(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      previewAllocation(tenantId, value)
        .then((p) => { if (alive) setPreview(p); })
        .catch(() => { if (alive) setPreview(null); });
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [amount, tenantId]);

  useEffect(() => {
    if (phase !== "waiting") return;
    const countdown = setInterval(
      () => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)),
      1000
    );
    return () => clearInterval(countdown);
  }, [phase, checkoutId]);

  // Resend cooldown ticks down on form + error phases.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => {
    if (phase !== "waiting" || !checkoutId) return;
    let alive = true;
    let n = 0;
    const timer = setInterval(async () => {
      n += 1;
      setPolls(n);
      // Step the timeline: PIN window first, then confirming.
      if (n === 4) setStep("pin");
      if (n === 12) setStep("confirming");
      try {
        const tx = await stkStatus(checkoutId);
        if (!alive) return;
        if (tx.status === "success") {
          clearInterval(timer);
          setPhase("done");
          setMessage(
            tx.mpesa_receipt
              ? `Payment of ${formatKES(tx.amount)} confirmed (M-Pesa ${tx.mpesa_receipt}).`
              : `Payment of ${formatKES(tx.amount)} confirmed.`
          );
          onRecorded();
          refreshAttempts();
        } else if (tx.status === "failed" || tx.status === "timeout") {
          clearInterval(timer);
          setPhase("error");
          setFailure(classifyFailure(tx));
          setCooldown(RESEND_COOLDOWN_SECS);
          refreshAttempts();
        } else if (n >= MAX_POLLS) {
          clearInterval(timer);
          setPhase("error");
          setFailure({ kind: "timeout" });
          setCooldown(RESEND_COOLDOWN_SECS);
        }
      } catch {
        if (!alive) return;
        // Transient poll failures: keep waiting until attempts run out.
      }
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, checkoutId, onRecorded]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (retryPhone?: string, retryAmount?: number) => {
    if (sendingRef.current) return; // double-tap guard
    setError(null);
    setFailure(null);
    const rawPhone = retryPhone ?? phone;
    const rawAmount = retryAmount ?? amount;
    const normalized = normalizeKenyanPhone(rawPhone);
    if (!normalized) {
      setError("Enter a valid Safaricom number, e.g. 0712 345 678.");
      return;
    }
    const value = Math.round(Number(rawAmount));
    if (!Number.isFinite(value) || value < 1) {
      setError("Enter a valid amount in KES.");
      return;
    }
    if (value > 500000) {
      setError("Amounts above KES 500,000 need to be split into smaller pushes.");
      return;
    }
    sendingRef.current = true;
    try {
      setPhase("sending");
      const res = await stkInitiate({
        tenantId,
        phone: normalized,
        amount: value,
        idempotencyKey: idempotencyKey(tenantId, normalized, value),
      });
      setCheckoutId(res.checkoutRequestId);
      setSecondsLeft(PIN_TIMEOUT_SECS);
      setStep("sent");
      setPolls(0);
      setPhase("waiting");
      setMessage(
        `${res.deduplicated ? "A prompt for this payment was already sent — reusing it. " : ""}` +
        `A payment prompt for ${formatKES(value)} was sent to ${normalized}. Ask ${tenantName} to enter the M-Pesa PIN.`
      );
      refreshAttempts();
    } catch (e) {
      setPhase("form");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      sendingRef.current = false;
    }
  };

  const retryFromHistory = (a: MpesaTransaction) => {
    setPhone(a.phone);
    setAmount(String(a.amount));
    setPhase("form");
    setError(null);
    setFailure(null);
  };

  const failedCopy = failure ? FAILURE_COPY[failure.kind] : null;

  return (
    <Modal title={`Collect via M-Pesa — ${tenantName}`} onClose={onClose}>
      {(phase === "form" || phase === "sending") && (
        <div className="space-y-4">
          <Field label="Tenant phone (Safaricom)" required hint="The STK prompt goes to this number.">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678" inputMode="tel" disabled={phase === "sending"} />
          </Field>
          <Field label="Amount (KES)" required>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="15000" inputMode="numeric" disabled={phase === "sending"} />
          </Field>
          {preview && preview.allocations.length > 0 && (() => {
            const applied = preview.allocations.reduce((s, a) => s + a.applied, 0);
            const total = preview.allocations.reduce((s, a) => s + a.balance, 0);
            return (
              <p className="text-xs text-slate-500">
                Would settle {formatKES(applied)} of {formatKES(total)} open
                {preview.leftover > 0 && <>, {formatKES(preview.leftover)} kept as credit</>}.
              </p>
            );
          })()}
          {error && <ErrorBanner message={error} />}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="mpesa" onClick={() => start()} disabled={phase === "sending"}>
              {phase === "sending" ? "Sending…" : "Send M-Pesa prompt"}
            </Button>
          </div>
          {attempts.length > 0 && (
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              <p className="mb-1 font-semibold">Recent attempts</p>
              <ul className="space-y-1">
                {attempts.slice(0, 5).map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2">
                    <span>
                      {formatKES(a.amount)}, {STATUS_LABEL[a.status] ?? a.status}
                      {a.status === "success" && /late success/i.test(a.result_desc ?? "") && (
                        <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800" title="The money arrived after the prompt had already expired — it still recorded correctly.">
                          late
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      <span>{new Date(a.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                      {(a.status === "failed" || a.status === "timeout") && (
                        <button
                          type="button"
                          onClick={() => retryFromHistory(a)}
                          className="font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 hover:no-underline"
                          title="Refill the form with this phone + amount"
                        >
                          Retry
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {phase === "waiting" && (
        <div className="space-y-4">
          <WaitTimeline step={step} polls={polls} secondsLeft={secondsLeft} />
          {message && <p className="text-sm text-slate-600">{message}</p>}
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>Close (payment records automatically)</Button>
          </div>
        </div>
      )}
      {phase === "done" && (
        <div className="space-y-4">
          <div className="print-ink rounded-lg border border-brand-100 bg-brand-50 p-4 text-sm font-medium text-brand-700">
            {message}
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
      {phase === "error" && failedCopy && (
        <div className="space-y-4">
          <div className={`rounded-lg border p-4 text-sm ${
            failure?.kind === "cancelled"
              ? "border-slate-200 bg-slate-50 text-slate-700"
              : failure?.kind === "timeout"
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-red-200 bg-red-50 text-red-800"
          }`}>
            <p className="font-semibold">{failedCopy.title}</p>
            <p className="mt-1">{failedCopy.body}</p>
            {failure?.kind === "failed" && failure.desc && (
              <p className="mt-1 font-mono text-xs opacity-80">{failure.desc}</p>
            )}
            <p className="mt-2 font-medium">{failedCopy.next}</p>
          </div>
          {error && <ErrorBanner message={error} />}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            <Button
              onClick={() => { setPhase("form"); setError(null); setFailure(null); }}
              disabled={cooldown > 0}
              title={cooldown > 0 ? `Wait ${cooldown}s — Daraja locks the line briefly after a push` : undefined}
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : "Send again"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function WaitTimeline({ step, polls, secondsLeft }: {
  step: WaitStep;
  polls: number;
  secondsLeft: number;
}) {
  const steps: { key: WaitStep; label: string; hint: string }[] = [
    { key: "sent", label: "Prompt sent", hint: "Delivered to the handset" },
    { key: "pin", label: "PIN entry", hint: secondsLeft > 0 ? `Tenant entering PIN (~${secondsLeft}s left)` : "PIN window elapsed — still confirming" },
    { key: "confirming", label: "Confirming", hint: "Checking with M-Pesa…" },
  ];
  const order: WaitStep[] = ["sent", "pin", "confirming"];
  const activeIdx = order.indexOf(step);
  return (
    <div>
      <ol className="space-y-2">
        {steps.map((s, i) => {
          const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "todo";
          return (
            <li key={s.key} className="flex items-start gap-3 text-sm">
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                state === "done"
                  ? "bg-brand-100 text-brand-700"
                  : state === "active"
                    ? "bg-brand-600 text-white"
                    : "bg-slate-100 text-slate-400"
              }`}>
                {state === "done" ? "✓" : i + 1}
              </span>
              <span>
                <span className={`font-medium ${state === "todo" ? "text-slate-400" : "text-slate-800"}`}>
                  {s.label}
                </span>
                {state === "active" && (
                  <span className="ml-2 text-xs text-slate-500">{s.hint}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-xs text-slate-400">
        Checked {polls}× — closes automatically on confirm. Late payments still record.
      </p>
    </div>
  );
}

export function PendingTxBadge({ status }: { status: string }) {
  return <Badge tone={status === "pending" ? "amber" : status === "success" ? "green" : "red"}>{STATUS_LABEL[status] ?? status}</Badge>;
}
