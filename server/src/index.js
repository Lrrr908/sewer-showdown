const http = require('http');
const path = require('path');
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
const igPublicRoutes = require('./routes/ig_public');
const igAdminRoutes  = require('./routes/ig_admin');
const { refreshOEmbedAll } = require('./ig/refresh_job');
const { CACHE_DIR }        = require('./ig/thumb_cache');
const { initWsServer } = require('./realtime/ws_server');
const { startSimLoop, stopSimLoop } = require('./realtime/sim_tick');
const zoneDir = require('./zones/zone_directory');

const app = express();
const bootTime = Date.now();

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
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
    instance: config.INSTANCE_ID,
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

app.use('/ig',       igPublicRoutes);
app.use('/ig-admin', igAdminRoutes);

app.get('/admin/ig', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'ig.html'));
});

app.use('/ig-thumbs', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  const file = path.join(CACHE_DIR, path.basename(req.path));
  res.sendFile(file, err => { if (err) res.status(404).end(); });
});

app.get('/debug/zones', (_req, res) => {
  const sim = require('./realtime/sim_tick');
  const zones = {};
  for (const [zid, zone] of sim.zoneManager.zones) {
    const players = [];
    for (const [eid, entity] of zone.entities) {
      players.push({
        id: eid,
        account: entity.accountId,
        dn: entity.displayName,
        x: entity.x, y: entity.y,
        px: entity.px, py: entity.py,
        facing: entity.facing,
        mode: entity.mode,
        wsOpen: zone.conns.has(eid) && zone.conns.get(eid).readyState === 1,
        aoiCell: zone.aoi.playerCells.get(eid) || 'none',
      });
    }
    zones[zid] = {
      playerCount: zone.playerCount,
      entityCount: zone.entities.size,
      connCount: zone.conns.size,
      aoiCellCount: zone.aoi.cells.size,
      boundsW: zone.boundsW,
      boundsH: zone.boundsH,
      players,
    };
  }
  res.json({ ok: true, tick: sim.tickCount, instance: config.INSTANCE_ID, zones });
});

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

  try {
    const migrate = require('./db/migrate');
    await migrate();
    console.log('[db] migrations complete');
  } catch (e) {
    console.warn('[db] migrations skipped:', e.message);
  }

  zoneDir.start();
  startSimLoop();

  if (process.env.OEMBED_BOOT_REFRESH !== '0') {
    setTimeout(() => {
      refreshOEmbedAll()
        .then(r => console.log('[ig] boot refresh:', r.ok, 'ok', r.fail, 'fail'))
        .catch(e => console.warn('[ig] boot refresh error:', e.message));
    }, 5000);
  }

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
