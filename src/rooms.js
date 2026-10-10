// src/rooms.js — Oda deposu, SSE yayını, heartbeat, temizlik ve istatistikler
import config from "./config.js";
import { log } from "./logger.js";

export const rooms = new Map();

export const stats = {
  totalConnections: 0,
  totalMessages: 0,
  totalEvents: 0,
  startTime: Date.now(),
  activeRooms: () => rooms.size,
  activeClients: () => [...rooms.values()].reduce((sum, r) => sum + r.clients.size, 0),
};

/** Kullanıcı adını normalize et: @ işaretini ve boşlukları temizle, küçük harfe çevir. */
export function normalizeUsername(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/^@+/, "").replace(/\s+/g, "").toLowerCase();
}

/** Tek bir SSE istemcisine mesaj gönder. */
export function sseSend(res, event, data) {
  if (res.destroyed || res.writableEnded) return false;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** Odadaki tüm istemcilere yayın yap — hem adlandırılmış olay hem de genel "event" akışı. */
export function broadcast(username, event, data) {
  const room = rooms.get(username);
  if (!room) return;

  stats.totalMessages++;
  stats.totalEvents++;

  const payload = { name: event, ...data };
  const dead = [];

  for (const res of room.clients) {
    if (!sseSend(res, event, data) || !sseSend(res, "event", payload)) dead.push(res);
  }

  if (dead.length) {
    dead.forEach((res) => room.clients.delete(res));
    log.warn(username, `Ölü istemci temizlendi`, { count: dead.length });
  }
}

/** Olay geçmişine kaydet (geç bağlananlar için). */
export function pushHistory(room, event, data) {
  if (!room.history) room.history = [];
  room.history.push({ name: event, at: Date.now(), ...data });
  if (room.history.length > config.eventHistorySize) room.history.shift();
}

/** Heartbeat kurulumu. */
export function setupHeartbeat(username, res) {
  const timer = setInterval(() => {
    if (!sseSend(res, "heartbeat", { timestamp: Date.now() })) clearInterval(timer);
  }, config.heartbeatInterval);
  timer.unref?.();
  res.on("close", () => clearInterval(timer));
  return timer;
}

/** İstemci kalmadıysa odayı zamanlayıcı ile kapat. */
export function scheduleCleanup(username) {
  const room = rooms.get(username);
  if (!room) return;

  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  if (room.clients.size > 0) return;

  log.info(username, `${config.cleanupTimeout}ms sonra temizlenecek`);
  room.cleanupTimer = setTimeout(async () => {
    try {
      if (room.connection?.isConnected) await room.connection.disconnect();
      rooms.delete(username);
      log.info(username, "Oda hareketsizlik nedeniyle kapatıldı");
    } catch (err) {
      log.error(username, "Temizlik hatası", err);
    }
  }, config.cleanupTimeout);
  room.cleanupTimer.unref?.();
}

/** Odanın anlık durum özeti. */
export function roomSummary(username, room) {
  return {
    username,
    connected: room.connection?.isConnected ?? false,
    clientCount: room.clients.size,
    roomId: room.state?.roomId ?? null,
    lastActive: room.lastActive,
    stats: room.stats,
  };
}
