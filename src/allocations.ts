import type { Address } from "viem";
import type { Config } from "./config.js";
import type { ChainClients } from "./chain.js";
import {
  floorToWholeTokens,
  getRugUsers,
} from "./chain.js";
import { resolveMany, type NeynarClient } from "./neynar.js";
import type { ResolveCache } from "./resolve-cache.js";
import tipDistributorAbi from "./abis/tip-distributor.json" with { type: "json" };
import protocolAbi from "./abis/protocol.json" with { type: "json" };
import erc20Abi from "./abis/erc20.json" with { type: "json" };

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

/** Keep multicalls small enough to avoid RPC payload / compute spikes. */
const MULTICALL_CHUNK = 120;
/** Fresh enough for the Tip tab; avoids re-hitting Alchemy on every refetch. */
const SNAPSHOT_TTL_MS = 12_000;

type SnapshotCache = {
  at: number;
  snap: AllocationsSnapshot;
};

let snapshotCache: SnapshotCache | null = null;
let snapshotInflight: Promise<AllocationsSnapshot> | null = null;

export function invalidateAllocationsCache(): void {
  snapshotCache = null;
}

/** Vote-weight style: committed × streak (streak 0 → 1). */
export function voteWeight(committed: bigint, streak: bigint): bigint {
  if (committed === 0n) return 0n;
  const s = streak === 0n ? 1n : streak;
  return committed * s;
}

type MulticallContract = {
  address: Address;
  abi: readonly unknown[] | unknown[];
  functionName: string;
  args?: readonly unknown[];
};

async function multicallChunked(
  client: ChainClients["publicClient"],
  contracts: MulticallContract[],
): Promise<
  Array<{ status: "success"; result: unknown } | { status: "failure"; error?: Error }>
> {
  const out: Array<
    { status: "success"; result: unknown } | { status: "failure"; error?: Error }
  > = [];
  for (let i = 0; i < contracts.length; i += MULTICALL_CHUNK) {
    const chunk = contracts.slice(i, i + MULTICALL_CHUNK);
    // Sequential chunks → few HTTP requests, no request stampede.
    const results = await client.multicall({
      allowFailure: true,
      contracts: chunk as Parameters<typeof client.multicall>[0]["contracts"],
    });
    out.push(...results);
  }
  return out;
}

function readBigInt(
  result:
    | { status: "success"; result: unknown }
    | { status: "failure"; error?: Error }
    | undefined,
  fallback = 0n,
): bigint {
  if (!result || result.status !== "success") return fallback;
  return result.result as bigint;
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
  const client = clients.publicClient;
  const protocol = cfg.protocolAddress;
  const tipDistributor = cfg.tipDistributorAddress;

  const tokenHeader = await client.multicall({
    allowFailure: false,
    contracts: [
      {
        address: protocol,
        abi: protocolAbi,
        functionName: "getCurrentToken",
      },
      {
        address: protocol,
        abi: protocolAbi,
        functionName: "getPreviousToken",
      },
    ],
  });
  const token = tokenHeader[0] as Address;
  const previousToken = tokenHeader[1] as Address;

  const poolHeader = await client.multicall({
    allowFailure: false,
    contracts: [
      {
        address: token,
        abi: erc20Abi,
        functionName: "decimals",
      },
      {
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [tipDistributor],
      },
      {
        address: tipDistributor,
        abi: tipDistributorAbi,
        functionName: "totalTipped",
        args: [token],
      },
    ],
  });
  const decimals = Number(poolHeader[0]);
  const tipPoolRaw = (poolHeader[1] as bigint) + (poolHeader[2] as bigint);
  // Distributable pool is whole tokens only (floor dust).
  const tipPool = floorToWholeTokens(tipPoolRaw, decimals);

  const users =
    previousToken === "0x0000000000000000000000000000000000000000"
      ? []
      : await getRugUsers(client, protocol, previousToken);

  // Per user: committed + streak + tipped — chunked multicall (not N parallel HTTP).
  const userContracts: MulticallContract[] = [];
  for (const address of users) {
    userContracts.push(
      {
        address: protocol,
        abi: protocolAbi,
        functionName: "getUserCommittedTokens",
        args: [address, previousToken],
      },
      {
        address: protocol,
        abi: protocolAbi,
        functionName: "getUserStreak",
        args: [address],
      },
      {
        address: tipDistributor,
        abi: tipDistributorAbi,
        functionName: "tipped",
        args: [token, address],
      },
    );
  }
  const userResults = await multicallChunked(client, userContracts);

  type Raw = {
    address: Address;
    committed: bigint;
    streak: bigint;
    weight: bigint;
    tipped: bigint;
    excluded: boolean;
  };

  const raw: Raw[] = users.map((address, i) => {
    const base = i * 3;
    const committed = readBigInt(userResults[base]);
    const streak = readBigInt(userResults[base + 1]);
    const tipped = readBigInt(userResults[base + 2]);
    const excluded = exclude.has(address.toLowerCase());
    const weight = excluded ? 0n : voteWeight(committed, streak);
    return { address, committed, streak, weight, tipped, excluded };
  });

  const totalWeight = raw.reduce((acc, r) => acc + r.weight, 0n);

  const rowTargets = filterAddress
    ? raw.filter(
        (r) => r.address.toLowerCase() === filterAddress.toLowerCase(),
      )
    : raw;

  const resolved = await resolveMany(
    neynar,
    cache,
    rowTargets.map((r) => r.address),
    ensLookup,
  );
  const resolvedByAddr = new Map(
    resolved.map((r) => [r.address.toLowerCase(), r]),
  );

  const rows: AllocationRow[] = rowTargets.map((r) => {
    const rawAllocation =
      !r.excluded && totalWeight > 0n && tipPool > 0n
        ? (tipPool * r.weight) / totalWeight
        : 0n;
    const allocation = floorToWholeTokens(rawAllocation, decimals);
    const tippedWhole = floorToWholeTokens(r.tipped, decimals);
    const remaining = allocation > tippedWhole ? allocation - tippedWhole : 0n;
    const identity = resolvedByAddr.get(r.address.toLowerCase());

    return {
      address: r.address,
      ens: identity?.ens ?? null,
      username: identity?.username ?? null,
      fid: identity?.fid ?? null,
      committed: r.committed.toString(),
      streak: r.streak.toString(),
      weight: r.weight.toString(),
      allocation: allocation.toString(),
      tipped: tippedWhole.toString(),
      remaining: remaining.toString(),
      excluded: r.excluded,
    };
  });

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

/**
 * Cached full snapshot. Concurrent callers share one in-flight compute.
 * filterAddress is applied after cache so /allocations/:addr stays cheap.
 */
export async function getAllocationsSnapshot(opts: {
  cfg: Config;
  clients: ChainClients;
  neynar: NeynarClient;
  cache: ResolveCache;
  ensLookup: (addr: Address) => Promise<string | null>;
  filterAddress?: Address;
}): Promise<AllocationsSnapshot> {
  const { filterAddress, ...computeOpts } = opts;
  const now = Date.now();

  let snap: AllocationsSnapshot;
  if (snapshotCache && now - snapshotCache.at < SNAPSHOT_TTL_MS) {
    snap = snapshotCache.snap;
  } else if (snapshotInflight) {
    snap = await snapshotInflight;
  } else {
    snapshotInflight = computeAllocations(computeOpts)
      .then((fresh) => {
        snapshotCache = { at: Date.now(), snap: fresh };
        snapshotInflight = null;
        return fresh;
      })
      .catch((err) => {
        snapshotInflight = null;
        throw err;
      });
    snap = await snapshotInflight;
  }

  if (!filterAddress) return snap;
  return {
    ...snap,
    allocations: snap.allocations.filter(
      (r) => r.address.toLowerCase() === filterAddress.toLowerCase(),
    ),
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
  const snap = await getAllocationsSnapshot({
    ...opts,
    filterAddress: opts.address,
  });
  return snap.allocations[0] ?? null;
}
