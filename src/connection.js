// src/connection.js — TikTok Live bağlantısı, olay dinleyicileri ve yeniden bağlanma
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from "tiktok-live-connector";
import config from "./config.js";
import { log } from "./logger.js";
import { rooms, stats, broadcast, pushHistory, scheduleCleanup } from "./rooms.js";

/** Kullanıcı nesnesini güvenli şekilde sadeleştir. */
function slimUser(user) {
  if (!user) return null;
  return {
    uniqueId: user.uniqueId ?? null,
    nickname: user.nickname ?? null,
    profilePictureUrl: user.profilePictureUrl ?? null,
  };
}

/** Hediye liderlik tablosunu güncelle. */
function trackGifter(room, data) {
  const id = data.user?.uniqueId;
  if (!id) return;
  const diamond = data.diamondCount ?? 0;
  const entry = room.leaderboard.get(id) ?? {
    uniqueId: id,
    nickname: data.user?.nickname ?? id,
    profilePictureUrl: data.user?.profilePictureUrl ?? null,
    coins: 0,
    gifts: 0,
  };
  entry.coins += diamond * (data.repeatCount ?? 1);
  entry.gifts += data.repeatCount ?? 1;
  entry.nickname = data.user?.nickname ?? entry.nickname;
  room.leaderboard.set(id, entry);
}

/** Yeniden bağlanma denemesi (üssel geri çekilme). */
export async function attemptReconnect(username, attempt = 1) {
  const room = rooms.get(username);
  if (!room) return false;

  if (attempt > config.maxReconnectAttempts) {
    log.error(username, "Maksimum yeniden bağlanma denemesine ulaşıldı");
    broadcast(username, "connection_failed", { message: "Yeniden bağlanılamadı" });
    return false;
  }

  log.info(username, `Yeniden bağlanma denemesi ${attempt}/${config.maxReconnectAttempts}`);
  broadcast(username, "reconnecting", { attempt, maxAttempts: config.maxReconnectAttempts });

  const delay = Math.min(1000 * 2 ** (attempt - 1), 30000);
  await new Promise((resolve) => setTimeout(resolve, delay));

  try {
    const state = await room.connection.connect();
    room.state = state;
    room.lastActive = Date.now();
    room.reconnectAttempts = 0;
    log.info(username, `Yeniden bağlandı (roomId ${state.roomId})`);
    broadcast(username, "reconnected", { roomId: state.roomId, attempt });
    return true;
  } catch (err) {
    log.error(username, `Yeniden bağlanma ${attempt} başarısız`, err);
    return attemptReconnect(username, attempt + 1);
  }
}

/** Kullanıcı için TikTok bağlantısı oluştur (veya mevcut odayı döndür). */
export async function createConnection(username, options = {}) {
  const existing = rooms.get(username);
  if (existing) {
    existing.lastActive = Date.now();
    return existing;
  }

  if (rooms.size >= config.maxTotalRooms) {
    throw new Error(`Sunucu oda limitine ulaşıldı (${config.maxTotalRooms})`);
  }

  log.info(username, "Yeni bağlantı oluşturuluyor");

  const connection = new TikTokLiveConnection(username, {
    enableExtendedGiftInfo: true,
    processInitialData: false,
    ...options,
  });

  const room = {
    username,
    connection,
    clients: new Set(),
    state: null,
    lastActive: Date.now(),
    cleanupTimer: null,
    reconnectAttempts: 0,
    history: [],
    leaderboard: new Map(),
    stats: {
      chatMessages: 0,
      gifts: 0,
      likes: 0,
      follows: 0,
      shares: 0,
      joins: 0,
      diamonds: 0,
      viewers: 0,
    },
  };

  rooms.set(username, room);
  stats.totalConnections++;

  /** Olay yayınlayıcı yardımcısı: yayınla + geçmişe kaydet + sayaç. */
  const emit = (event, data) => {
    room.lastActive = Date.now();
    pushHistory(room, event, data);
    broadcast(username, event, data);
  };

  connection.connect().then((state) => {
    room.state = state;
    room.lastActive = Date.now();
    log.info(username, `Bağlandı (roomId ${state.roomId})`);
    emit("connected", { roomId: state.roomId, roomInfo: state.roomInfo ?? null });
  }).catch((err) => {
    log.error(username, "İlk bağlantı başarısız", err);
    emit("error", { message: err?.message ?? String(err), type: "connection_error" });
  });

  // ---- Kontrol olayları ----
  connection.on(ControlEvent.CONNECTED, (s) => {
    room.state = s;
    room.lastActive = Date.now();
    log.info(username, "Kontrol: CONNECTED");
  });

  connection.on(ControlEvent.DISCONNECTED, () => {
    log.warn(username, "WebSocket bağlantısı kesildi");
    emit("disconnected", { message: "WebSocket bağlantısı kesildi" });
    if (room.clients.size > 0) attemptReconnect(username);
    else scheduleCleanup(username);
  });

  connection.on(ControlEvent.ERROR, (err) => {
    log.error(username, "Kontrol hatası", err);
    emit("error", { message: err?.message ?? String(err), type: "control_error" });
  });

  connection.on(ControlEvent.STREAM_END, () => {
    log.info(username, "Yayın sona erdi");
    emit("stream_ended", { message: "Canlı yayın sona erdi" });
  });

  // ---- Yayın olayları ----
  connection.on(WebcastEvent.CHAT, (data) => {
    room.stats.chatMessages++;
    emit("chat", {
      type: "chat",
      user: slimUser(data.user),
      comment: data.comment,
      userBadge: data.user?.badge ?? null,
    });
  });

  connection.on(WebcastEvent.GIFT, (data) => {
    const repeat = data.repeatCount ?? 1;
    room.stats.gifts += repeat;
    room.stats.diamonds += (data.diamondCount ?? 0) * repeat;
    trackGifter(room, data);
    emit("gift", {
      type: "gift",
      user: slimUser(data.user),
      giftName: data.giftName,
      giftId: data.giftId,
      repeatCount: data.repeatCount,
      repeatEnd: data.repeatEnd,
      giftType: data.giftType,
      diamondCount: data.diamondCount,
    });
  });

  connection.on(WebcastEvent.MEMBER, (data) => {
    room.stats.joins++;
    emit("member", { type: "member", user: slimUser(data.user) });
  });

  connection.on(WebcastEvent.LIKE, (data) => {
    room.stats.likes += data.likeCount || 1;
    emit("like", {
      type: "like",
      user: slimUser(data.user),
      likeCount: data.likeCount,
      totalLikeCount: data.totalLikeCount,
    });
  });

  connection.on(WebcastEvent.FOLLOW, (data) => {
    room.stats.follows++;
    emit("follow", { type: "follow", user: slimUser(data.user) });
  });

  connection.on(WebcastEvent.SHARE, (data) => {
    room.stats.shares++;
    emit("share", { type: "share", user: slimUser(data.user) });
  });

  connection.on(WebcastEvent.ROOM_USER, (data) => {
    room.stats.viewers = data.viewerCount ?? room.stats.viewers;
    emit("room_user", { type: "room_user", viewerCount: data.viewerCount });
  });

  connection.on(WebcastEvent.QUESTION, (data) => {
    emit("question", { type: "question", data: data.question ?? data });
  });

  return room;
}
