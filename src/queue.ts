import type { Address, Hex } from "viem";
import { createDebouncedPersist, loadJsonFile } from "./persist.js";

export type PendingTip = {
  castHash: Hex;
  tipper: Address;
  to: Address;
  amount: string; // wei decimal string
  allocation: string; // off-chain tip budget wei
  token: Address;
  ticker: string;
  decimals: number;
  parentHash: Hex;
  tipperFid: number;
  recipientFid: number;
  enqueuedAt: number;
};

export class TipQueue {
  private byHash = new Map<string, PendingTip>();
  private persist;

  constructor(private readonly filePath: string) {
    this.persist = createDebouncedPersist(() => this.toJSON(), filePath);
  }

  async load(): Promise<void> {
    const rows = await loadJsonFile<PendingTip[]>(this.filePath, []);
    this.byHash.clear();
    for (const row of rows) {
      if (!row.allocation) continue; // drop pre-allocation-param queue entries
      this.byHash.set(row.castHash.toLowerCase(), row);
    }
    console.log(`[queue] loaded ${this.byHash.size} pending tip(s)`);
  }

  has(castHash: string): boolean {
    return this.byHash.has(castHash.toLowerCase());
  }

  get(castHash: string): PendingTip | undefined {
    return this.byHash.get(castHash.toLowerCase());
  }

  enqueue(tip: PendingTip): boolean {
    const key = tip.castHash.toLowerCase();
    if (this.byHash.has(key)) return false;
    this.byHash.set(key, tip);
    this.persist.schedule();
    return true;
  }

  remove(castHash: string): void {
    if (this.byHash.delete(castHash.toLowerCase())) {
      this.persist.schedule();
    }
  }

  removeToken(token: string): void {
    const t = token.toLowerCase();
    let changed = false;
    for (const [key, tip] of this.byHash) {
      if (tip.token.toLowerCase() === t) {
        this.byHash.delete(key);
        changed = true;
      }
    }
    if (changed) this.persist.schedule();
  }

  drain(limit: number): PendingTip[] {
    const out: PendingTip[] = [];
    for (const tip of this.byHash.values()) {
      out.push(tip);
      if (out.length >= limit) break;
    }
    return out;
  }

  size(): number {
    return this.byHash.size;
  }

  async flush(): Promise<void> {
    await this.persist.flush();
  }

  private toJSON(): PendingTip[] {
    return [...this.byHash.values()];
  }
}
