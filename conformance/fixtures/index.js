'use strict';
// The example requests of ../../PROTOCOL.md, ready to send: {project} and {key} are filled in from a DSN.
const fs = require('fs');
const path = require('path');

/**
 * @param {string} name file name without .json
 * @param {{ project: number | string, key: string }} dsn
 * @returns {{ method: string, path: string, query: Record<string, string>, headers: Record<string, string>, body: Buffer }}
 */
function load(name, dsn) {
  const raw = fs.readFileSync(path.join(__dirname, `${name}.json`), 'utf8').replaceAll('{project}', String(dsn.project)).replaceAll('{key}', dsn.key);
  const f = JSON.parse(raw);
  const body = f.envelope ? `${f.envelope.map((l) => JSON.stringify(l)).join('\n')}\n` : JSON.stringify(f.json);
  return { method: f.method, path: f.path, query: f.query || {}, headers: f.headers || {}, body: Buffer.from(body) };
}

const names = fs.readdirSync(__dirname).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort();

module.exports = { load, names };
