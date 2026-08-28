import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Neynar webhook HMAC-SHA512 signature over the raw request body.
 * @see https://docs.neynar.com/docs/how-to-verify-the-incoming-webhooks-using-signatures
 */
export function verifyNeynarWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  webhookSecret: string,
): boolean {
  if (!signatureHeader || !webhookSecret) return false;

  const hmac = createHmac("sha512", webhookSecret);
  hmac.update(rawBody);
  const computed = hmac.digest("hex");

  try {
    const sigBuf = Buffer.from(signatureHeader, "hex");
    const computedBuf = Buffer.from(computed, "hex");
    if (sigBuf.length !== computedBuf.length) return false;
    return timingSafeEqual(sigBuf, computedBuf);
  } catch {
    return false;
  }
}
