/**
 * Tip amount (+ optional k/m/b) + ticker anywhere in cast text.
 * Examples: "100 $RUG", "100k $RUG" (= 100_000), "2m $RUG", "1b $RUG".
 * Extra text around the tip is ignored. Ticker match is case-insensitive.
 */
export function parseTipText(
  text: string,
  expectedTicker: string,
): { amountRaw: string; ticker: string } | null {
  const expected = expectedTicker.toUpperCase();
  const re = /(\d+)([kKmMbB]?)\s+\$([A-Za-z0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const digits = m[1]!;
    const suffix = m[2]!;
    const ticker = m[3]!.toUpperCase();
    if (ticker !== expected) continue;

    const amountRaw = applyAmountSuffix(digits, suffix);
    if (amountRaw === null) continue;
    return { amountRaw, ticker };
  }
  return null;
}

/** Expand whole-token digits + optional k/m/b into a plain decimal string. */
export function applyAmountSuffix(digits: string, suffix: string): string | null {
  if (!/^\d+$/.test(digits)) return null;
  const mult =
    suffix === "k" || suffix === "K"
      ? 1000n
      : suffix === "m" || suffix === "M"
        ? 1_000_000n
        : suffix === "b" || suffix === "B"
          ? 1_000_000_000n
          : 1n;
  return (BigInt(digits) * mult).toString();
}

export function tipRegexForTicker(ticker: string): string {
  // Neynar RE2: (?i) makes amount suffix + ticker case-insensitive.
  // Substring match so casts with extra text still fire the webhook.
  const escaped = ticker.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?i)\\d+[kmb]?\\s+\\$${escaped}`;
}
