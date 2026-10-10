// src/logger.js — Winston tabanlı yapılandırılmış logger
import fs from "node:fs";
import path from "node:path";
import winston from "winston";
import config from "./config.js";

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: "HH:mm:ss" }),
      winston.format.printf(({ timestamp, level, message, room, ...meta }) => {
        const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
        const tag = room ? `[${room}] ` : "";
        return `${timestamp} ${level}: ${tag}${message}${rest}`;
      })
    ),
  }),
];

try {
  fs.mkdirSync(config.logDir, { recursive: true });
  transports.push(
    new winston.transports.File({
      filename: path.join(config.logDir, "error.log"),
      level: "error",
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: path.join(config.logDir, "combined.log"),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    })
  );
} catch {
  // Log dizini yazılamıyorsa sadece konsola yaz.
}

export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports,
});

/** Oda etiketli kısayollar */
export const log = {
  info: (room, message, meta = {}) => logger.info(message, { room, ...meta }),
  warn: (room, message, meta = {}) => logger.warn(message, { room, ...meta }),
  error: (room, message, error) =>
    logger.error(message, { room, error: error?.message ?? String(error ?? "") }),
};

export default logger;
