const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');

function signToken(payload) {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN_SECONDS });
}

function verifyToken(token) {
  return jwt.verify(token, config.JWT_SECRET);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { signToken, verifyToken, hashToken };
