import express from "express";
import type { Address } from "viem";
import type { Config } from "./config.js";
import type { ChainClients } from "./chain.js";
import type { CastPayload, NeynarClient } from "./neynar.js";
import { fetchCast, resolveAddress } from "./neynar.js";
import { verifyNeynarWebhookSignature } from "./neynar-webhook.js";
import type { ResolveCache } from "./resolve-cache.js";
import type { TipQueue } from "./queue.js";
import type { CycleState } from "./cycle.js";
import { enqueueFromCast } from "./tips.js";
import {
  allocationForAddress,
  getAllocationsSnapshot,
} from "./allocations.js";
import { castHashToBytes32, isCastUsed } from "./chain.js";

export type AppContext = {
  cfg: Config;
  clients: ChainClients;
  neynar: NeynarClient;
  cache: ResolveCache;
  queue: TipQueue;
  getCycle: () => CycleState | null;
  ensLookup: (addr: Address) => Promise<string | null>;
};

function requireReplaySecret(cfg: Config, req: express.Request): boolean {
  if (!cfg.replaySecret) return true;
  const header = req.header("x-tip-bot-secret") ?? "";
  const query = typeof req.query.secret === "string" ? req.query.secret : "";
  return header === cfg.replaySecret || query === cfg.replaySecret;
}

function applyCors(
  req: express.Request,
  res: express.Response,
  origins: string[],
): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  const allowAll = origins.includes("*");
  if (!allowAll && !origins.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", allowAll ? "*" : origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  return true;
}

export function createApp(ctx: AppContext) {
  const app = express();

  // Browser clients (rug-app) call /resolve and /allocations directly.
  app.use((req, res, next) => {
    applyCors(req, res, ctx.cfg.corsOrigins);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Raw body required for Neynar HMAC verification — register before express.json().
  app.post(
    "/webhook/neynar",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => {
      try {
        const rawBody = req.body as Buffer;
        if (!Buffer.isBuffer(rawBody)) {
          res.status(400).json({ error: "invalid_body" });
          return;
        }

        if (!ctx.cfg.neynarWebhookSecret) {
          console.error("[webhook] NEYNAR_WEBHOOK_SECRET not set — rejecting");
          res.status(503).json({ error: "webhook_secret_not_configured" });
          return;
        }

        const signature = req.header("x-neynar-signature");
        if (
          !verifyNeynarWebhookSignature(
            rawBody,
            signature,
            ctx.cfg.neynarWebhookSecret,
          )
        ) {
          res.status(401).json({ error: "unauthorized" });
          return;
        }

        const body = JSON.parse(rawBody.toString("utf-8")) as {
          type?: string;
          data?: CastPayload;
        };

        if (body.type && body.type !== "cast.created") {
          res.status(200).json({ ignored: true });
          return;
        }

        const cast = body.data;
        if (!cast?.hash || !cast.author) {
          res.status(200).json({ ignored: true, reason: "no_cast" });
          return;
        }

        const cycle = ctx.getCycle();
        if (!cycle) {
          res.status(503).json({ error: "cycle_not_ready" });
          return;
        }

        const result = await enqueueFromCast({
          cast,
          cycle,
          cfg: ctx.cfg,
          clients: ctx.clients,
          neynar: ctx.neynar,
          cache: ctx.cache,
          queue: ctx.queue,
          ensLookup: ctx.ensLookup,
        });

        res.status(200).json(result);
      } catch (err) {
        console.error("[webhook]", err);
        res.status(500).json({ error: "webhook_failed" });
      }
    },
  );

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    const cycle = ctx.getCycle();
    res.json({
      ok: true,
      queue: ctx.queue.size(),
      ticker: cycle?.ticker ?? null,
      token: cycle?.currentToken ?? null,
      tippers: cycle?.authorFids.length ?? 0,
      exclude: ctx.cfg.excludeAddresses,
    });
  });

  app.get("/resolve/:address", async (req, res) => {
    try {
      const address = req.params.address as Address;
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        res.status(400).json({ error: "invalid_address" });
        return;
      }
      const record = await resolveAddress(
        ctx.neynar,
        ctx.cache,
        address,
        ctx.ensLookup,
      );
      res.json(record);
    } catch (err) {
      console.error("[resolve]", err);
      res.status(500).json({ error: "resolve_failed" });
    }
  });

  app.get("/allocations", async (_req, res) => {
    try {
      const snap = await getAllocationsSnapshot({
        cfg: ctx.cfg,
        clients: ctx.clients,
        neynar: ctx.neynar,
        cache: ctx.cache,
        ensLookup: ctx.ensLookup,
      });
      res.json(snap);
    } catch (err) {
      console.error("[allocations]", err);
      res.status(500).json({ error: "allocations_failed" });
    }
  });

  app.get("/allocations/:address", async (req, res) => {
    try {
      const address = req.params.address as Address;
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        res.status(400).json({ error: "invalid_address" });
        return;
      }
      const row = await allocationForAddress({
        cfg: ctx.cfg,
        clients: ctx.clients,
        neynar: ctx.neynar,
        cache: ctx.cache,
        ensLookup: ctx.ensLookup,
        address,
      });
      if (!row) {
        res.status(404).json({ error: "not_a_tipper" });
        return;
      }
      res.json(row);
    } catch (err) {
      console.error("[allocations/:address]", err);
      res.status(500).json({ error: "allocation_failed" });
    }
  });

  app.post("/tips/replay", async (req, res) => {
    try {
      if (!requireReplaySecret(ctx.cfg, req)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const castHash = (req.body?.castHash ?? req.body?.hash) as string | undefined;
      if (!castHash) {
        res.status(400).json({ error: "missing_cast_hash" });
        return;
      }

      const cycle = ctx.getCycle();
      if (!cycle) {
        res.status(503).json({ error: "cycle_not_ready" });
        return;
      }

      const cast = await fetchCast(ctx.neynar, castHash);
      if (!cast) {
        res.status(404).json({ error: "cast_not_found" });
        return;
      }

      const result = await enqueueFromCast({
        cast,
        cycle,
        cfg: ctx.cfg,
        clients: ctx.clients,
        neynar: ctx.neynar,
        cache: ctx.cache,
        queue: ctx.queue,
        ensLookup: ctx.ensLookup,
      });

      res.status(200).json(result);
    } catch (err) {
      console.error("[replay]", err);
      res.status(500).json({ error: "replay_failed" });
    }
  });

  app.get("/tips/status/:castHash", async (req, res) => {
    try {
      const raw = req.params.castHash;
      if (!raw || !/^0x[a-fA-F0-9]+$/.test(raw)) {
        res.status(400).json({ error: "invalid_cast_hash" });
        return;
      }

      let bytes32: `0x${string}`;
      try {
        bytes32 = castHashToBytes32(raw);
      } catch {
        res.status(400).json({ error: "invalid_cast_hash" });
        return;
      }

      const used = await isCastUsed(
        ctx.clients.publicClient,
        ctx.cfg.tipDistributorAddress,
        bytes32,
      );
      const pending = ctx.queue.get(raw) ?? ctx.queue.get(bytes32);

      if (used) {
        res.json({
          castHash: raw,
          status: "processed",
          used: true,
          pending: false,
        });
        return;
      }

      if (pending) {
        res.json({
          castHash: raw,
          status: "pending",
          used: false,
          pending: true,
          tip: {
            tipper: pending.tipper,
            to: pending.to,
            amount: pending.amount,
            ticker: pending.ticker,
            enqueuedAt: pending.enqueuedAt,
          },
        });
        return;
      }

      res.json({
        castHash: raw,
        status: "unknown",
        used: false,
        pending: false,
      });
    } catch (err) {
      console.error("[tips/status]", err);
      res.status(500).json({ error: "status_failed" });
    }
  });

  return app;
}
