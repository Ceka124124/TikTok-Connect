// index.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import helmet from "helmet";
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from "tiktok-live-connector";

const PORT = process.env.PORT || 3000;
const CLEANUP_TIMEOUT = parseInt(process.env.CLEANUP_TIMEOUT) || 5 * 60 * 1000; // 5 minutes
const MAX_RECONNECT_ATTEMPTS = 3;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

const app = express();

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  credentials: true
}));
app.use(bodyParser.json());

// Enhanced room structure with statistics and reconnection logic
const rooms = new Map();

// Statistics tracking
const stats = {
  totalConnections: 0,
  totalMessages: 0,
  activeRooms: () => rooms.size,
  startTime: Date.now()
};

// Logger utility
const logger = {
  info: (username, message, data = {}) => {
    console.log(`[${new Date().toISOString()}] [${username}] INFO: ${message}`, data);
  },
  error: (username, message, error = {}) => {
    console.error(`[${new Date().toISOString()}] [${username}] ERROR: ${message}`, error?.message || error);
  },
  warn: (username, message, data = {}) => {
    console.warn(`[${new Date().toISOString()}] [${username}] WARN: ${message}`, data);
  }
};

// Helper: send SSE message with error handling
function sseSend(res, event, data) {
  if (res.destroyed || res.writableEnded) return false;
  
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch (e) {
    logger.error('sse', 'Failed to send SSE message', e);
    return false;
  }
}

// Broadcast to all SSE clients of a room
function broadcast(username, event, data) {
  const room = rooms.get(username);
  if (!room) return;

  stats.totalMessages++;
  
  const deadClients = [];
  for (const res of room.clients) {
    const sent = sseSend(res, event, data);
    if (!sent) deadClients.push(res);
  }

  // Clean up dead clients
  deadClients.forEach(res => room.clients.delete(res));
  
  if (deadClients.length > 0) {
    logger.warn(username, `Removed ${deadClients.length} dead clients`);
  }
}

// Setup heartbeat for SSE connection
function setupHeartbeat(username, res) {
  const heartbeat = setInterval(() => {
    const sent = sseSend(res, 'heartbeat', { timestamp: Date.now() });
    if (!sent) {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_INTERVAL);

  res.on('close', () => clearInterval(heartbeat));
  return heartbeat;
}

// Cleanup room if no clients
function scheduleCleanup(username) {
  const room = rooms.get(username);
  if (!room) return;

  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  if (room.clients.size === 0) {
    logger.info(username, `Scheduling cleanup in ${CLEANUP_TIMEOUT}ms`);
    
    room.cleanupTimer = setTimeout(async () => {
      try {
        if (room.connection && room.connection.isConnected) {
          await room.connection.disconnect();
        }
        rooms.delete(username);
        logger.info(username, 'Room cleaned up due to inactivity');
      } catch (e) {
        logger.error(username, 'Error during cleanup', e);
      }
    }, CLEANUP_TIMEOUT);
  }
}

// Reconnection logic
async function attemptReconnect(username, attempt = 1) {
  const room = rooms.get(username);
  if (!room || attempt > MAX_RECONNECT_ATTEMPTS) {
    if (room) {
      logger.error(username, `Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
      broadcast(username, 'connection_failed', { 
        message: 'Failed to reconnect after multiple attempts' 
      });
    }
    return false;
  }

  logger.info(username, `Reconnection attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}`);
  broadcast(username, 'reconnecting', { attempt, maxAttempts: MAX_RECONNECT_ATTEMPTS });

  const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
  
  await new Promise(resolve => setTimeout(resolve, backoffDelay));

  try {
    const state = await room.connection.connect();
    room.state = state;
    room.lastActive = Date.now();
    room.reconnectAttempts = 0;
    
    logger.info(username, `Reconnected successfully to roomId ${state.roomId}`);
    broadcast(username, 'reconnected', {
      roomId: state.roomId,
      attempt
    });
    
    return true;
  } catch (err) {
    logger.error(username, `Reconnection attempt ${attempt} failed`, err);
    return attemptReconnect(username, attempt + 1);
  }
}

// Create and attach a TikTok connection for username
async function createConnection(username, options = {}) {
  if (rooms.has(username)) {
    const room = rooms.get(username);
    room.lastActive = Date.now();
    return room;
  }

  logger.info(username, 'Creating new connection');

  const connection = new TikTokLiveConnection(username, {
    enableExtendedGiftInfo: true,
    processInitialData: false,
    ...options
  });

  const roomObj = {
    connection,
    clients: new Set(),
    state: null,
    lastActive: Date.now(),
    cleanupTimer: null,
    reconnectAttempts: 0,
    stats: {
      chatMessages: 0,
      gifts: 0,
      likes: 0,
      joins: 0,
      follows: 0
    }
  };
  
  rooms.set(username, roomObj);
  stats.totalConnections++;

  // Connect and attach events
  connection.connect()
    .then(state => {
      roomObj.state = state;
      roomObj.lastActive = Date.now();
      
      logger.info(username, `Connected to roomId ${state.roomId}`);
      
      broadcast(username, 'connected', {
        roomId: state.roomId,
        roomInfo: state.roomInfo ?? null,
        timestamp: Date.now()
      });
    })
    .catch(err => {
      logger.error(username, 'Initial connection failed', err);
      broadcast(username, 'error', { 
        message: err?.message ?? String(err),
        type: 'connection_error'
      });
    });

  // Control events
  connection.on(ControlEvent.CONNECTED, (s) => {
    roomObj.state = s;
    roomObj.lastActive = Date.now();
    logger.info(username, 'Control event: CONNECTED');
  });

  connection.on(ControlEvent.DISCONNECTED, () => {
    logger.warn(username, 'WebSocket disconnected');
    broadcast(username, 'disconnected', { 
      message: 'WebSocket disconnected',
      timestamp: Date.now()
    });
    
    // Attempt reconnection if there are active clients
    if (roomObj.clients.size > 0) {
      attemptReconnect(username);
    } else {
      scheduleCleanup(username);
    }
  });

  connection.on(ControlEvent.ERROR, (err) => {
    logger.error(username, 'Control error', err);
    broadcast(username, 'error', { 
      message: err?.message ?? String(err),
      type: 'control_error'
    });
  });

  connection.on(ControlEvent.STREAM_END, () => {
    logger.info(username, 'Stream ended');
    broadcast(username, 'stream_ended', { 
      message: 'Live stream has ended',
      timestamp: Date.now()
    });
  });

  // Webcast events
  connection.on(WebcastEvent.CHAT, (data) => {
    roomObj.lastActive = Date.now();
    roomObj.stats.chatMessages++;
    
    broadcast(username, 'chat', {
      type: 'chat',
      user: {
        uniqueId: data.user?.uniqueId,
        nickname: data.user?.nickname,
        profilePictureUrl: data.user?.profilePictureUrl
      },
      comment: data.comment,
      timestamp: Date.now()
    });
  });

  connection.on(WebcastEvent.GIFT, (data) => {
    roomObj.lastActive = Date.now();
    roomObj.stats.gifts++;
    
    broadcast(username, 'gift', {
      type: 'gift',
      user: {
        uniqueId: data.user?.uniqueId,
        nickname: data.user?.nickname,
        profilePictureUrl: data.user?.profilePictureUrl
      },
      giftName: data.giftName,
      giftId: data.giftId,
      repeatCount: data.repeatCount,
      repeatEnd: data.repeatEnd,
      giftType: data.giftType,
      diamondCount: data.diamondCount,
      timestamp: Date.now()
    });
  });

  connection.on(WebcastEvent.MEMBER, (data) => {
    roomObj.lastActive = Date.now();
    roomObj.stats.joins++;
    
    broadcast(username, 'member', {
      type: 'member',
      user: {
        uniqueId: data.user?.uniqueId,
        nickname: data.user?.nickname,
        profilePictureUrl: data.user?.profilePictureUrl
      },
      timestamp: Date.now()
    });
  });

  connection.on(WebcastEvent.LIKE, (data) => {
    roomObj.lastActive = Date.now();
    roomObj.stats.likes += data.likeCount || 1;
    
    broadcast(username, 'like', {
      type: 'like',
      user: data.user ? {
        uniqueId: data.user.uniqueId,
        nickname: data.user.nickname
      } : null,
      likeCount: data.likeCount,
      totalLikeCount: data.totalLikeCount,
      timestamp: Date.now()
    });
  });

  connection.on(WebcastEvent.FOLLOW, (data) => {
    roomObj.lastActive = Date.now();
    roomObj.stats.follows++;
    
    broadcast(username, 'follow', {
      type: 'follow',
      user: {
        uniqueId: data.user?.uniqueId,
        nickname: data.user?.nickname,
        profilePictureUrl: data.user?.profilePictureUrl
      },
      timestamp: Date.now()
    });
  });

  connection.on(WebcastEvent.SHARE, (data) => {
    roomObj.lastActive = Date.now();
    
    broadcast(username, 'share', {
      type: 'share',
      user: data.user ? {
        uniqueId: data.user.uniqueId,
        nickname: data.user.nickname
      } : null,
      timestamp: Date.now()
    });
  });

  connection.on(WebcastEvent.ROOM_USER, (data) => {
    roomObj.lastActive = Date.now();
    
    broadcast(username, 'room_user', {
      type: 'room_user',
      viewerCount: data.viewerCount,
      topViewers: data.topViewers,
      timestamp: Date.now()
    });
  });

  return roomObj;
}

// API: Connect to username
app.post("/api/connect", async (req, res) => {
  const { username } = req.body || {};
  
  if (!username || typeof username !== "string") {
    return res.status(400).json({ error: "username is required and must be a string" });
  }

  try {
    const roomObj = await createConnection(username);
    
    res.json({
      success: true,
      message: "Connection requested",
      username,
      isConnected: roomObj.connection?.isConnected ?? false,
      clientCount: roomObj.clients.size
    });
  } catch (e) {
    logger.error(username, 'Failed to create connection', e);
    res.status(500).json({ 
      success: false,
      error: e?.message ?? String(e) 
    });
  }
});

// API: Disconnect username
app.post("/api/disconnect", async (req, res) => {
  const { username } = req.body || {};
  
  if (!username) {
    return res.status(400).json({ error: "username is required" });
  }

  const room = rooms.get(username);
  
  if (!room) {
    return res.status(404).json({ error: "Room not connected" });
  }

  try {
    // Notify all clients
    broadcast(username, 'force_disconnect', { 
      message: 'Connection closed by server' 
    });

    // Close all client connections
    for (const client of room.clients) {
      try {
        client.end();
      } catch (e) {}
    }

    // Disconnect TikTok connection
    if (room.connection && room.connection.isConnected) {
      await room.connection.disconnect();
    }

    // Clear cleanup timer
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
    }

    rooms.delete(username);
    logger.info(username, 'Manually disconnected');

    res.json({
      success: true,
      message: "Disconnected successfully",
      username
    });
  } catch (e) {
    logger.error(username, 'Error during disconnect', e);
    res.status(500).json({ 
      success: false,
      error: e?.message ?? String(e) 
    });
  }
});

// API: Get room status
app.get("/api/status/:username", (req, res) => {
  const { username } = req.params;
  const room = rooms.get(username);

  if (!room) {
    return res.status(404).json({ 
      connected: false,
      message: "Room not found" 
    });
  }

  res.json({
    connected: room.connection?.isConnected ?? false,
    clientCount: room.clients.size,
    roomId: room.state?.roomId ?? null,
    lastActive: room.lastActive,
    stats: room.stats,
    uptime: Date.now() - room.lastActive
  });
});

// API: Get all rooms status
app.get("/api/rooms", (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([username, room]) => ({
    username,
    connected: room.connection?.isConnected ?? false,
    clientCount: room.clients.size,
    roomId: room.state?.roomId ?? null,
    lastActive: room.lastActive,
    stats: room.stats
  }));

  res.json({
    rooms: roomList,
    totalRooms: rooms.size,
    serverStats: {
      ...stats,
      uptime: Date.now() - stats.startTime
    }
  });
});

// SSE endpoint: Subscribe to events for username
app.get("/events/:username", async (req, res) => {
  const username = req.params.username;
  
  if (!username) {
    return res.status(400).json({ error: "username parameter is required" });
  }

  // Setup SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.flushHeaders?.();

  logger.info(username, 'SSE client connecting');

  // Send initial connection message
  sseSend(res, 'connected', {
    message: "SSE connected",
    username,
    timestamp: Date.now()
  });

  try {
    const roomObj = await createConnection(username);
    roomObj.clients.add(res);
    
    logger.info(username, `SSE client connected. Total clients: ${roomObj.clients.size}`);

    // Cancel cleanup if scheduled
    if (roomObj.cleanupTimer) {
      clearTimeout(roomObj.cleanupTimer);
      roomObj.cleanupTimer = null;
    }

    // Setup heartbeat
    setupHeartbeat(username, res);

    // Send current room state if available
    if (roomObj.state) {
      sseSend(res, 'room_state', {
        roomId: roomObj.state.roomId,
        roomInfo: roomObj.state.roomInfo,
        stats: roomObj.stats,
        timestamp: Date.now()
      });
    }

    // Handle client disconnect
    req.on("close", () => {
      try {
        roomObj.clients.delete(res);
        logger.info(username, `SSE client disconnected. Remaining: ${roomObj.clients.size}`);
        
        // Schedule cleanup if no clients remain
        if (roomObj.clients.size === 0) {
          scheduleCleanup(username);
        }
      } catch (e) {
        logger.error(username, 'Error handling client disconnect', e);
      }
    });

    req.on("error", (err) => {
      logger.error(username, 'SSE request error', err);
      roomObj.clients.delete(res);
    });

  } catch (err) {
    logger.error(username, 'Failed to setup SSE connection', err);
    sseSend(res, 'error', {
      message: err?.message ?? String(err),
      type: 'setup_error'
    });
    res.end();
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: Date.now() - stats.startTime,
    stats: {
      ...stats,
      activeRooms: stats.activeRooms(),
      memoryUsage: process.memoryUsage()
    }
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    service: "TikTok Live SSE Proxy",
    version: "2.0.0",
    endpoints: {
      connect: "POST /api/connect",
      disconnect: "POST /api/disconnect",
      status: "GET /api/status/:username",
      rooms: "GET /api/rooms",
      events: "GET /events/:username",
      health: "GET /health"
    },
    activeRooms: Array.from(rooms.keys()),
    stats: {
      ...stats,
      activeRooms: stats.activeRooms()
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('app', 'Unhandled error', err);
  res.status(500).json({
    error: "Internal server error",
    message: err?.message ?? String(err)
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('server', 'SIGTERM received, shutting down gracefully');
  
  for (const [username, room] of rooms.entries()) {
    try {
      broadcast(username, 'server_shutdown', { 
        message: 'Server is shutting down' 
      });
      
      if (room.connection && room.connection.isConnected) {
        await room.connection.disconnect();
      }
    } catch (e) {
      logger.error(username, 'Error during shutdown', e);
    }
  }
  
  process.exit(0);
});

app.listen(PORT, () => {
  logger.info('server', `Server started on port ${PORT}`);
  console.log(`
╔═══════════════════════════════════════════╗
║  TikTok Live SSE Proxy Server Started     ║
║  Port: ${PORT}                              ║
║  Environment: ${process.env.NODE_ENV || 'development'}              ║
╚═══════════════════════════════════════════╝
  `);
});