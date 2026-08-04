import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const botRoot = path.resolve(__dirname, "..");
loadEnv({ path: path.join(botRoot, ".env") });

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function parseAddressList(raw: string): `0x${string}`[] {
  if (!raw.trim()) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^0x[a-fA-F0-9]{40}$/.test(s))
    .map((s) => s.toLowerCase() as `0x${string}`);
}

export const config = {
  port: Number(optional("PORT", "8787")),
  baseRpcUrl: required("BASE_RPC_URL"),
  protocolAddress: required("PROTOCOL_ADDRESS") as `0x${string}`,
  tipDistributorAddress: required("TIP_DISTRIBUTOR_ADDRESS") as `0x${string}`,
  tipOperatorKey: required("TIP_OPERATOR_KEY") as `0x${string}`,
  neynarApiKey: required("NEYNAR_API_KEY"),
  neynarWebhookSecret: optional("NEYNAR_WEBHOOK_SECRET"),
  neynarSignerUuid: optional("NEYNAR_SIGNER_UUID"),
  neynarWebhookId: optional("NEYNAR_WEBHOOK_ID"),
  neynarWebhookTargetUrl: optional("NEYNAR_WEBHOOK_TARGET_URL"),
  replaySecret: optional("TIP_BOT_REPLAY_SECRET"),
  queuePath: path.resolve(botRoot, optional("QUEUE_PATH", "./data/queue.json")),
  resolveCachePath: path.resolve(
    botRoot,
    optional("RESOLVE_CACHE_PATH", "./data/resolve-cache.json"),
  ),
  tipIntervalMs: Number(optional("TIP_INTERVAL_MS", "30000")),
  /** Lowercase addresses excluded from tip weight / eligibility (comma or whitespace separated). */
  excludeAddresses: parseAddressList(optional("TIP_EXCLUDE_ADDRESSES")),
  /** DEV or PROD — used in Neynar webhook display name. */
  env: (() => {
    const raw = optional("TIP_BOT_ENV", optional("NODE_ENV", "development")).toUpperCase();
    if (raw === "PROD" || raw === "PRODUCTION") return "PROD" as const;
    return "DEV" as const;
  })(),
};

export type Config = typeof config;
