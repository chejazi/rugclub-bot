/**
 * Exact tip reply: whole-number amount (+ optional k/m/b) + ticker.
 * Examples: "100 $RUG", "100k $RUG" (= 100_000), "2m $RUG", "1b $RUG".
 * Ticker match is case-insensitive ($rug ≡ $RUG).
 */
export function parseTipText(
  text: string,
  expectedTicker: string,
): { amountRaw: string; ticker: string } | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^(\d+)([kKmMbB]?)\s+\$([A-Za-z0-9]+)$/i);
  if (!m) return null;
  const digits = m[1]!;
  const suffix = m[2]!;
  const ticker = m[3]!;
  if (ticker.toUpperCase() !== expectedTicker.toUpperCase()) return null;

  const amountRaw = applyAmountSuffix(digits, suffix);
  if (amountRaw === null) return null;
  return { amountRaw, ticker: ticker.toUpperCase() };
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
  // Docs: write (?i)\\$ticker in API JSON — in a JS string that is (?i)\\\\$ticker.
  const escaped = ticker.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?i)^\\s*\\d+[kmb]?\\s+\\$${escaped}\\s*$`;
}
