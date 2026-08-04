import { createPublicClient, http, type Address } from "viem";
import { mainnet } from "viem/chains";
import { config } from "./config.js";
import { createClients } from "./chain.js";
import { createNeynarClient } from "./neynar.js";
import { TipQueue } from "./queue.js";
import { ResolveCache } from "./resolve-cache.js";
import { refreshCycle, type CycleState } from "./cycle.js";
import { processQueueBatch } from "./tips.js";
import { createApp } from "./routes.js";

async function main() {
  const clients = createClients(config);
  const neynar = createNeynarClient(config.neynarApiKey);
  const queue = new TipQueue(config.queuePath);
  const cache = new ResolveCache(config.resolveCachePath);

  await queue.load();
  await cache.load();

  // ENS reverse lookup via mainnet (Alchemy ETH RPC if provided, else public)
  const ensRpc =
    process.env.ENS_RPC_URL?.trim() ||
    "https://eth.llamarpc.com";
  const ensClient = createPublicClient({
    chain: mainnet,
    transport: http(ensRpc),
  });
  const ensLookup = async (addr: Address) => {
    try {
      return (await ensClient.getEnsName({ address: addr })) ?? null;
    } catch {
      return null;
    }
  };

  let cycle: CycleState | null = null;

  const refresh = async () => {
    cycle = await refreshCycle({
      cfg: config,
      clients,
      neynar,
      cache,
      queue,
      prev: cycle,
      ensLookup,
    });
  };

  await refresh();

  console.log(`[boot] queue=${queue.size()} operator=${clients.account.address}`);

  const app = createApp({
    cfg: config,
    clients,
    neynar,
    cache,
    queue,
    getCycle: () => cycle,
    ensLookup,
  });

  const server = app.listen(config.port, () => {
    console.log(`[boot] listening on :${config.port}`);
  });

  const tick = async () => {
    try {
      await refresh();
      await processQueueBatch({ cfg: config, clients, neynar, queue });
    } catch (err) {
      console.error("[tick]", err);
    }
  };

  const interval = setInterval(() => void tick(), config.tipIntervalMs);

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] ${signal}`);
    clearInterval(interval);
    server.close();
    try {
      await queue.flush();
      await cache.flush();
      console.log("[shutdown] state flushed");
    } catch (err) {
      console.error("[shutdown] flush failed", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
