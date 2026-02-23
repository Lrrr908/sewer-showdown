require('dotenv').config();

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost:5432/sewer_showdown',

  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-me',
  JWT_EXPIRES_IN_SECONDS: parseInt(process.env.JWT_EXPIRES_IN_SECONDS, 10) || 3600,

  WS_PING_INTERVAL_MS: parseInt(process.env.WS_PING_INTERVAL_MS, 10) || 25000,
  WS_PONG_TIMEOUT_MS: parseInt(process.env.WS_PONG_TIMEOUT_MS, 10) || 10000,

  TICK_HZ: parseInt(process.env.TICK_HZ, 10) || 20,
  get TICK_MS() { return Math.floor(1000 / this.TICK_HZ); },

  AOI_CELL_SIZE_TILES: parseInt(process.env.AOI_CELL_SIZE_TILES, 10) || 16,

  UGC_MAX_WIDTH: parseInt(process.env.UGC_MAX_WIDTH, 10) || 64,
  UGC_MAX_HEIGHT: parseInt(process.env.UGC_MAX_HEIGHT, 10) || 64,
  UGC_MASS_TOLERANCE: parseFloat(process.env.UGC_MASS_TOLERANCE) || 0.90,
  UGC_SUBMIT_RATE_LIMIT_PER_MIN: parseInt(process.env.UGC_SUBMIT_RATE_LIMIT_PER_MIN, 10) || 3,
  UGC_SUBMIT_RATE_WINDOW_MS: parseInt(process.env.UGC_SUBMIT_RATE_WINDOW_MS, 10) || 60000,

  ALLOW_WORLD_LEVEL_TELEPORT: process.env.ALLOW_WORLD_LEVEL_TELEPORT === 'true' ||
    (process.env.NODE_ENV || 'development') !== 'production',

  GUEST_RATE_LIMIT_PER_MIN: parseInt(process.env.GUEST_RATE_LIMIT_PER_MIN, 10) || 10,
  LOGIN_RATE_LIMIT_PER_MIN: parseInt(process.env.LOGIN_RATE_LIMIT_PER_MIN, 10) || 10,
  REGISTER_RATE_LIMIT_PER_MIN: parseInt(process.env.REGISTER_RATE_LIMIT_PER_MIN, 10) || 5,
};

// Build identifier for deploy verification
module.exports.BUILD_HASH = "routing-fix";
