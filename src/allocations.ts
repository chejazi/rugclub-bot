import type { Address } from "viem";
import type { Config } from "./config.js";
import type { ChainClients } from "./chain.js";
import {
  floorToWholeTokens,
  getCurrentToken,
  getPreviousToken,
  getRugUsers,
  getTipPool,
  getTipped,
  getTokenMeta,
  getUserCommittedTokens,
  getUserStreak,
} from "./chain.js";
import { resolveAddress, type NeynarClient } from "./neynar.js";
import type { ResolveCache } from "./resolve-cache.js";

export type AllocationRow = {
  address: Address;
  ens: string | null;
  username: string | null;
  fid: number | null;
  committed: string;
  streak: string;
  weight: string;
  allocation: string;
  tipped: string;
  remaining: string;
  excluded: boolean;
};

export type AllocationsSnapshot = {
  token: Address;
  previousToken: Address;
  tipPool: string;
  totalWeight: string;
  decimals: number;
  exclude: Address[];
  allocations: AllocationRow[];
};

/** Vote-weight style: committed × streak (streak 0 → 1). */
export function voteWeight(committed: bigint, streak: bigint): bigint {
  if (committed === 0n) return 0n;
  const s = streak === 0n ? 1n : streak;
  return committed * s;
}

export async function computeAllocations(opts: {
  cfg: Config;
  clients: ChainClients;
  neynar: NeynarClient;
  cache: ResolveCache;
  ensLookup: (addr: Address) => Promise<string | null>;
  /** If set, only include this address in the response (still computed against full pool). */
  filterAddress?: Address;
}): Promise<AllocationsSnapshot> {
  const { cfg, clients, neynar, cache, ensLookup, filterAddress } = opts;
  const exclude = new Set(cfg.excludeAddresses.map((a) => a.toLowerCase()));

  const token = await getCurrentToken(clients.publicClient, cfg.protocolAddress);
  const previousToken = await getPreviousToken(
    clients.publicClient,
    cfg.protocolAddress,
  );
  const { decimals } = await getTokenMeta(clients.publicClient, token);
  const tipPoolRaw = await getTipPool(
    clients.publicClient,
    cfg.tipDistributorAddress,
    token,
  );
  // Distributable pool is whole tokens only (floor dust).
  const tipPool = floorToWholeTokens(tipPoolRaw, decimals);

  const users =
    previousToken === "0x0000000000000000000000000000000000000000"
      ? []
      : await getRugUsers(clients.publicClient, cfg.protocolAddress, previousToken);

  type Raw = {
    address: Address;
    committed: bigint;
    streak: bigint;
    weight: bigint;
    excluded: boolean;
  };

  const raw: Raw[] = [];
  for (const address of users) {
    const committed = await getUserCommittedTokens(
      clients.publicClient,
      cfg.protocolAddress,
      address,
      previousToken,
    );
    const streak = await getUserStreak(
      clients.publicClient,
      cfg.protocolAddress,
      address,
    );
    const excluded = exclude.has(address.toLowerCase());
    const weight = excluded ? 0n : voteWeight(committed, streak);
    raw.push({ address, committed, streak, weight, excluded });
  }

  const totalWeight = raw.reduce((acc, r) => acc + r.weight, 0n);

  const rows: AllocationRow[] = [];
  for (const r of raw) {
    if (filterAddress && r.address.toLowerCase() !== filterAddress.toLowerCase()) {
      continue;
    }

    const rawAllocation =
      !r.excluded && totalWeight > 0n && tipPool > 0n
        ? (tipPool * r.weight) / totalWeight
        : 0n;
    const allocation = floorToWholeTokens(rawAllocation, decimals);
    const tipped = await getTipped(
      clients.publicClient,
      cfg.tipDistributorAddress,
      token,
      r.address,
    );
    const tippedWhole = floorToWholeTokens(tipped, decimals);
    const remaining = allocation > tippedWhole ? allocation - tippedWhole : 0n;

    const resolved = await resolveAddress(neynar, cache, r.address, ensLookup);

    rows.push({
      address: r.address,
      ens: resolved.ens,
      username: resolved.username,
      fid: resolved.fid,
      committed: r.committed.toString(),
      streak: r.streak.toString(),
      weight: r.weight.toString(),
      allocation: allocation.toString(),
      tipped: tippedWhole.toString(),
      remaining: remaining.toString(),
      excluded: r.excluded,
    });
  }

  return {
    token,
    previousToken,
    tipPool: tipPool.toString(),
    totalWeight: totalWeight.toString(),
    decimals,
    exclude: cfg.excludeAddresses,
    allocations: rows,
  };
}

export async function allocationForAddress(opts: {
  cfg: Config;
  clients: ChainClients;
  neynar: NeynarClient;
  cache: ResolveCache;
  ensLookup: (addr: Address) => Promise<string | null>;
  address: Address;
}): Promise<AllocationRow | null> {
  const snap = await computeAllocations({ ...opts, filterAddress: opts.address });
  return snap.allocations[0] ?? null;
}
