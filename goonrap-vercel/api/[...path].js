import { handleUpload } from "@vercel/blob/client";
import { del } from "@vercel/blob";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[\w-]+$/;
const BLOB = /^https:\/\/[^/]+\.blob\.vercel-storage\.com\//i;
const send = (res, data, status = 200, cache = "no-store") => {
  res.status(status);
  res.setHeader("cache-control", cache);
  res.json(data);
};
const clean = (s, n) => String(s ?? "").trim().slice(0, n);
const safeDel = async (u) => { try { if (u) await del(u); } catch (e) { /* ignore */ } };

function apply(t, b) {
  if ("title" in b) { const x = clean(b.title, 90); if (x) t.title = x; }
  if ("desc" in b) t.desc = clean(b.desc, 300);
  if (HEX.test(b.color)) t.color = b.color;
  if ("c2" in b) t.c2 = HEX.test(b.c2) ? b.c2 : "";
  if ("anim" in b) t.anim = ["none", "flow", "pulse", "hue"].includes(b.anim) ? b.anim : "none";
  if ("releaseAt" in b) t.releaseAt = Math.max(0, Number(b.releaseAt) || 0);
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname.split("/").filter(Boolean).slice(1);
    const id = id || url.searchParams.get("id") || "";
    const cid = cid || url.searchParams.get("cid") || "";
    const code = process.env.ADMIN_CODE;
    if (!process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL) return send(res, { error: "База данных не подключена" }, 500);
    const admin = !!code && req.headers["x-code"] === code;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const list = async () => (await redis.get("tracks")) || [];
    const m = req.method;

    if (p[0] === "tracks" && m === "GET") {
      const now = Date.now();
      const all = await list();
      if (admin) return send(res, all);
      return send(res, all.map((t) => (t.releaseAt > now ? { ...t, audioUrl: undefined } : t)));
    }

    if (p[0] === "login") return send(res, { ok: admin }, admin ? 200 : 401);

    if (p[0] === "upload" && m === "POST") {
      const json = await handleUpload({
        body: req.body,
        request: req,
        onBeforeGenerateToken: async (_pathname, clientPayload) => {
          if (!code || clientPayload !== code) throw new Error("Неверный код");
          return {
            allowedContentTypes: ["audio/*", "image/*", "application/octet-stream"],
            maximumSizeInBytes: 150 * 1024 * 1024,
            addRandomSuffix: true,
          };
        },
        onUploadCompleted: async () => {},
      });
      return send(res, json);
    }

    if (p[0] === "social" && ID.test(id || "") && m === "GET") {
      const v = String(url.searchParams.get("v") || "").slice(0, 80);
      const [n, mine, cms] = await redis.pipeline().scard("fire:" + id).sismember("fire:" + id, v || "-").lrange("cm:" + id, 0, 99).exec();
      return send(res, { fire: n || 0, mine: !!mine, comments: cms || [] });
    }

    if (p[0] === "fire" && ID.test(id || "") && m === "POST") {
      const v = String(body.v || "").slice(0, 80);
      if (!v) return send(res, {}, 400);
      const k = "fire:" + id;
      const had = await redis.sismember(k, v);
      if (had) await redis.srem(k, v); else await redis.sadd(k, v);
      const [n, cms] = await redis.pipeline().scard(k).lrange("cm:" + id, 0, 99).exec();
      return send(res, { fire: n || 0, mine: !had, comments: cms || [] });
    }

    if (p[0] === "comment" && ID.test(id || "") && m === "POST") {
      const name = clean(body.name, 24) || "Anon";
      const text = clean(body.text, 300);
      if (!text) return send(res, { error: "empty" }, 400);
      const ip = String(req.headers["x-forwarded-for"] || body.v || "x").split(",")[0].trim();
      const key = "rl:" + ip.replace(/[^\w.:-]/g, "_");
      const now = Date.now();
      const r = (await redis.get(key)) || { last: 0, warn: 0, until: 0 };
      if (r.until > now) return send(res, { error: "ban", until: r.until }, 429);
      if (now - r.last < 10000) {
        r.warn++; r.last = now;
        if (r.warn >= 3) { r.until = now + 864e5; r.warn = 0; await redis.set(key, r, { ex: 172800 }); return send(res, { error: "ban", until: r.until }, 429); }
        await redis.set(key, r, { ex: 172800 });
        return send(res, { error: "warn", warn: r.warn }, 429);
      }
      if (now - r.last > 60000) r.warn = 0;
      r.last = now;
      await redis.set(key, r, { ex: 172800 });
      const c = { id: now.toString(36), name, text, t: now };
      await redis.lpush("cm:" + id, c);
      await redis.ltrim("cm:" + id, 0, 99);
      return send(res, { comments: await redis.lrange("cm:" + id, 0, 99) });
    }

    if (!admin) return send(res, { error: "Неверный код" }, 401);

    if (p[0] === "comment" && ID.test(id || "") && m === "DELETE") {
      const k = "cm:" + id;
      const all = (await redis.lrange(k, 0, 99)) || [];
      const hit = all.find((c) => c.id === cid);
      if (hit) await redis.lrem(k, 1, hit);
      return send(res, { ok: true });
    }

    if (p[0] === "track" && m === "POST") {
      if (!BLOB.test(body.audioUrl || "")) return send(res, { error: "Нужен mp3" }, 400);
      const t = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), created: Date.now(), title: "Без названия", desc: "", color: "#8b5cf6", c2: "", anim: "none", releaseAt: 0, cover: false, audioUrl: body.audioUrl };
      apply(t, body);
      if (BLOB.test(body.coverUrl || "")) { t.cover = true; t.coverUrl = body.coverUrl; }
      await redis.set("tracks", [t, ...(await list())]);
      return send(res, t);
    }

    if (p[0] === "track" && ID.test(id || "") && m === "PUT") {
      const all = await list();
      const t = all.find((x) => x.id === id);
      if (!t) return send(res, { error: "Не найден" }, 404);
      apply(t, body);
      if (body.removeCover && t.coverUrl) { await safeDel(t.coverUrl); t.cover = false; t.coverUrl = ""; }
      else if (BLOB.test(body.coverUrl || "")) { if (t.coverUrl && t.coverUrl !== body.coverUrl) await safeDel(t.coverUrl); t.cover = true; t.coverUrl = body.coverUrl; }
      t.updated = Date.now();
      await redis.set("tracks", all);
      return send(res, t);
    }

    if (p[0] === "track" && ID.test(id || "") && m === "DELETE") {
      const all = await list();
      const t = all.find((x) => x.id === id);
      await redis.set("tracks", all.filter((x) => x.id !== id));
      if (t) { await safeDel(t.audioUrl); await safeDel(t.coverUrl); }
      await redis.del("fire:" + id, "cm:" + id);
      return send(res, { ok: true });
    }

    return send(res, { error: "not found" }, 404);
  } catch (e) {
    return send(res, { error: String((e && e.message) || e) }, 500);
  }
}
