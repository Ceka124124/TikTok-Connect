// src/routes.js — Express rotaları: /dash paneli, SSE akışı ve API uç noktaları
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "./config.js";
import { log } from "./logger.js";
import {
  rooms,
  stats,
  sseSend,
  setupHeartbeat,
  scheduleCleanup,
  normalizeUsername,
  roomSummary,
} from "./rooms.js";
import { createConnection } from "./connection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const router = express.Router();

/** Basit bellek içi rate limiter. */
function rateLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref?.();
  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (list.length > max) {
      return res.status(429).json({ error: "Çok fazla istek, lütfen bekleyin" });
    }
    next();
  };
}

const apiLimiter = rateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
const sseLimiter = rateLimiter(config.sseRateLimitMax, config.rateLimitWindowMs);

// ---- Panel ----
router.get("/dash", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "dash.html"));
});

// ---- API: Bağlan ----
router.post("/api/connect", apiLimiter, async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  if (!username) {
    return res.status(400).json({ success: false, error: "Geçerli bir kullanıcı adı girin" });
  }

  try {
    const room = await createConnection(username);
    res.json({
      success: true,
      message: "Bağlantı isteği gönderildi",
      username,
      isConnected: room.connection?.isConnected ?? false,
      clientCount: room.clients.size,
    });
  } catch (err) {
    log.error(username, "Bağlantı oluşturulamadı", err);
    res.status(500).json({ success: false, error: err?.message ?? String(err) });
  }
});

// ---- API: Bağlantıyı kes ----
router.post("/api/disconnect", apiLimiter, async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  if (!username) return res.status(400).json({ success: false, error: "username gerekli" });

  const room = rooms.get(username);
  if (!room) return res.status(404).json({ success: false, error: "Oda bulunamadı" });

  try {
    for (const client of room.clients) {
      sseSend(client, "force_disconnect", { message: "Sunucu tarafından kapatıldı" });
      try { client.end(); } catch { /* yoksay */ }
    }
    if (room.connection?.isConnected) await room.connection.disconnect();
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    rooms.delete(username);
    log.info(username, "Manuel olarak bağlantı kesildi");
    res.json({ success: true, message: "Bağlantı kesildi", username });
  } catch (err) {
    log.error(username, "Bağlantı kesme hatası", err);
    res.status(500).json({ success: false, error: err?.message ?? String(err) });
  }
});

// ---- API: Oda durumu ----
router.get("/api/status/:username", (req, res) => {
  const username = normalizeUsername(req.params.username);
  const room = rooms.get(username);
  if (!room) return res.status(404).json({ connected: false, message: "Oda bulunamadı" });
  res.json(roomSummary(username, room));
});

// ---- API: Tüm odalar + sunucu istatistikleri ----
router.get("/api/rooms", (req, res) => {
  res.json({
    rooms: [...rooms.entries()].map(([u, r]) => roomSummary(u, r)),
    totalRooms: rooms.size,
    serverStats: {
      totalConnections: stats.totalConnections,
      totalMessages: stats.totalMessages,
      totalEvents: stats.totalEvents,
      activeRooms: stats.activeRooms(),
      activeClients: stats.activeClients(),
      uptime: Date.now() - stats.startTime,
      memoryUsage: process.memoryUsage(),
      nodeVersion: process.version,
    },
  });
});

// ---- API: Hediye liderlik tablosu ----
router.get("/api/leaderboard/:username", (req, res) => {
  const username = normalizeUsername(req.params.username);
  const room = rooms.get(username);
  if (!room) return res.status(404).json({ error: "Oda bulunamadı" });
  const top = [...room.leaderboard.values()].sort((a, b) => b.coins - a.coins).slice(0, 20);
  res.json({ username, leaderboard: top });
});

// ---- SSE: Canlı olay akışı ----
router.get("/events/:username", sseLimiter, async (req, res) => {
  const username = normalizeUsername(req.params.username);
  if (!username) return res.status(400).json({ error: "username parametresi gerekli" });

  const room = rooms.get(username);
  if (room && room.clients.size >= config.maxClientsPerRoom) {
    return res.status(429).json({ error: `Bu oda için istemci limiti doldu (${config.maxClientsPerRoom})` });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  log.info(username, "SSE istemcisi bağlanıyor");

  sseSend(res, "connected", { message: "SSE bağlandı", username });

  try {
    const roomObj = await createConnection(username);
    roomObj.clients.add(res);
    log.info(username, `SSE istemcisi bağlandı (toplam ${roomObj.clients.size})`);

    if (roomObj.cleanupTimer) {
      clearTimeout(roomObj.cleanupTimer);
      roomObj.cleanupTimer = null;
    }

    setupHeartbeat(username, res);

    if (roomObj.state) {
      sseSend(res, "room_state", {
        roomId: roomObj.state.roomId,
        roomInfo: roomObj.state.roomInfo,
        stats: roomObj.stats,
      });
    }

    // Geç bağlayanlar için son olayları gönder
    if (roomObj.history?.length) {
      sseSend(res, "history", { events: roomObj.history.slice(-50) });
    }

    req.on("close", () => {
      try {
        roomObj.clients.delete(res);
        log.info(username, `SSE istemcisi ayrıldı (kalan ${roomObj.clients.size})`);
        if (roomObj.clients.size === 0) scheduleCleanup(username);
      } catch (err) {
        log.error(username, "İstemci ayrılma hatası", err);
      }
    });

    req.on("error", (err) => {
      log.error(username, "SSE istek hatası", err);
      roomObj.clients.delete(res);
    });
  } catch (err) {
    log.error(username, "SSE kurulumu başarısız", err);
    sseSend(res, "error", { message: err?.message ?? String(err), type: "setup_error" });
    res.end();
  }
});

// ---- Sağlık kontrolü ----
router.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: Date.now() - stats.startTime,
    activeRooms: stats.activeRooms(),
    activeClients: stats.activeClients(),
    memoryUsage: process.memoryUsage(),
  });
});

// ---- Kök ----
router.get("/", (req, res) => {
  res.json({
    service: "TikTok Live SSE Proxy",
    version: "3.0.0",
    dashboard: "/dash",
    endpoints: {
      dashboard: "GET /dash",
      connect: "POST /api/connect",
      disconnect: "POST /api/disconnect",
      status: "GET /api/status/:username",
      rooms: "GET /api/rooms",
      leaderboard: "GET /api/leaderboard/:username",
      events: "GET /events/:username",
      health: "GET /health",
    },
    activeRooms: [...rooms.keys()],
    stats: {
      totalConnections: stats.totalConnections,
      totalMessages: stats.totalMessages,
      totalEvents: stats.totalEvents,
      activeRooms: stats.activeRooms(),
      activeClients: stats.activeClients(),
      uptime: Date.now() - stats.startTime,
    },
  });
});

export default router;
