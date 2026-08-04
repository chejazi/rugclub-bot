import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import tipDistributorAbi from "./abis/tip-distributor.json" with { type: "json" };
import protocolAbi from "./abis/protocol.json" with { type: "json" };
import erc20Abi from "./abis/erc20.json" with { type: "json" };
import type { Config } from "./config.js";
import type { PendingTip } from "./queue.js";

export function createClients(cfg: Config) {
  const account = privateKeyToAccount(cfg.tipOperatorKey);
  const publicClient = createPublicClient({
    chain: base,
    transport: http(cfg.baseRpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(cfg.baseRpcUrl),
  });
  return { publicClient, walletClient, account };
}

export type ChainClients = ReturnType<typeof createClients>;

export async function getCurrentToken(
  client: ChainClients["publicClient"],
  protocol: Address,
): Promise<Address> {
  return (await client.readContract({
    address: protocol,
    abi: protocolAbi,
    functionName: "getCurrentToken",
  })) as Address;
}

export async function getPreviousToken(
  client: ChainClients["publicClient"],
  protocol: Address,
): Promise<Address> {
  return (await client.readContract({
    address: protocol,
    abi: protocolAbi,
    functionName: "getPreviousToken",
  })) as Address;
}

export async function getRugUsers(
  client: ChainClients["publicClient"],
  protocol: Address,
  token: Address,
): Promise<Address[]> {
  return (await client.readContract({
    address: protocol,
    abi: protocolAbi,
    functionName: "getRugUsers",
    args: [token],
  })) as Address[];
}

export async function getUserCommittedTokens(
  client: ChainClients["publicClient"],
  protocol: Address,
  account: Address,
  token: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: protocol,
    abi: protocolAbi,
    functionName: "getUserCommittedTokens",
    args: [account, token],
  })) as bigint;
}

export async function getUserStreak(
  client: ChainClients["publicClient"],
  protocol: Address,
  account: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: protocol,
    abi: protocolAbi,
    functionName: "getUserStreak",
    args: [account],
  })) as bigint;
}

export async function getTokenMeta(
  client: ChainClients["publicClient"],
  token: Address,
): Promise<{ symbol: string; decimals: number }> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "symbol",
    }) as Promise<string>,
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    }) as Promise<number>,
  ]);
  return { symbol, decimals: Number(decimals) };
}

export async function getTipPool(
  client: ChainClients["publicClient"],
  tipDistributor: Address,
  token: Address,
): Promise<bigint> {
  const [balance, totalTipped] = await Promise.all([
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [tipDistributor],
    }) as Promise<bigint>,
    client.readContract({
      address: tipDistributor,
      abi: tipDistributorAbi,
      functionName: "totalTipped",
      args: [token],
    }) as Promise<bigint>,
  ]);
  return balance + totalTipped;
}

export async function getTipped(
  client: ChainClients["publicClient"],
  tipDistributor: Address,
  token: Address,
  tipper: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: tipDistributor,
    abi: tipDistributorAbi,
    functionName: "tipped",
    args: [token, tipper],
  })) as bigint;
}

export async function isCastUsed(
  client: ChainClients["publicClient"],
  tipDistributor: Address,
  castHash: Hex,
): Promise<boolean> {
  return (await client.readContract({
    address: tipDistributor,
    abi: tipDistributorAbi,
    functionName: "usedCast",
    args: [castHash],
  })) as boolean;
}

/** Normalize Farcaster cast hash (0x + 40 hex) to bytes32. */
export function castHashToBytes32(hash: string): Hex {
  const h = hash.toLowerCase().replace(/^0x/, "");
  if (h.length === 64) return `0x${h}` as Hex;
  if (h.length === 40) return `0x${h.padStart(64, "0")}` as Hex;
  throw new Error(`Unexpected cast hash length: ${hash}`);
}

export function parseTipAmount(raw: string, decimals: number): bigint {
  if (!/^\d+$/.test(raw)) throw new Error("Invalid amount");
  return parseUnits(raw, decimals);
}

/** Floor wei down to a whole-token multiple (10^decimals). */
export function floorToWholeTokens(amount: bigint, decimals: number): bigint {
  if (decimals <= 0) return amount;
  const unit = 10n ** BigInt(decimals);
  return (amount / unit) * unit;
}


export async function tipBatch(
  clients: ChainClients,
  tipDistributor: Address,
  tips: PendingTip[],
): Promise<Hex> {
  const castHashes = tips.map((t) => castHashToBytes32(t.castHash));
  const tippers = tips.map((t) => t.tipper);
  const recipients = tips.map((t) => t.to);
  const amounts = tips.map((t) => BigInt(t.amount));
  const allocations = tips.map((t) => BigInt(t.allocation));

  return clients.walletClient.writeContract({
    address: tipDistributor,
    abi: tipDistributorAbi,
    functionName: "tipBatch",
    args: [castHashes, tippers, recipients, amounts, allocations],
    account: clients.account,
    chain: base,
  });
}
