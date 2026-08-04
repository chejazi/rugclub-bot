import type { Address, Hex } from "viem";
import type { Config } from "./config.js";
import {
  castHashToBytes32,
  isCastUsed,
  parseTipAmount,
  tipBatch,
  type ChainClients,
} from "./chain.js";
import {
  fetchCast,
  publishReply,
  tipperAddressFromAuthor,
  type CastPayload,
  type NeynarClient,
} from "./neynar.js";
import { parseTipText } from "./parse-tip.js";
import type { TipQueue, PendingTip } from "./queue.js";
import type { ResolveCache } from "./resolve-cache.js";
import { resolveAddress } from "./neynar.js";
import type { CycleState } from "./cycle.js";
import { allocationForAddress } from "./allocations.js";

export type EnqueueResult =
  | { ok: true; tip: PendingTip }
  | { ok: false; reason: string };

export async function buildTipFromCast(opts: {
  cast: CastPayload;
  cycle: CycleState;
  cfg: Config;
  clients: ChainClients;
  neynar: NeynarClient;
  cache: ResolveCache;
  ensLookup: (addr: Address) => Promise<string | null>;
}): Promise<EnqueueResult> {
  const { cast, cycle, cfg, clients, neynar, cache, ensLookup } = opts;

  if (!cast.parent_hash) {
    return { ok: false, reason: "not_a_reply" };
  }

  const parsed = parseTipText(cast.text, cycle.ticker);
  if (!parsed) {
    return { ok: false, reason: "parse_failed" };
  }

  const tipperFid = cast.author.fid;
  let tipperAddress = cycle.fidToTipper.get(tipperFid);
  if (!tipperAddress) {
    const fromAuthor = tipperAddressFromAuthor(cast.author);
    if (!fromAuthor) return { ok: false, reason: "tipper_no_address" };
    if (cfg.excludeAddresses.some((a) => a === fromAuthor.toLowerCase())) {
      return { ok: false, reason: "tipper_excluded" };
    }
    const eligible = [...cycle.fidToTipper.values()].some(
      (a) => a.toLowerCase() === fromAuthor.toLowerCase(),
    );
    if (!eligible) return { ok: false, reason: "tipper_not_eligible" };
    tipperAddress = fromAuthor;
  }

  const parentFid = cast.parent_author?.fid;
  if (parentFid == null) {
    return { ok: false, reason: "no_parent_author" };
  }
  if (parentFid === tipperFid) {
    return { ok: false, reason: "self_tip" };
  }

  const parentUserRes = await neynar.fetchBulkUsers({ fids: [parentFid] });
  const parentUsers =
    (parentUserRes as { users?: Array<{
      fid: number;
      username?: string;
      verifications?: string[];
      custody_address?: string;
    }> }).users ?? [];
  const parentUser = parentUsers[0];
  const recipientAddress =
    (parentUser?.verifications?.[0] as Address | undefined) ??
    (parentUser?.custody_address as Address | undefined);
  if (!recipientAddress) {
    return { ok: false, reason: "recipient_no_address" };
  }

  await resolveAddress(neynar, cache, tipperAddress, ensLookup);
  await resolveAddress(neynar, cache, recipientAddress, ensLookup);

  let amount: bigint;
  try {
    amount = parseTipAmount(parsed.amountRaw, cycle.decimals);
  } catch {
    return { ok: false, reason: "bad_amount" };
  }
  if (amount === 0n) return { ok: false, reason: "zero_amount" };

  const allocRow = await allocationForAddress({
    cfg,
    clients,
    neynar,
    cache,
    ensLookup,
    address: tipperAddress,
  });
  if (!allocRow || allocRow.excluded || BigInt(allocRow.allocation) === 0n) {
    return { ok: false, reason: "no_allocation" };
  }
  if (amount > BigInt(allocRow.remaining)) {
    return { ok: false, reason: "exceeds_remaining" };
  }

  const castHash = castHashToBytes32(cast.hash);
  if (await isCastUsed(clients.publicClient, cfg.tipDistributorAddress, castHash)) {
    return { ok: false, reason: "already_used" };
  }

  const tip: PendingTip = {
    castHash,
    tipper: tipperAddress,
    to: recipientAddress,
    amount: amount.toString(),
    allocation: allocRow.allocation,
    token: cycle.currentToken,
    ticker: cycle.ticker,
    decimals: cycle.decimals,
    parentHash: cast.parent_hash as Hex,
    tipperFid,
    recipientFid: parentFid,
    enqueuedAt: Date.now(),
  };

  return { ok: true, tip };
}

export async function enqueueFromCast(opts: {
  cast: CastPayload;
  cycle: CycleState;
  cfg: Config;
  clients: ChainClients;
  neynar: NeynarClient;
  cache: ResolveCache;
  queue: TipQueue;
  ensLookup: (addr: Address) => Promise<string | null>;
}): Promise<EnqueueResult> {
  const built = await buildTipFromCast(opts);
  if (!built.ok) return built;
  if (opts.queue.has(built.tip.castHash)) {
    return { ok: false, reason: "already_queued" };
  }
  opts.queue.enqueue(built.tip);
  return built;
}

export async function processQueueBatch(opts: {
  cfg: Config;
  clients: ChainClients;
  neynar: NeynarClient;
  queue: TipQueue;
  limit?: number;
}): Promise<void> {
  const { cfg, clients, neynar, queue, limit = 20 } = opts;
  const batch = queue.drain(limit);
  if (batch.length === 0) return;

  // Drop already-used casts
  const live: typeof batch = [];
  for (const tip of batch) {
    const used = await isCastUsed(
      clients.publicClient,
      cfg.tipDistributorAddress,
      tip.castHash,
    );
    if (used) {
      queue.remove(tip.castHash);
      continue;
    }
    live.push(tip);
  }
  if (live.length === 0) return;

  console.log(`[worker] tipping ${live.length} cast(s)`);
  try {
    const txHash = await tipBatch(clients, cfg.tipDistributorAddress, live);
    console.log(`[worker] tipBatch tx ${txHash}`);
    await clients.publicClient.waitForTransactionReceipt({ hash: txHash });

    for (const tip of live) {
      queue.remove(tip.castHash);
      if (cfg.neynarSignerUuid) {
        try {
          const username =
            (await resolveQuiet(neynar, tip.to)) ?? tip.to.slice(0, 10);
          await publishReply(
            neynar,
            cfg.neynarSignerUuid,
            `Tipped ${formatAmount(tip.amount, tip.decimals ?? 18)} $${tip.ticker} → ${username}`,
            tip.parentHash,
          );
        } catch (err) {
          console.error("[worker] confirmation reply failed", tip.castHash, err);
        }
      }
    }
  } catch (err) {
    console.error("[worker] tipBatch failed", err);
    // Leave tips in queue for retry
  }
}

async function resolveQuiet(neynar: NeynarClient, address: Address): Promise<string | null> {
  try {
    const res = await neynar.fetchBulkUsersByEthOrSolAddress({
      addresses: [address.toLowerCase()],
    });
    const map = res as unknown as Record<string, Array<{ username?: string }>>;
    const u = map[address.toLowerCase()]?.[0];
    return u?.username ? `@${u.username}` : null;
  } catch {
    return null;
  }
}

function formatAmount(weiStr: string, decimals: number): string {
  const n = BigInt(weiStr);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = n % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

export { fetchCast };
