import { Configuration, NeynarAPIClient } from "@neynar/nodejs-sdk";
import type { Address } from "viem";
import type { ResolveCache, ResolveRecord } from "./resolve-cache.js";
import { tipRegexForTicker } from "./parse-tip.js";

export function createNeynarClient(apiKey: string) {
  return new NeynarAPIClient(new Configuration({ apiKey }));
}

export type NeynarClient = ReturnType<typeof createNeynarClient>;

type NeynarUser = {
  fid: number;
  username?: string;
  verifications?: string[];
  custody_address?: string;
  verified_addresses?: {
    eth_addresses?: string[];
    primary?: {
      eth_address?: string | null;
      sol_address?: string | null;
    };
  };
};

/** Prefer primary ETH, then first verification, then custody. */
function primaryAddress(user: NeynarUser): Address | null {
  const primaryEth = user.verified_addresses?.primary?.eth_address;
  const v =
    primaryEth || user.verifications?.[0] || user.custody_address || null;
  return v ? (v as Address) : null;
}

export async function fetchUsersByAddresses(
  client: NeynarClient,
  addresses: Address[],
): Promise<Map<string, NeynarUser>> {
  const out = new Map<string, NeynarUser>();
  if (addresses.length === 0) return out;

  // SDK: fetchBulkUsersByEthOrSolAddress
  // Neynar returns 404 { code: "NotFound", message: "No users found" } when
  // none of the addresses map to a Farcaster user — treat as empty, not fatal.
  let res: unknown;
  try {
    res = await client.fetchBulkUsersByEthOrSolAddress({
      addresses: addresses.map((a) => a.toLowerCase()),
    });
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    const code = (err as { response?: { data?: { code?: string } } })?.response
      ?.data?.code;
    if (status === 404 || code === "NotFound") {
      return out;
    }
    throw err;
  }

  // SDK returns a map of address → users (not wrapped in `.users`)
  const users = res as Record<string, NeynarUser[]>;
  for (const [addr, list] of Object.entries(users)) {
    if (addr === "message" || addr === "code") continue;
    const user = list?.[0];
    if (user) out.set(addr.toLowerCase(), user);
  }
  return out;
}

export async function resolveAddress(
  client: NeynarClient,
  cache: ResolveCache,
  address: Address,
  ensLookup: (addr: Address) => Promise<string | null>,
): Promise<ResolveRecord> {
  const cached = cache.get(address);
  if (cached) return cached;

  const byAddr = await fetchUsersByAddresses(client, [address]);
  const user = byAddr.get(address.toLowerCase());
  let ens: string | null = null;
  try {
    ens = await ensLookup(address);
  } catch {
    ens = null;
  }

  const record: ResolveRecord = {
    address,
    ens,
    fid: user?.fid ?? null,
    username: user?.username ?? null,
    updatedAt: Date.now(),
  };
  cache.set(record);
  return record;
}

export async function resolveMany(
  client: NeynarClient,
  cache: ResolveCache,
  addresses: Address[],
  ensLookup: (addr: Address) => Promise<string | null>,
): Promise<ResolveRecord[]> {
  const missing = cache.missing(addresses);
  if (missing.length > 0) {
    const byAddr = await fetchUsersByAddresses(client, missing);
    for (const addr of missing) {
      const user = byAddr.get(addr.toLowerCase());
      let ens: string | null = null;
      try {
        ens = await ensLookup(addr);
      } catch {
        ens = null;
      }
      cache.set({
        address: addr,
        ens,
        fid: user?.fid ?? null,
        username: user?.username ?? null,
        updatedAt: Date.now(),
      });
    }
  }
  return addresses.map(
    (a) =>
      cache.get(a) ?? {
        address: a,
        ens: null,
        fid: null,
        username: null,
        updatedAt: Date.now(),
      },
  );
}

export async function fetchCast(client: NeynarClient, castHash: string) {
  const res = await client.lookupCastByHashOrWarpcastUrl({
    identifier: castHash,
    type: "hash",
  });
  return (res as { cast?: CastPayload }).cast;
}

export type CastPayload = {
  hash: string;
  text: string;
  parent_hash: string | null;
  author: {
    fid: number;
    username?: string;
    verifications?: string[];
    custody_address?: string;
    verified_addresses?: NeynarUser["verified_addresses"];
  };
  parent_author?: { fid?: number | null };
};

export function tipperAddressFromAuthor(author: CastPayload["author"]): Address | null {
  return primaryAddress(author);
}

export async function publishReply(
  client: NeynarClient,
  signerUuid: string,
  text: string,
  parentHash: string,
) {
  return client.publishCast({
    signerUuid,
    text,
    parent: parentHash,
  });
}

export async function upsertTipWebhook(opts: {
  client: NeynarClient;
  webhookId: string;
  targetUrl: string;
  authorFids: number[];
  ticker: string;
  env: "DEV" | "PROD";
}) {
  const { client, webhookId, targetUrl, ticker, env } = opts;
  // Neynar cast.created filter keys are OR'd together. Use text-only so we don't
  // receive every cast from eligible FIDs; tipper eligibility is enforced in-bot.
  const subscription = {
    "cast.created": {
      text: tipRegexForTicker(ticker),
    },
  };

  await client.updateWebhook({
    webhookId,
    name: `Rug Club [${env}]`,
    url: targetUrl,
    subscription,
  });
}

export { primaryAddress };
