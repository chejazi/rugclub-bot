import type { Address } from "viem";
import type { Config } from "./config.js";
import {
  getCurrentToken,
  getPreviousToken,
  getRugUsers,
  getTokenMeta,
  type ChainClients,
} from "./chain.js";
import {
  resolveMany,
  upsertTipWebhook,
  type NeynarClient,
} from "./neynar.js";
import type { ResolveCache } from "./resolve-cache.js";
import type { TipQueue } from "./queue.js";

export type CycleState = {
  currentToken: Address;
  previousToken: Address;
  ticker: string;
  decimals: number;
  /** FID → tipper address (committed on previous token) */
  fidToTipper: Map<number, Address>;
  authorFids: number[];
};

export async function refreshCycle(opts: {
  cfg: Config;
  clients: ChainClients;
  neynar: NeynarClient;
  cache: ResolveCache;
  queue: TipQueue;
  prev: CycleState | null;
  ensLookup: (addr: Address) => Promise<string | null>;
}): Promise<CycleState> {
  const { cfg, clients, neynar, cache, queue, prev, ensLookup } = opts;
  const currentToken = await getCurrentToken(clients.publicClient, cfg.protocolAddress);
  const previousToken = await getPreviousToken(clients.publicClient, cfg.protocolAddress);
  const { symbol, decimals } = await getTokenMeta(clients.publicClient, currentToken);
  const ticker = symbol.toUpperCase();

  if (prev && prev.currentToken.toLowerCase() === currentToken.toLowerCase()) {
    return prev;
  }

  if (prev) {
    queue.removeToken(prev.currentToken);
    console.log(`[cycle] token rotated ${prev.ticker} → ${ticker}`);
  } else {
    console.log(`[cycle] initial token ${ticker} (${currentToken})`);
  }

  const users =
    previousToken === "0x0000000000000000000000000000000000000000"
      ? []
      : await getRugUsers(clients.publicClient, cfg.protocolAddress, previousToken);

  const resolved = await resolveMany(neynar, cache, users, ensLookup);
  const exclude = new Set(cfg.excludeAddresses.map((a) => a.toLowerCase()));
  const fidToTipper = new Map<number, Address>();
  const authorFids: number[] = [];
  for (const r of resolved) {
    if (r.fid == null) continue;
    if (exclude.has(r.address.toLowerCase())) continue;
    fidToTipper.set(r.fid, r.address);
    authorFids.push(r.fid);
  }

  if (cfg.neynarWebhookId && cfg.neynarWebhookTargetUrl) {
    if (authorFids.length === 0) {
      console.warn("[cycle] no Farcaster committers — skipping webhook update");
    } else {
      try {
        await upsertTipWebhook({
          client: neynar,
          webhookId: cfg.neynarWebhookId,
          targetUrl: cfg.neynarWebhookTargetUrl,
          authorFids,
          ticker,
          env: cfg.env,
        });
        console.log(
          `[cycle] webhook updated: ${authorFids.length} fid(s), ticker $${ticker}`,
        );
      } catch (err) {
        console.error("[cycle] webhook update failed", err);
      }
    }
  } else {
    console.warn(
      "[cycle] NEYNAR_WEBHOOK_ID / NEYNAR_WEBHOOK_TARGET_URL unset — skip webhook upsert",
    );
  }

  return {
    currentToken,
    previousToken,
    ticker,
    decimals,
    fidToTipper,
    authorFids,
  };
}
