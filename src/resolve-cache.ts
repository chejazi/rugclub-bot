import type { Address } from "viem";
import { createDebouncedPersist, loadJsonFile } from "./persist.js";

export type ResolveRecord = {
  address: Address;
  ens: string | null;
  fid: number | null;
  username: string | null;
  updatedAt: number;
};

type CacheFile = Record<string, ResolveRecord>;

export class ResolveCache {
  private byAddress = new Map<string, ResolveRecord>();
  private persist;

  constructor(private readonly filePath: string) {
    this.persist = createDebouncedPersist(() => this.toJSON(), filePath);
  }

  async load(): Promise<void> {
    const data = await loadJsonFile<CacheFile>(this.filePath, {});
    this.byAddress.clear();
    for (const [key, value] of Object.entries(data)) {
      this.byAddress.set(key.toLowerCase(), value);
    }
    console.log(`[resolve] loaded ${this.byAddress.size} address(es)`);
  }

  get(address: string): ResolveRecord | undefined {
    return this.byAddress.get(address.toLowerCase());
  }

  set(record: ResolveRecord): void {
    this.byAddress.set(record.address.toLowerCase(), record);
    this.persist.schedule();
  }

  /** Addresses not yet in cache. */
  missing(addresses: string[]): Address[] {
    const out: Address[] = [];
    for (const a of addresses) {
      if (!this.byAddress.has(a.toLowerCase())) {
        out.push(a as Address);
      }
    }
    return out;
  }

  async flush(): Promise<void> {
    await this.persist.flush();
  }

  private toJSON(): CacheFile {
    const out: CacheFile = {};
    for (const [key, value] of this.byAddress) {
      out[key] = value;
    }
    return out;
  }
}
