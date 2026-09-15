import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { MpesaTransaction } from "../lib/types";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Field, Input } from "./Field";
import { ErrorBanner, Loading } from "./ui";
import { formatKES, normalizeKenyanPhone } from "@kodi/shared";

type Phase = "form" | "waiting" | "done" | "error";

export function MpesaCollectModal({ orgId, tenantId, tenantName, defaultPhone, defaultAmount, onClose, onRecorded }: {
  orgId: string;
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
        } else if (polls >= 30) {
          clearInterval(timer);
          setPhase("error");
          setError("Still waiting for M-Pesa. You can close this and check Payments later — confirmed payments record automatically.");
        }
      } catch (e) {
        if (!alive) return;
        // Transient poll failures: keep waiting until attempts run out.
      }
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, checkoutId, onRecorded]);

  void orgId;

  const start = async () => {
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
    try {
      setPhase("waiting");
      const { data, error: fnError } = await supabase.functions.invoke("stk-initiate", {
        body: { tenantId, phone: normalized, amount: value },
      });
      if (fnError) throw new Error(fnError.message);
      setCheckoutId((data as { checkoutRequestId: string }).checkoutRequestId);
      setMessage(`A payment prompt for ${formatKES(value)} was sent to ${normalized}. Ask ${tenantName} to enter the M-Pesa PIN.`);
    } catch (e) {
      setPhase("form");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal title={`Collect via M-Pesa — ${tenantName}`} onClose={onClose}>
      {phase === "form" && (
        <div className="space-y-4">
          <Field label="Tenant phone (Safaricom)" required hint="The STK prompt goes to this number.">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678" inputMode="tel" />
          </Field>
          <Field label="Amount (KES)" required>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="15000" inputMode="numeric" />
          </Field>
          {error && <ErrorBanner message={error} />}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={start}>Send M-Pesa prompt</Button>
          </div>
        </div>
      )}
      {phase === "waiting" && (
        <div className="space-y-4">
          <Loading label="Waiting for the tenant to enter the M-Pesa PIN…" />
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
