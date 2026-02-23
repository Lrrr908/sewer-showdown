// js/shared/errors.js — Structured error system for validators and Data Bus
// Pure factory. No side effects.

var SEVERITY = Object.freeze({ error: 'error', warn: 'warn', info: 'info' });

function err(code, severity, path, msg) {
    return { code: code, severity: severity, path: path, msg: msg };
}

// Stable error code prefixes:
//   PAT_  — pattern validation
//   ART_  — artist validation
//   BLD_  — building validation
//   LVL_  — level validation
//   REG_  — region validation
//   WLD_  — world validation
//   BUS_  — data bus ops
//   VER_  — versioning

if (typeof module !== 'undefined') module.exports = { SEVERITY: SEVERITY, err: err };
