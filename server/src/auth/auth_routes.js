const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const sgMail = require('@sendgrid/mail');
const pool = require('../db/pool');
const config = require('../config');
const { signToken, hashToken } = require('./auth_tokens');
const { limiter } = require('./ratelimit');

if (config.SENDGRID_API_KEY) {
  sgMail.setApiKey(config.SENDGRID_API_KEY);
}

const router = Router();
const SALT_ROUNDS = 12;

// In-memory test accounts for local dev (no DB)
const _testAccounts = {};
(async function _initTestAccounts() {
  const h1 = await bcrypt.hash('testtest', SALT_ROUNDS);
  const h2 = await bcrypt.hash('testtest', SALT_ROUNDS);
  _testAccounts['test@test.com'] = { account_id: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', display_name: 'Player1', password_hash: h1, is_guest: false };
  _testAccounts['test2@test.com'] = { account_id: 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', display_name: 'Player2', password_hash: h2, is_guest: false };
  console.log('[auth] test accounts loaded (no-DB mode): test@test.com, test2@test.com');
})();

function clientIp(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
}

let _dbAvailable = null;
async function checkDb() {
  if (_dbAvailable !== null) return _dbAvailable;
  try { await pool.query('SELECT 1'); _dbAvailable = true; } catch { _dbAvailable = false; }
  return _dbAvailable;
}

async function createSession(accountId, token, req) {
  const dbOk = await checkDb();
  if (!dbOk) return;
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.JWT_EXPIRES_IN_SECONDS * 1000);
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';
  await pool.query(
    `INSERT INTO sessions (account_id, refresh_token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [accountId, tokenHash, expiresAt, ip, ua]
  );
}

router.post('/guest', async (req, res) => {
  try {
    const ip = clientIp(req);
    const rl = limiter.consume('ip:guest:' + ip);
    if (!rl.ok) {
      return res.status(429).json({ error: 'Too many guest creations', retryAfterMs: rl.retryAfterMs });
    }

    const tag = crypto.randomBytes(4).toString('hex');
    const displayName = 'Guest_' + tag;

    const dbOk = await checkDb();
    let accountId;
    if (dbOk) {
      const result = await pool.query(
        `INSERT INTO accounts (is_guest, display_name) VALUES (TRUE, $1) RETURNING account_id, display_name`,
        [displayName]
      );
      accountId = result.rows[0].account_id;
      const token = signToken({ sub: accountId, is_guest: true, dn: result.rows[0].display_name });
      await createSession(accountId, token, req);
      return res.status(201).json({
        token,
        user: { id: accountId, displayName: result.rows[0].display_name, isGuest: true },
      });
    }

    // In-memory fallback when no DB is available
    accountId = crypto.randomUUID();
    const token = signToken({ sub: accountId, is_guest: true, dn: displayName });
    console.log('[auth] guest created in-memory (no DB):', accountId);
    res.status(201).json({
      token,
      user: { id: accountId, displayName, isGuest: true },
    });
  } catch (e) {
    console.error('[auth] guest error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/register', async (req, res) => {
  try {
    const ip = clientIp(req);
    const rl = limiter.consume('ip:reg:' + ip);
    if (!rl.ok) {
      return res.status(429).json({ error: 'Too many registrations', retryAfterMs: rl.retryAfterMs });
    }

    const { displayName, email, password } = req.body;
    if (!displayName || !email || !password) {
      return res.status(400).json({ error: 'displayName, email, and password are required' });
    }
    if (displayName.length < 3 || displayName.length > 64) {
      return res.status(400).json({ error: 'displayName must be 3-64 characters' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO accounts (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING account_id, display_name`,
      [email.trim().toLowerCase(), passwordHash, displayName.trim()]
    );
    const account = result.rows[0];
    const token = signToken({ sub: account.account_id, is_guest: false, dn: account.display_name });
    await createSession(account.account_id, token, req);

    res.status(201).json({
      token,
      user: { id: account.account_id, displayName: account.display_name, isGuest: false },
    });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Email already taken' });
    }
    console.error('[auth] register error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const ip = clientIp(req);
    const rl = limiter.consume('ip:login:' + ip);
    if (!rl.ok) {
      return res.status(429).json({ error: 'Too many login attempts', retryAfterMs: rl.retryAfterMs });
    }

    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const dbOk = await checkDb();
    let account;
    if (dbOk) {
      const result = await pool.query(
        `SELECT account_id, display_name, password_hash FROM accounts WHERE email = $1 AND is_guest = FALSE`,
        [email.trim().toLowerCase()]
      );
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      account = result.rows[0];
    } else {
      account = _testAccounts[email.trim().toLowerCase()];
      if (!account) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
    }
    const match = await bcrypt.compare(password, account.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({ sub: account.account_id, is_guest: false, dn: account.display_name });
    await createSession(account.account_id, token, req);

    res.json({
      token,
      user: { id: account.account_id, displayName: account.display_name, isGuest: false },
    });
  } catch (e) {
    console.error('[auth] login error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing token' });
    }
    const token = header.slice(7);
    const tokenHash = hashToken(token);
    const dbOk = await checkDb();
    if (dbOk) {
      await pool.query(
        `UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth] logout error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Forgot password: send reset link via email ─────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const ip = clientIp(req);
    const rl = limiter.consume('ip:reset:' + ip);
    if (!rl.ok) {
      return res.status(429).json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs });
    }

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const genericMsg = 'If an account with that email exists, a reset link has been sent.';

    const dbOk = await checkDb();
    if (!dbOk) {
      return res.json({ message: genericMsg });
    }

    const result = await pool.query(
      `SELECT account_id FROM accounts WHERE email = $1 AND is_guest = FALSE`,
      [email.trim().toLowerCase()]
    );
    if (result.rows.length === 0) {
      return res.json({ message: genericMsg });
    }

    const accountId = result.rows[0].account_id;
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await pool.query(
      `INSERT INTO password_resets (account_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [accountId, tokenHash, expiresAt]
    );

    const resetUrl = config.APP_URL + '?resetToken=' + rawToken;

    if (config.SENDGRID_API_KEY) {
      try {
        await sgMail.send({
          to: email.trim().toLowerCase(),
          from: config.SENDGRID_FROM_EMAIL,
          subject: 'Sewer Showdown - Password Reset',
          text: 'You requested a password reset.\n\nClick this link to set a new password (expires in 15 minutes):\n\n' + resetUrl + '\n\nIf you did not request this, you can ignore this email.',
          html: '<p>You requested a password reset.</p><p>Click the link below to set a new password (expires in 15 minutes):</p><p><a href="' + resetUrl + '">' + resetUrl + '</a></p><p>If you did not request this, you can ignore this email.</p>',
        });
      } catch (emailErr) {
        console.error('[auth] SendGrid error:', emailErr.message);
      }
    } else {
      console.log('[auth] SENDGRID_API_KEY not set — reset link for ' + email + ': ' + resetUrl);
    }

    res.json({ message: genericMsg });
  } catch (e) {
    console.error('[auth] forgot-password error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Reset password: consume token + update password ────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const ip = clientIp(req);
    const rl = limiter.consume('ip:reset:' + ip);
    if (!rl.ok) {
      return res.status(429).json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs });
    }

    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'token and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const dbOk = await checkDb();
    if (!dbOk) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const tokenHash = hashToken(token);
    const result = await pool.query(
      `SELECT reset_id, account_id FROM password_resets
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [tokenHash]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    const { reset_id, account_id } = result.rows[0];
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    await pool.query('UPDATE accounts SET password_hash = $1 WHERE account_id = $2', [passwordHash, account_id]);
    await pool.query('UPDATE password_resets SET used_at = now() WHERE reset_id = $1', [reset_id]);

    res.json({ message: 'Password updated successfully' });
  } catch (e) {
    console.error('[auth] reset-password error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
