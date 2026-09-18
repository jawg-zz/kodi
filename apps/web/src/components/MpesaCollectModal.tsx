import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { listTenantMpesaAttempts } from "../lib/api";
import type { MpesaTransaction } from "../lib/types";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Field, Input } from "./Field";
import { ErrorBanner, Loading } from "./ui";
import { formatKES, normalizeKenyanPhone } from "@kodi/shared";

type Phase = "form" | "sending" | "waiting" | "done" | "error";

/** PIN prompts expire after ~60s on the handset; count down so staff know. */
const PIN_TIMEOUT_SECS = 60;
/** Poll every 3s for up to 3 minutes before suggesting to close. */
const MAX_POLLS = 60;

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
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(PIN_TIMEOUT_SECS);
  const [attempts, setAttempts] = useState<MpesaTransaction[]>([]);
  const sendingRef = useRef(false);

  useEffect(() => {
    void listTenantMpesaAttempts(tenantId).then(setAttempts).catch(() => {});
  }, [tenantId]);

  useEffect(() => {
    if (phase !== "waiting") return;
    const countdown = setInterval(
      () => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)),
      1000
    );
    return () => clearInterval(countdown);
  }, [phase, checkoutId]);

  useEffect(() => {
    if (phase !== "waiting" || !checkoutId) return;
    let alive = true;
    let polls = 0;
    const timer = setInterval(async () => {
      polls += 1;
      try {
        const { data, error: fnError } = await supabase.functions.invoke("stk-status", {
          body: { checkoutRequestId: checkoutId },
        });
        if (!alive) return;
        if (fnError) throw new Error(fnError.message);
        const tx = data as MpesaTransaction;
        if (tx.status === "success") {
          clearInterval(timer);
          setPhase("done");
          setMessage(
            tx.mpesa_receipt
              ? `Payment of ${formatKES(tx.amount)} confirmed (M-Pesa ${tx.mpesa_receipt}).`
              : `Payment of ${formatKES(tx.amount)} confirmed.`
          );
          onRecorded();
        } else if (tx.status === "failed" || tx.status === "timeout") {
          clearInterval(timer);
          setPhase("error");
          setError(
            tx.result_desc ||
              (tx.status === "timeout" ? "The request timed out. Ask the tenant to try again." : "The payment did not go through.")
          );
        } else if (polls >= MAX_POLLS) {
          clearInterval(timer);
          setPhase("error");
          setError("Still waiting for M-Pesa. You can close this and check Payments later — confirmed payments record automatically.");
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
  }, [phase, checkoutId, onRecorded]);

  const start = async () => {
    if (sendingRef.current) return; // double-tap guard
    setError(null);
    const normalized = normalizeKenyanPhone(phone);
    if (!normalized) {
      setError("Enter a valid Safaricom number, e.g. 0712 345 678.");
      return;
    }
    const value = Math.round(Number(amount));
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
      const { data, error: fnError } = await supabase.functions.invoke("stk-initiate", {
        body: {
          tenantId,
          phone: normalized,
          amount: value,
          idempotencyKey: idempotencyKey(tenantId, normalized, value),
        },
      });
      if (fnError) throw new Error(fnError.message);
      const res = data as { checkoutRequestId: string; deduplicated?: boolean };
      setCheckoutId(res.checkoutRequestId);
      setSecondsLeft(PIN_TIMEOUT_SECS);
      setPhase("waiting");
      setMessage(
        `${res.deduplicated ? "A prompt for this payment was already sent — reusing it. " : ""}` +
        `A payment prompt for ${formatKES(value)} was sent to ${normalized}. Ask ${tenantName} to enter the M-Pesa PIN.`
      );
    } catch (e) {
      setPhase("form");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      sendingRef.current = false;
    }
  };

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
          {error && <ErrorBanner message={error} />}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={start} disabled={phase === "sending"}>
              {phase === "sending" ? "Sending…" : "Send M-Pesa prompt"}
            </Button>
          </div>
          {attempts.length > 0 && (
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              <p className="mb-1 font-semibold">Recent attempts</p>
              <ul className="space-y-1">
                {attempts.slice(0, 5).map((a) => (
                  <li key={a.id} className="flex justify-between">
                    <span>{formatKES(a.amount)} · {STATUS_LABEL[a.status] ?? a.status}</span>
                    <span>{new Date(a.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {phase === "waiting" && (
        <div className="space-y-4">
          <Loading label={`Waiting for the tenant to enter the M-Pesa PIN… (${secondsLeft}s)`} />
          {message && <p className="text-sm text-slate-600">{message}</p>}
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>Close (payment records automatically)</Button>
          </div>
        </div>
      )}
      {phase === "done" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            {message}
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
      {phase === "error" && <ErrorBanner message={error ?? "Payment failed."} />}
      {phase === "error" && (
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button onClick={() => { setPhase("form"); setError(null); }}>Try again</Button>
        </div>
      )}
    </Modal>
  );
}
