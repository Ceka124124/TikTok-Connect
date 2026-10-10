// src/config.js — Merkezi yapılandırma (.env destekli)
import "dotenv/config";

const int = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || "127.0.0.1",
  env: process.env.NODE_ENV || "development",
  corsOrigin: process.env.CORS_ORIGIN || "*",

  // Oda / bağlantı yönetimi
  cleanupTimeout: int(process.env.CLEANUP_TIMEOUT, 5 * 60 * 1000),
  maxReconnectAttempts: int(process.env.MAX_RECONNECT_ATTEMPTS, 3),
  heartbeatInterval: int(process.env.HEARTBEAT_INTERVAL, 30000),
  maxClientsPerRoom: int(process.env.MAX_CONNECTIONS_PER_USER, 5),
  maxTotalRooms: int(process.env.MAX_TOTAL_ROOMS, 100),
  eventHistorySize: int(process.env.EVENT_HISTORY_SIZE, 200),

  // Rate limiting
  rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60000),
  rateLimitMax: int(process.env.RATE_LIMIT_MAX_REQUESTS, 100),
  sseRateLimitMax: int(process.env.SSE_RATE_LIMIT_MAX, 30),

  // Sıkıştırma
  compressionLevel: int(process.env.COMPRESSION_LEVEL, 6),
  compressionThreshold: int(process.env.COMPRESSION_THRESHOLD, 1024),

  // Loglama
  logLevel: process.env.LOG_LEVEL || "info",
  logDir: process.env.LOG_DIR || "logs",
};

export default config;
