const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');
const config = require('./config');
const pool = require('./db/pool');
const { PROTOCOL_VERSION } = require('./protocol/version');
const authRoutes = require('./auth/auth_routes');
const authMiddleware = require('./auth/auth_middleware');
const ugcRoutes = require('./ugc/ugc_routes');
const { initWsServer } = require('./realtime/ws_server');
const { startSimLoop, stopSimLoop } = require('./realtime/sim_tick');
const zoneDir = require('./zones/zone_directory');

const app = express();
const bootTime = Date.now();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res) => {
  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch {}
  res.json({
    ok: true,
    v: PROTOCOL_VERSION,
    db: dbOk,
    dirStale: zoneDir.isStale(),
    uptime: (Date.now() - bootTime) / 1000,
  });
});

app.get('/zones', (_req, res) => {
  const snap = zoneDir.getSnapshot();
  if (!snap) {
    return res.status(503).json({ ok: false, error: 'directory not ready' });
  }
  res.json({
    ok: true,
    v: PROTOCOL_VERSION,
    zones: {
      world: snap.world,
      region: snap.region,
      level: snap.level,
    },
  });
});

app.use('/auth', authRoutes);
app.use('/ugc', authMiddleware, ugcRoutes);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
initWsServer(wss);

async function boot() {
  try {
    await pool.query('SELECT 1');
    console.log('[db] connected');
  } catch (e) {
    console.warn('[db] not available, running without database:', e.message);
  }

  zoneDir.start();
  startSimLoop();

  server.listen(config.PORT, () => {
    console.log(`[server] listening on :${config.PORT} (${config.NODE_ENV}) protocol v${PROTOCOL_VERSION}`);
  });
}

boot();

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down');
  zoneDir.stop();
  stopSimLoop();
  server.close(() => {
    pool.end();
    process.exit(0);
  });
});
