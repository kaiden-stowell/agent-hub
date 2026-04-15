'use strict';
// Local-hub discovery.
//
// Scans a set of well-known localhost ports for sibling "hubs" that expose
// a GET /api/integration-manifest endpoint. Cached manifests are injected
// into every agent prompt via runner.js's buildIntegrationsContext, so any
// agent can talk to any discovered hub through plain curl — no cross-process
// glue required beyond Claude Code's Bash tool.
//
// Example: instagram-hub runs on 127.0.0.1:12790, responds to
//   GET /api/integration-manifest
// with { name, desc, usage, base_url, endpoints, ... }.

const http = require('http');

// (port, path) pairs to probe. Add new hubs here as they ship.
const KNOWN_HUBS = [
  { port: 12790, path: '/api/integration-manifest', label: 'instagram-hub' },
];

let _cache = [];         // latest successful manifests
let _broadcast = null;
let _refreshTimer = null;
const REFRESH_MS = 60_000;

function setBroadcast(fn) { _broadcast = fn; }

function _getJson(port, path, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: timeoutMs,
    }, r => {
      if (r.statusCode !== 200) { reject(new Error(`http ${r.statusCode}`)); r.resume(); return; }
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function refresh() {
  const found = [];
  for (const h of KNOWN_HUBS) {
    try {
      const m = await _getJson(h.port, h.path);
      if (m && (m.name || m.usage)) {
        found.push({
          label: h.label,
          name: m.name || h.label,
          desc: m.desc || m.description || '',
          usage: m.usage || '',
          base_url: m.base_url || `http://127.0.0.1:${h.port}`,
          version: m.version,
          mode: m.mode,
          status: m.status,
        });
      }
    } catch {
      // hub not running or not responding — skip quietly
    }
  }
  const changed = JSON.stringify(found.map(h => h.label + h.version)) !==
                  JSON.stringify(_cache.map(h => h.label + h.version));
  _cache = found;
  if (changed && _broadcast) _broadcast('local-hubs:updated', { hubs: found.map(h => ({ label: h.label, name: h.name, version: h.version, mode: h.mode })) });
  return found;
}

function getAll() { return _cache; }

function start() {
  refresh().catch(() => {});
  _refreshTimer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
}

function stop() {
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = null;
}

module.exports = { start, stop, refresh, getAll, setBroadcast };
