#!/usr/bin/env node
'use strict';
// A stand-in for devbord that checks everything an integration sends. No dependencies (Node 18+).
//
//   node server.js [--port 4700] [--status 429]
//
// Point the integration at the DSN it prints, trigger an error and a heartbeat, and read the verdict per request.
// Stop with Ctrl-C for a summary; the exit code is 1 when a request broke the protocol.
// --status answers every request with that status instead of 200, to see how the integration copes with a refusal.
const http = require('http');
const crypto = require('crypto');
const { checkRequest } = require('./check');

const MAX_BODY = 12 * 1024 * 1024;
const BURST = 60;
const REPEAT = 5;

/**
 * @typedef {{ at: number, request: import('./check').IngestRequest, result: import('./check').CheckResult }} Received
 */

/**
 * Starts the stand-in.
 * @param {{ port?: number, status?: number, onRequest?: (r: Received) => void }} [o]
 * @returns {Promise<{ dsn: string, port: number, received: Received[], summary: () => { requests: number, events: number, checkIns: number, errors: number, warnings: string[] }, close: () => Promise<void> }>}
 */
function start(o = {}) {
  const key = crypto.randomBytes(16).toString('hex');
  /** @type {Received[]} */
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const request = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: /** @type {Record<string, string>} */ (req.headers), body: Buffer.concat(chunks) };
      const result = checkRequest(request);
      if (size > MAX_BODY) result.problems.push({ level: 'error', message: 'The body is larger than 12 MB' });
      if (result.key && result.key !== key) result.problems.push({ level: 'error', message: 'The key is not the one from the DSN' });
      if (result.project !== null && result.project !== 1) result.problems.push({ level: 'error', message: 'The project is not the one from the DSN' });
      result.ok = result.ok && !result.problems.some((p) => p.level === 'error');
      const entry = { at: Date.now(), request, result };
      received.push(entry);
      if (o.onRequest) o.onRequest(entry);
      const status = o.status || (result.endpoint ? (result.key === key ? 200 : 401) : 404);
      const head = { 'Content-Type': 'application/json' };
      if (status === 429) Object.assign(head, { 'Retry-After': '60', 'X-Sentry-Rate-Limits': '60::organization:key_quota' });
      if (status !== 200) head['X-Sentry-Error'] = 'Refused by the conformance server';
      res.writeHead(status, head);
      res.end(JSON.stringify(status === 200 ? { id: crypto.randomBytes(16).toString('hex') } : { detail: 'Refused by the conformance server' }));
    });
  });

  // what one request cannot show: an integration that floods devbord when a script fails in a loop
  const summary = () => {
    const events = received.flatMap((r) => r.result.items.filter((i) => i.kind === 'event').map((i) => ({ at: r.at, summary: i.summary })));
    const warnings = [];
    if (events.some((e, i) => events.filter((x, j) => j >= i && x.at - e.at < 60000).length > BURST)) warnings.push(`More than ${BURST} events within a minute: cap what the integration sends`);
    const repeats = new Map();
    for (const e of events) {
      const list = repeats.get(e.summary) || [];
      list.push(e.at);
      repeats.set(e.summary, list);
    }
    for (const [name, times] of repeats) {
      if (times.some((t, i) => times.filter((x, j) => j >= i && x - t < 10000).length > REPEAT)) warnings.push(`"${name}" was sent more than ${REPEAT} times within 10 seconds: send the same error once`);
    }
    return {
      requests: received.length,
      events: events.length,
      checkIns: received.reduce((n, r) => n + r.result.items.filter((i) => i.kind === 'check_in').length, 0),
      errors: received.reduce((n, r) => n + [...r.result.problems, ...r.result.items.flatMap((i) => i.problems)].filter((p) => p.level === 'error').length, 0),
      warnings,
    };
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port || 0, '127.0.0.1', () => {
      const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
      resolve({ dsn: `http://${key}@127.0.0.1:${port}/1`, port, received, summary, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i];
  const print = (r) => {
    const mark = r.result.ok ? 'ok  ' : 'FAIL';
    console.log(`${mark} ${r.request.method} ${r.request.path}`);
    for (const p of r.result.problems) console.log(`       ${p.level}: ${p.message}`);
    for (const item of r.result.items) {
      console.log(`     ${item.kind}: ${item.summary}`);
      for (const p of item.problems) console.log(`       ${p.level}: ${p.message}`);
    }
  };
  start({ port: Number(opt.port) || 4700, status: Number(opt.status) || undefined, onRequest: print }).then((s) => {
    console.log(`Conformance server for devbord integrations\nDSN: ${s.dsn}\nWaiting for requests; stop with Ctrl-C.\n`);
    process.on('SIGINT', () => {
      const t = s.summary();
      console.log(`\n${t.requests} request(s): ${t.events} event(s), ${t.checkIns} check-in(s), ${t.errors} error(s)`);
      for (const w of t.warnings) console.log(`warning: ${w}`);
      if (!t.requests) console.log('Nothing arrived: check the DSN and that the integration can reach this machine.');
      process.exit(t.errors || !t.requests ? 1 : 0);
    });
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
