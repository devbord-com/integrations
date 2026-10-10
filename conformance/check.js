'use strict';
// Checks one request from an integration against the devbord ingest protocol (see ../PROTOCOL.md).
// No dependencies, so it can be copied next to any integration.

const LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'];
const STATUSES = ['ok', 'error', 'in_progress'];
const UNITS = ['minute', 'hour', 'day', 'week', 'month', 'year'];
const TAG_KEY = /^[A-Za-z0-9_.:-]{1,32}$/;
const KEY = /^[A-Za-z0-9]{1,64}$/;
const SECRET_KEY = /pass(w(or)?d)?|secret|token|api[-_]?key|^auth$|authorization|credential|private[-_]?key|cookie|session[-_]?id|csrf|xsrf/i;
const MAX_EVENT = 1024 * 1024;
const MAX_CHECK_IN = 16384;
const NL = 10;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * @typedef {{ level: 'error' | 'warning', message: string }} Problem
 * @typedef {{ method: string, path: string, query?: Record<string, string>, headers?: Record<string, string>, body: Buffer | string }} IngestRequest
 * @typedef {{ kind: 'event' | 'check_in' | 'other', summary: string, problems: Problem[] }} ItemResult
 * @typedef {{ endpoint: 'store' | 'envelope' | null, project: number | null, key: string | null, items: ItemResult[], problems: Problem[], ok: boolean }} CheckResult
 */

/**
 * Splits an envelope into its header and items.
 * @param {Buffer} buf
 * @returns {{ headers: Record<string, any>, items: { headers: Record<string, any>, payload: Buffer }[] }}
 */
function parseEnvelope(buf) {
  const line = (b, what) => {
    let v;
    try { v = JSON.parse(b.toString('utf8')); } catch { throw new Error(`${what} is not valid JSON`); }
    if (!isObj(v)) throw new Error(`${what} must be a JSON object`);
    return v;
  };
  let pos = buf.indexOf(NL);
  const headers = line(pos === -1 ? buf : buf.subarray(0, pos), 'The envelope header');
  const items = [];
  if (pos === -1) return { headers, items };
  pos += 1;
  while (pos < buf.length) {
    let end = buf.indexOf(NL, pos);
    if (end === -1) end = buf.length;
    if (end === pos) { pos += 1; continue; }
    const h = line(buf.subarray(pos, end), 'An item header');
    pos = end + 1;
    let payload;
    if (Number.isInteger(h.length) && h.length >= 0) {
      if (pos + h.length > buf.length) throw new Error('An item is shorter than its declared length');
      payload = buf.subarray(pos, pos + h.length);
      pos += h.length;
      if (buf[pos] === NL) pos += 1;
    } else {
      end = buf.indexOf(NL, pos);
      if (end === -1) end = buf.length;
      payload = buf.subarray(pos, end);
      pos = end + 1;
    }
    items.push({ headers: h, payload });
  }
  return { headers, items };
}

/**
 * @param {unknown} ev the decoded event
 * @returns {ItemResult}
 */
function checkEvent(ev) {
  /** @type {Problem[]} */
  const problems = [];
  const error = (message) => problems.push({ level: 'error', message });
  const warn = (message) => problems.push({ level: 'warning', message });
  if (!isObj(ev)) return { kind: 'event', summary: 'event', problems: [{ level: 'error', message: 'The event must be a JSON object' }] };

  const values = isObj(ev.exception) && Array.isArray(ev.exception.values) ? ev.exception.values : Array.isArray(ev.exception) ? ev.exception : isObj(ev.exception) ? [ev.exception] : [];
  const usable = values.filter((x) => isObj(x) && (x.type || x.value));
  const entry = isObj(ev.logentry) ? ev.logentry : isObj(ev.message) ? ev.message : null;
  const text = entry ? entry.formatted || entry.message : ev.message;
  if (ev.exception !== undefined && !usable.length) error('exception has no entry with a type or a value');
  if (!usable.length && (typeof text !== 'string' || !text.trim())) error('The event needs exception.values[] or a message');

  for (const x of usable) {
    const frames = isObj(x.stacktrace) ? x.stacktrace.frames : undefined;
    if (frames === undefined) { warn('exception without stacktrace.frames: errors group on the message alone'); continue; }
    if (!Array.isArray(frames)) { error('stacktrace.frames must be an array'); continue; }
    frames.forEach((f, i) => {
      if (!isObj(f) || !(f.filename || f.function || f.module || f.instruction_addr)) error(`frame ${i} needs a filename, function or module`);
      else if (f.lineno !== undefined && f.lineno !== null && !Number.isFinite(Number(f.lineno))) error(`frame ${i}: lineno must be a number`);
      else if (typeof f.filename === 'string' && /^([A-Za-z]:[\\/]|\/(home|Users|root)\/)/.test(f.filename)) warn(`frame ${i}: "${f.filename.slice(0, 60)}" is a path on one machine; send it relative to the project`);
    });
  }

  if (ev.event_id !== undefined && !/^[0-9a-f]{32}$/i.test(String(ev.event_id).replace(/-/g, ''))) warn('event_id is not 32 hexadecimal characters: devbord replaces it, so a retry counts twice');
  if (ev.level !== undefined && !LEVELS.includes(String(ev.level).toLowerCase())) warn(`level is not one of ${LEVELS.join(', ')}: it becomes error`);
  if (ev.timestamp !== undefined) {
    const t = typeof ev.timestamp === 'number' ? (ev.timestamp < 1e11 ? ev.timestamp * 1000 : ev.timestamp) : Date.parse(String(ev.timestamp));
    if (!Number.isFinite(t)) error('timestamp must be seconds since 1970 or an ISO 8601 date');
    else if (Math.abs(Date.now() - t) > 864e5) warn('timestamp is more than a day off; devbord then uses the time of receipt');
  }
  if (typeof ev.platform !== 'string' || !ev.platform) warn('platform is missing (name the language, or the game when no language fits)');
  if (!isObj(ev.sdk) || !ev.sdk.name) warn('sdk.name is missing: name the integration, e.g. "devbord.fivem"');
  else if (!ev.sdk.version) warn('sdk.version is missing');
  if (!ev.release) warn('release is missing: without it "resolved in the next version" cannot work');
  if (!ev.environment) warn('environment is missing');

  if (ev.tags !== undefined) {
    const pairs = isObj(ev.tags) ? Object.entries(ev.tags) : Array.isArray(ev.tags) ? ev.tags : null;
    if (!pairs) error('tags must be an object');
    else {
      if (pairs.length > 50) warn('more than 50 tags: the rest is dropped');
      for (const [k, v] of pairs) {
        if (!TAG_KEY.test(String(k))) error(`tag "${String(k).slice(0, 40)}": keys are 1 to 32 characters from A-Z a-z 0-9 _ . : -`);
        else if (isObj(v) || Array.isArray(v)) error(`tag "${k}" must be a string`);
        else if (v === '' || v === null) warn(`tag "${k}" is empty and is dropped`);
        else if (String(v).length > 200) warn(`tag "${k}" is longer than 200 characters and is cut`);
      }
    }
  }
  if (ev.contexts !== undefined) {
    if (!isObj(ev.contexts)) error('contexts must be an object of objects');
    else for (const [k, v] of Object.entries(ev.contexts)) if (!isObj(v)) error(`contexts.${k} must be an object`);
  }
  if (ev.user !== undefined && ev.user !== null) {
    if (!isObj(ev.user)) error('user must be an object');
    else if (ev.user.ip_address) warn('user.ip_address is set: integrations for games should not send the IP address of a player');
  }
  for (const part of ['extra', 'tags']) {
    if (isObj(ev[part])) for (const k of Object.keys(ev[part])) if (SECRET_KEY.test(k)) warn(`${part}.${k} looks like a secret: devbord replaces the value by [Filtered]`);
  }

  const title = usable.length ? `${usable[usable.length - 1].type || 'Error'}: ${String(usable[usable.length - 1].value || '').slice(0, 80)}` : String(text || '').slice(0, 80);
  return { kind: 'event', summary: title, problems };
}

/**
 * @param {unknown} c the decoded check-in
 * @returns {ItemResult}
 */
function checkCheckIn(c) {
  /** @type {Problem[]} */
  const problems = [];
  const error = (message) => problems.push({ level: 'error', message });
  if (!isObj(c)) return { kind: 'check_in', summary: 'check-in', problems: [{ level: 'error', message: 'The check-in must be a JSON object' }] };
  const slug = String(c.monitor_slug || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) error('monitor_slug needs at least one letter or digit');
  if (!STATUSES.includes(c.status)) error(`status must be one of ${STATUSES.join(', ')}`);
  if (c.duration !== undefined && c.duration !== null && !Number.isFinite(Number(c.duration))) error('duration must be a number of seconds');
  if (c.monitor_config === undefined) problems.push({ level: 'warning', message: 'monitor_config is missing: the monitor must then exist in devbord already' });
  else if (!isObj(c.monitor_config) || !isObj(c.monitor_config.schedule)) error('monitor_config.schedule must be an object');
  else {
    const s = c.monitor_config.schedule;
    if (s.type === 'interval') {
      if (!Number.isInteger(Number(s.value)) || Number(s.value) < 1) error('schedule.value must be a whole number of 1 or more');
      if (!UNITS.includes(s.unit)) error(`schedule.unit must be one of ${UNITS.join(', ')}`);
    } else if (s.type === 'crontab') {
      if (typeof s.value !== 'string' || s.value.trim().split(/\s+/).length !== 5) error('schedule.value must be a crontab with five fields');
    } else error('schedule.type must be "interval" or "crontab"');
    for (const [k, max] of [['checkin_margin', 1440], ['max_runtime', 10080]]) {
      const v = c.monitor_config[k];
      if (v !== undefined && (!Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > max)) error(`monitor_config.${k} must be a whole number of minutes between 1 and ${max}`);
    }
  }
  return { kind: 'check_in', summary: `${slug || '?'} ${c.status || '?'}`, problems };
}

/**
 * Checks one request as an integration sent it.
 * @param {IngestRequest} req
 * @returns {CheckResult}
 */
function checkRequest(req) {
  /** @type {CheckResult} */
  const out = { endpoint: null, project: null, key: null, items: [], problems: [], ok: false };
  const error = (message) => out.problems.push({ level: 'error', message });
  const done = () => { out.ok = ![...out.problems, ...out.items.flatMap((i) => i.problems)].some((p) => p.level === 'error'); return out; };
  const headers = Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const query = req.query || {};
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));

  const m = /^\/api\/(\d{1,15})\/(store|envelope)\/?$/.exec(String(req.path || '').split('?')[0]);
  if (!m) { error('The address must be /api/<project>/store/ or /api/<project>/envelope/'); return done(); }
  out.project = Number(m[1]);
  out.endpoint = /** @type {'store' | 'envelope'} */ (m[2]);
  if (String(req.method).toUpperCase() !== 'POST') error('Use POST');
  if (!body.length) { error('The body is empty'); return done(); }
  if (headers['content-encoding']) { error('This checker reads uncompressed bodies only; turn compression off while testing'); return done(); }

  const fromAuth = /(?:^|[\s,])sentry_key=([A-Za-z0-9]{1,64})/.exec(headers['x-sentry-auth'] || '');
  out.key = fromAuth ? fromAuth[1] : typeof query.sentry_key === 'string' && KEY.test(query.sentry_key) ? query.sentry_key : null;

  /** @type {{ type: string, payload: Buffer }[]} */
  let items;
  if (out.endpoint === 'store') items = [{ type: 'event', payload: body }];
  else {
    let env;
    try { env = parseEnvelope(body); } catch (e) { error(e.message); return done(); }
    if (!out.key && typeof env.headers.dsn === 'string') {
      try { const u = new URL(env.headers.dsn); if (KEY.test(u.username)) out.key = u.username; } catch { /* reported below as a missing key */ }
    }
    if (!env.items.length) error('The envelope has no items');
    items = env.items.map((it) => ({ type: typeof it.headers.type === 'string' ? it.headers.type : '', payload: it.payload }));
  }
  if (!out.key) error('No key: send the public key of the DSN as ?sentry_key=, in X-Sentry-Auth, or as dsn in the envelope header');

  for (const it of items) {
    if (it.type !== 'event' && it.type !== 'check_in') { out.items.push({ kind: 'other', summary: it.type || '(no type)', problems: [] }); continue; }
    const max = it.type === 'event' ? MAX_EVENT : MAX_CHECK_IN;
    if (it.payload.length > max) { out.items.push({ kind: it.type, summary: it.type, problems: [{ level: 'error', message: `larger than ${max} bytes: devbord drops it` }] }); continue; }
    let v;
    try { v = JSON.parse(it.payload.toString('utf8')); } catch { out.items.push({ kind: it.type, summary: it.type, problems: [{ level: 'error', message: 'not valid JSON' }] }); continue; }
    out.items.push(it.type === 'event' ? checkEvent(v) : checkCheckIn(v));
  }
  return done();
}

module.exports = { checkRequest, checkEvent, checkCheckIn, parseEnvelope };
