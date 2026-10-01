/**
 * Share helpers for the invoice QR: native share sheet (WhatsApp appears
 * in it on phones) with graceful fallbacks — PNG download + a wa.me text
 * link — for desktops and older mobile browsers.
 */

export function base64ToBlob(base64: string, mime = "image/png"): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export type ShareResult = "shared" | "unsupported" | "failed";

/**
 * Share the QR PNG through the OS share sheet. "unsupported" means the
 * browser can't share files — the caller should reveal the fallback row.
 * A user-cancelled sheet counts as shared (nothing for the caller to do).
 */
export async function shareQrImage(args: {
  qrBase64: string;
  fileName: string;
  title: string;
  text: string;
}): Promise<ShareResult> {
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (nav.share === undefined) return "unsupported";
  try {
    const file = new File([base64ToBlob(args.qrBase64)], args.fileName, {
      type: "image/png",
    });
    const payload = { title: args.title, text: args.text, files: [file] };
    if (nav.canShare !== undefined && !nav.canShare(payload)) {
      return "unsupported";
    }
    await nav.share(payload);
    return "shared";
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "shared";
    return "failed";
  }
}

export function downloadQr(qrBase64: string, fileName: string): void {
  const url = URL.createObjectURL(base64ToBlob(qrBase64));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function whatsappTextLink(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
