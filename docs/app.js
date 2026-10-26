'use strict';
/*
 * SISI TV for the web: browse, add-ons and Sources, Real-Debrid, playback with a browser-friendly fallback,
 * linked devices and the watch party. Talks to the same services, in the same formats, as the SISI TV app.
 */
const VERSION = 'web 1.0';
const RELAY = 'https://ntfy.sh';                      // same relay the app uses for linked devices and watch party
const CINE = 'https://v3-cinemeta.strem.io';
const CINEMETA_URL = CINE + '/manifest.json';
const OPENSUBS_URL = 'https://opensubtitles-v3.strem.io/manifest.json';

// ---------------------------------------------------------------- helpers
const S = {
  get(k, d) { try { const v = localStorage.getItem('sisi.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sisi.' + k, JSON.stringify(v)); } catch { /* private mode: nothing kept */ } },
  del(k) { try { localStorage.removeItem('sisi.' + k); } catch { } },
};
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = s => encodeURIComponent(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uniqBy = (arr, f) => { const seen = new Set(); return arr.filter(x => { const k = f(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
const pad2 = n => String(n).padStart(2, '0');
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const deviceId = S.get('deviceId') || (() => { const id = randomId(); S.set('deviceId', id); return id; })();

let toastTimer = 0;
function toast(msg, ms = 3800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

async function getText(url, opts) {
  const r = await fetch(url, opts);
  const txt = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return txt;
}
async function getJSON(url, opts) {
  const txt = await getText(url, opts);
  try { return JSON.parse(txt); } catch { throw new Error(txt.trim().startsWith('<') ? 'the server sent a web page, not data' : 'the reply was not readable'); }
}

/** Java's String.hashCode, so "watched" marks match the SISI TV app. */
function javaHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return String(h); }

/** A random order that stays the same until the page is reloaded. */
const launchSeed = (Math.random() * 2 ** 31) | 0;
function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffled(arr, seed) { const r = seeded(seed), a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function strSeed(s) { return Number(javaHash(s)) + launchSeed; }

/** "S01E02" style numbers in a file name. */
function parseEp(name) {
  const m = /\bS(\d{1,2})[ ._-]?E(\d{1,3})/i.exec(name) || /\b(\d{1,2})x(\d{2})\b/i.exec(name);
  return m ? { season: +m[1], episode: +m[2] } : { season: 0, episode: 0 };
}
const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm|mpg|mpeg)$/i;
function fmtSize(b) { return b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b >= 1048576 ? Math.round(b / 1048576) + ' MB' : ''; }
function fmtTime(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}h ${m}m` : `${m} min`; }

// ---------------------------------------------------------------- Cinemeta (film information)
const cineCache = new Map();
function cine(path) {
  if (!cineCache.has(path)) cineCache.set(path, getJSON(CINE + path).then(j => j.metas || []).catch(() => { cineCache.delete(path); return []; }));
  return cineCache.get(path);
}
const Cinemeta = {
  popular: t => cine(`/catalog/${t}/top.json`),
  featured: t => cine(`/catalog/${t}/imdbRating.json`),
  async newest(t) {
    const y = new Date().getFullYear();
    const [a, b] = await Promise.all([cine(`/catalog/${t}/year/genre=${y}.json`), cine(`/catalog/${t}/year/genre=${y - 1}.json`)]);
    return uniqBy([...a, ...b], m => m.id);
  },
  coming: t => cine(`/catalog/${t}/year/genre=${new Date().getFullYear() + 1}.json`),
  async genre(t, g) {
    const [a, b] = await Promise.all([cine(`/catalog/${t}/top/genre=${enc(g)}.json`), cine(`/catalog/${t}/imdbRating/genre=${enc(g)}.json`)]);
    return uniqBy([...a, ...b], m => m.id);
  },
  async search(q) {
    const [a, b] = await Promise.all([cine(`/catalog/movie/top/search=${enc(q)}.json`), cine(`/catalog/series/top/search=${enc(q)}.json`)]);
    return [...a.map(m => ({ ...m, type: 'movie' })), ...b.map(m => ({ ...m, type: 'series' }))];
  },
  async meta(type, id) { return (await getJSON(`${CINE}/meta/${type}/${enc(id)}.json`)).meta; },
};
const MOVIE_GENRES = ['Action', 'Comedy', 'Drama', 'Horror', 'Sci-Fi', 'Animation', 'Thriller', 'Family'];
const SERIES_GENRES = ['Drama', 'Comedy', 'Crime', 'Sci-Fi', 'Animation', 'Mystery', 'Reality-TV', 'Documentary'];

// ---------------------------------------------------------------- add-ons (Stremio style)
const Addons = {
  list() { return S.get('addons', []); },                                   // [{url, enabled}] (Cinemeta is always there)
  save(l, changed = true) { S.set('addons', l); if (changed) { S.set('addonsChangedAt', Date.now()); Sync.pushAddonsSoon(); } },
  manifests: S.get('manifests', {}),                                        // url -> manifest (kept so pages open fast)

  /** Tidies a pasted link (spaces, stremio://, /configure, missing /manifest.json), like the app. */
  clean(raw) {
    let t = String(raw).replace(/\s+/g, '');
    const m = /(https?|stremio):\/\/\S+/i.exec(t); let u = m ? m[0] : t;
    if (/^stremio:\/\//i.test(u)) u = 'https://' + u.slice(10);
    if (!/^http/i.test(u)) u = 'https://' + u;
    u = u.split('#')[0].split('?')[0];
    let base = u.replace(/\/+$/, '');
    for (;;) { const b = base.replace(/\/manifest\.json$/, '').replace(/\/manifest$/, '').replace(/\/configure$/, '').replace(/\/+$/, ''); if (b === base) break; base = b; }
    return base + '/manifest.json';
  },
  base: url => url.replace(/\/manifest\.json$/, ''),

  async fetchManifest(url) {
    const j = await getJSON(url);
    if (!j.id && !j.resources) throw new Error(j.error ? 'the add-on says: ' + (j.error.message || j.error) : "the reply isn't an add-on");
    this.manifests[url] = j; S.set('manifests', this.manifests);
    return j;
  },
  async refreshAll() {
    await Promise.allSettled([...this.list().map(a => a.url), OPENSUBS_URL].map(u => this.fetchManifest(u)));
  },
  /** Enabled add-ons that offer [resource] for [type]. */
  offering(resource, type) {
    const urls = [...this.list().filter(a => a.enabled !== false).map(a => a.url)];
    if (resource === 'subtitles' && !urls.includes(OPENSUBS_URL)) urls.push(OPENSUBS_URL);
    return urls.map(u => ({ url: u, m: this.manifests[u] })).filter(({ m }) => {
      if (!m) return false;
      return (m.resources || []).some(r => {
        const name = typeof r === 'string' ? r : r.name;
        const types = (typeof r === 'object' && r.types) || m.types || [];
        return name === resource && (!type || !types.length || types.includes(type));
      });
    });
  },
  name(url) { return this.manifests[url]?.name || new URL(url).host; },
};

// ---------------------------------------------------------------- magnets and sources
const Magnets = {
  find(text) {
    const t = text.replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
    const out = [];
    for (const m of t.matchAll(/magnet:\?[^\s"'<>]+/gi)) {
      const h = /urn:btih:([a-f0-9]{40}|[a-z2-7]{32})/i.exec(m[0]); if (!h) continue;
      const params = new URLSearchParams(m[0].slice(m[0].indexOf('?') + 1));
      out.push({ hash: hexHash(h[1]), name: params.get('dn'), trackers: params.getAll('tr') });
    }
    return uniqBy(out, x => x.hash);
  },
  link(hash, trackers = []) {
    const tr = trackers.map(t => t.replace(/^tracker:/, '')).filter(t => /^(udp:|http)/.test(t)).map(t => '&tr=' + enc(t)).join('');
    return `magnet:?xt=urn:btih:${hash}${tr}`;
  },
};
function hexHash(h) {
  if (h.length === 40) return h.toLowerCase();
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0, out = '';
  for (const c of h.toUpperCase()) { const v = A.indexOf(c); if (v < 0) return h.toLowerCase(); val = (val << 5) | v; bits += 5; if (bits >= 8) { bits -= 8; out += ((val >> bits) & 255).toString(16).padStart(2, '0'); } }
  return out;
}
const CACHED = /\[(rd|ad|pm|dl|tb|ed|oc)\+]|⚡|\binstant\b|\bcached\b/i;
const UNCACHED = /\[(rd|ad|pm|dl|tb|ed|oc) download]|⏳|\buncached\b|not cached/i;
function quality(text) {
  if (/\b(2160p|4k|uhd)\b/i.test(text)) return { rank: 4, label: '4K' };
  if (/\b1080p\b/i.test(text)) return { rank: 3, label: '1080p' };
  if (/\b720p\b/i.test(text)) return { rank: 2, label: '720p' };
  if (/\b(480p|576p|sd)\b/i.test(text)) return { rank: 1, label: 'SD' };
  return { rank: 0, label: '' };
}
function parseSize(s) {
  const m = /(\d+(?:\.\d+)?)\s*(gb|gib|mb|mib)/i.exec(s); if (!m) return 0;
  return Math.round(parseFloat(m[1]) * (m[2].toLowerCase().startsWith('g') ? 1073741824 : 1048576));
}
function parseStream(addonUrl, o) {
  let url = /^https?:/.test(o.url || '') ? o.url : null;
  const found = Magnets.find(JSON.stringify(o))[0];
  const ih = o.infoHash && (o.infoHash.length === 40 || o.infoHash.length === 32) ? hexHash(o.infoHash) : null;
  const hash = ih || (!url && found ? found.hash : null);
  if (!url && !hash) return null;
  const hints = o.behaviorHints || {};
  const title = o.title || o.description || hints.filename || found?.name || o.name || '';
  const label = o.name || Addons.name(addonUrl);
  const text = label + ' ' + title;
  const q = quality(text);
  const seeders = +((/seed(?:ers)?\s*[:：]?\s*(\d+)/i.exec(title) || /👤\s*(\d+)/.exec(title) || [])[1] || 0);
  const cached = UNCACHED.test(text) ? false : CACHED.test(text) ? true : !!url;
  return {
    addon: Addons.name(addonUrl), label: label.replace(/\n/g, ' '), title: title.replace(/\n/g, ' '), url, hash,
    fileIdx: o.fileIdx ?? null, trackers: [...(o.sources || []), ...(found && found.hash === hash ? found.trackers : [])],
    rank: q.rank, qlabel: q.label, seeders, size: parseSize(title) || hints.videoSize || 0, cached,
    filename: hints.filename || '', binge: hints.bingeGroup || '',
  };
}
async function findSources(type, id) {
  const all = await Promise.all(Addons.offering('stream', type).map(async ({ url }) => {
    try { const j = await getJSON(`${Addons.base(url)}/stream/${type}/${enc(id)}.json`); return (j.streams || []).map(o => parseStream(url, o)).filter(Boolean); }
    catch { return []; }
  }));
  return all.flat().sort((a, b) => (b.cached - a.cached) || (b.rank - a.rank) || (b.seeders - a.seeders) || (b.size - a.size)).slice(0, 300);
}

// ---------------------------------------------------------------- Real-Debrid
/*
 * Requests carry the token as ?auth_token= and send form bodies, so the browser doesn't need to ask Real-Debrid's
 * permission first (fewer things that can go wrong).
 */
const RD = {
  API: 'https://api.real-debrid.com/rest/1.0',
  OAUTH: 'https://api.real-debrid.com/oauth/v2',
  CID: 'X245A4XAIBGVM',                               // the open-source client id the app uses too
  get auth() { return S.get('rd', null); },
  get signedIn() { return !!S.get('rd', null); },
  signOut() { S.del('rd'); },

  async token() {
    const a = this.auth; if (!a) throw new Error('Sign in to Real-Debrid in Settings first');
    if (a.apiToken) return a.apiToken;
    if (Date.now() > a.expires) await this.refresh();
    return this.auth.access;
  },
  async refresh() {
    const a = this.auth;
    const j = await getJSON(`${this.OAUTH}/token`, { method: 'POST', body: new URLSearchParams({ client_id: a.cid, client_secret: a.secret, code: a.refresh, grant_type: 'http://oauth.net/grant_type/device/1.0' }) });
    S.set('rd', { ...a, access: j.access_token, refresh: j.refresh_token, expires: Date.now() + (j.expires_in || 3600) * 1000 - 60000 });
  },
  async call(method, path, form, retried) {
    const t = await this.token();
    const url = `${this.API}${path}${path.includes('?') ? '&' : '?'}auth_token=${enc(t)}`;
    let r;
    try { r = await fetch(url, form ? { method, body: new URLSearchParams(form) } : { method }); }
    catch { throw new Error("Couldn't reach Real-Debrid (check your connection)"); }
    const txt = await r.text();
    if (r.status === 401 && !retried && !this.auth?.apiToken) { await this.refresh(); return this.call(method, path, form, true); }
    if (!r.ok) { let m = txt; try { m = JSON.parse(txt).error || txt; } catch { } throw new Error('Real-Debrid: ' + (m || 'HTTP ' + r.status)); }
    return txt ? JSON.parse(txt) : {};
  },

  // sign-in with a short code (approve it at real-debrid.com/device)
  async startLogin() { return getJSON(`${this.OAUTH}/device/code?client_id=${this.CID}&new_credentials=yes`); },
  async pollLogin(dc) {
    let creds;
    try { creds = await getJSON(`${this.OAUTH}/device/credentials?client_id=${this.CID}&code=${enc(dc.device_code)}`); } catch { return false; }
    if (!creds.client_secret) return false;
    const j = await getJSON(`${this.OAUTH}/token`, { method: 'POST', body: new URLSearchParams({ client_id: creds.client_id, client_secret: creds.client_secret, code: dc.device_code, grant_type: 'http://oauth.net/grant_type/device/1.0' }) });
    S.set('rd', { cid: creds.client_id, secret: creds.client_secret, access: j.access_token, refresh: j.refresh_token, expires: Date.now() + (j.expires_in || 3600) * 1000 - 60000 });
    return true;
  },
  useToken(tok) { S.set('rd', { apiToken: tok.trim() }); },

  user() { return this.call('GET', '/user'); },
  unrestrict(link) { return this.call('POST', '/unrestrict/link', { link }); },
  transcode(id) { return this.call('GET', `/streaming/transcode/${enc(id)}`); },
  downloads() { return this.call('GET', '/downloads?limit=50'); },
  del(id) { return this.call('DELETE', `/torrents/delete/${enc(id)}`).catch(() => { }); },

  /** Gets a torrent ready (reusing a finished copy in your account) and returns its id. */
  async addMagnetAndWait(hash, magnet, maxMs = 30000) {
    const mine = await this.call('GET', '/torrents?limit=100').catch(() => []);
    const have = mine.find(t => (t.hash || '').toLowerCase() === hash && t.status === 'downloaded');
    if (have) return { id: have.id, added: false };
    const { id } = await this.call('POST', '/torrents/addMagnet', { magnet });
    try {
      let selected = false; const end = Date.now() + maxMs;
      while (Date.now() < end) {
        const info = await this.call('GET', `/torrents/info/${enc(id)}`);
        if (info.status === 'downloaded') return { id, added: true };
        if (info.status === 'waiting_files_selection' && !selected) { await this.call('POST', `/torrents/selectFiles/${enc(id)}`, { files: 'all' }); selected = true; }
        if (['magnet_error', 'error', 'virus', 'dead'].includes(info.status)) throw new Error('Real-Debrid: ' + info.status);
        await sleep(1200);
      }
      throw new Error("This torrent isn't cached on Real-Debrid. Pick a ⚡ cached source.");
    } catch (e) { await this.del(id); throw e; }
  },
  async fileList(id) {
    const j = await this.call('GET', `/torrents/info/${enc(id)}`);
    const sel = (j.files || []).filter(f => f.selected !== 0);
    return sel.map((f, i) => ({ id: f.id, name: (f.path || '').split('/').pop(), bytes: f.bytes, link: (j.links || [])[i] })).filter(f => f.link);
  },
};

/** A source to something playable. Magnets go through Real-Debrid. */
async function resolveSource(meta, s, season, episode) {
  if (s.url) {
    const file = s.filename || decodeURIComponent(new URL(s.url).pathname.split('/').pop() || '') ||
      (meta.type === 'series' && episode ? `${meta.name} S${pad2(season)}E${pad2(episode)}` : meta.name);
    // keep the torrent's id if the add-on gave one (or it's inside the link): needed for the browser-friendly stream
    const hash = s.hash || ((/(?:^|[\/=:_-])([a-f0-9]{40})(?=$|[\/?&=:_.-])/i.exec(s.url) || [])[1] || '').toLowerCase() || null;
    return { url: s.url, file, link: s.url, direct: true, rdId: null, hash, fileIdx: s.fileIdx, trackers: s.trackers || [] };
  }
  const { id, added } = await RD.addMagnetAndWait(s.hash, Magnets.link(s.hash, s.trackers));
  try {
    const all = await RD.fileList(id);
    if (!all.length) throw new Error('No files in this torrent');
    const vids = all.filter(f => VIDEO.test(f.name)); const pool = vids.length ? vids : all;
    const series = meta.type === 'series' && episode > 0;
    const isEp = n => { const p = parseEp(n); return (p.season === season || p.season === 0) && p.episode === episode; };
    const other = n => { const p = parseEp(n); return p.season > 0 && p.episode > 0 && (p.season !== season || p.episode !== episode); };
    let pick = s.fileIdx != null ? pool.find(f => f.id === s.fileIdx + 1) : null;
    if (pick && series && other(pick.name)) pick = null;
    if (!pick) pick = series ? (pool.find(f => isEp(f.name)) || (pool.length === 1 ? pool[0] : null)) : pool.slice().sort((a, b) => b.bytes - a.bytes)[0];
    if (!pick) throw new Error(`S${pad2(season)}E${pad2(episode)} isn't in this torrent`);
    const u = await RD.unrestrict(pick.link);
    return { url: u.download, file: u.filename || pick.name, link: pick.link, direct: false, rdId: u.id };
  } catch (e) { if (added) await RD.del(id); throw e; }
}

// ---------------------------------------------------------------- what you've watched (same shape as the app's main profile)
const Watch = {
  history: () => S.get('history', []),                  // [{key, id, type, title, at}]
  counts: () => S.get('counts', {}),
  cw: () => S.get('cw', []).sort((a, b) => b.at - a.at), // Continue watching entries, like the app's
  watched: () => S.get('watched', []),                  // Java hash codes of finished file names
  seenIds() { return new Set(this.history().map(h => h.id).filter(Boolean)); },

  recordPlay(key, id, type, title) {
    if (!key) return;
    const h = this.history().filter(x => x.key !== key);
    h.unshift({ key, id, type, title, at: Date.now() }); S.set('history', h.slice(0, 60));
    const c = this.counts(); c[key] = (c[key] || 0) + 1; S.set('counts', c);
    Sync.pushWatchSoon();
  },
  putContinue(o) {
    const l = this.cw().filter(x => x.key !== o.key); l.unshift(o);
    S.set('cw', l.sort((a, b) => b.at - a.at).slice(0, 20)); Sync.pushWatchSoon();
  },
  removeContinue(key) {
    S.set('cw', this.cw().filter(x => x.key !== key));
    const gone = S.get('cwGone', {}); gone[key] = Date.now(); S.set('cwGone', gone); Sync.pushWatchSoon();
  },
  markWatched(file) { const w = new Set(this.watched()); w.add(javaHash(file)); S.set('watched', [...w]); Sync.pushWatchSoon(); },

  export() {
    return { watched: this.watched(), counts: this.counts(), history: this.history(), cw: this.cw(), cwGone: S.get('cwGone', {}), hidden: S.get('hidden', []) };
  },
  /** Adds what a linked device has watched (same rules as the app). Returns true if anything changed. */
  merge(o) {
    const before = JSON.stringify(this.export());
    S.set('watched', [...new Set([...this.watched(), ...(o.watched || [])])]);
    const c = this.counts(); for (const [k, v] of Object.entries(o.counts || {})) if (v > (c[k] || 0)) c[k] = v; S.set('counts', c);
    const byKey = new Map(); for (const h of [...this.history(), ...(o.history || [])]) { const x = byKey.get(h.key); if (!x || h.at > x.at) byKey.set(h.key, h); }
    S.set('history', [...byKey.values()].sort((a, b) => b.at - a.at).slice(0, 60));
    const gone = S.get('cwGone', {}); for (const [k, v] of Object.entries(o.cwGone || {})) if (v > (gone[k] || 0)) gone[k] = v; S.set('cwGone', gone);
    const cw = new Map(); for (const e of [...this.cw(), ...(o.cw || [])]) { const x = cw.get(e.key); if (!x || e.at > x.at) cw.set(e.key, e); }
    S.set('cw', [...cw.values()].filter(e => e.at > (gone[e.key] || 0)).sort((a, b) => b.at - a.at).slice(0, 20));
    S.set('hidden', [...new Set([...S.get('hidden', []), ...(o.hidden || [])])]);
    return JSON.stringify(this.export()) !== before;
  },
};

// ---------------------------------------------------------------- linked devices (encrypted, same format as the app)
const te = s => new TextEncoder().encode(s);
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
async function streamBytes(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }

const Sync = {
  ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  get code() { return S.get('syncCode', ''); },
  normalise(typed) {
    const c = String(typed).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length !== 12 || [...c].some(ch => !this.ALPHABET.includes(ch))) return null;
    return c.match(/.{4}/g).join('-');
  },
  newCode() { const r = crypto.getRandomValues(new Uint8Array(12)); return [...r].map(b => this.ALPHABET[b % 32]).join('').match(/.{4}/g).join('-'); },

  _keys: new Map(),
  async key(code) {
    if (!this._keys.has(code)) {
      const base = await crypto.subtle.importKey('raw', te(code), 'PBKDF2', false, ['deriveKey']);
      this._keys.set(code, await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: te('sisi-tv-sync-v1'), iterations: 20000, hash: 'SHA-1' },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    }
    return this._keys.get(code);
  },
  async topic(code) { const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te('sisi-tv-sync-topic|' + code))); return 'sisitv-sync-' + hex(h.slice(0, 16)); },
  async encrypt(code, plain) {
    const zipped = await streamBytes(te(plain), new CompressionStream('gzip'));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, await this.key(code), zipped));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return 's2:' + b64(out);
  },
  async decrypt(code, msg) {
    try {
      if (!msg.startsWith('s2:')) return null;
      const b = unb64(msg.slice(3));
      const zipped = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), tagLength: 128 }, await this.key(code), b.slice(12)));
      return new TextDecoder().decode(await streamBytes(zipped, new DecompressionStream('gzip')));
    } catch { return null; }
  },
  split(sealed) {
    if (sealed.length <= 3500) return [sealed];
    const batch = randomId().slice(0, 8); const parts = sealed.match(/[\s\S]{1,3500}/g);
    return parts.map((p, i) => `p:${batch}:${i}:${parts.length}:${p}`);
  },
  join(messages) {
    const out = [], groups = new Map();
    for (const m of messages) {
      if (!m.startsWith('p:')) { out.push(m); continue; }
      const f = m.split(':'); if (f.length < 5) continue;
      const i = +f[2], n = +f[3]; if (!(n >= 1 && n <= 50 && i >= 0 && i < n)) continue;
      if (!groups.has(f[1])) groups.set(f[1], new Array(n).fill(null));
      const g = groups.get(f[1]); if (g.length === n) g[i] = f.slice(4).join(':');
    }
    for (const g of groups.values()) if (g.every(x => x != null)) out.push(g.join(''));
    return out;
  },
  async send(body) {
    const code = this.code; if (!code) return;
    const url = `${RELAY}/${await this.topic(code)}`;
    for (const part of this.split(await this.encrypt(code, JSON.stringify(body)))) {
      const r = await fetch(url, { method: 'POST', body: part });
      if (!r.ok) throw new Error('relay said ' + r.status);
    }
  },
  pushAddons() {
    return this.send({ v: 1, from: deviceId, at: S.get('addonsChangedAt', 0), addons: Addons.list().map(a => ({ url: a.url, enabled: a.enabled !== false })) });
  },
  pushWatch() { return this.send({ ...Watch.export(), v: 1, kind: 'watch', from: deviceId, profile: 'p0', at: Date.now() }); },
  _w: 0, _a: 0,
  pushWatchSoon() { if (!this.code) return; clearTimeout(this._w); this._w = setTimeout(() => this.pushWatch().catch(() => { }), 20000); },
  pushAddonsSoon() { if (!this.code) return; clearTimeout(this._a); this._a = setTimeout(() => this.pushAddons().catch(() => { }), 1500); },

  /** Newer add-ons and watched films from your other devices. Returns {addons, watched}. */
  async pull() {
    const code = this.code; if (!code) return { addons: false, watched: false };
    const txt = await getText(`${RELAY}/${await this.topic(code)}/json?poll=1&since=all`);
    const msgs = txt.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(o => o && o.event === 'message').map(o => o.message);
    let best = null, watched = false;
    for (const m of this.join(msgs)) {
      const plain = await this.decrypt(code, m); if (!plain) continue;
      let o; try { o = JSON.parse(plain); } catch { continue; }
      if (o.from === deviceId) continue;
      if (o.kind === 'watch') { if ((o.profile || 'p0') === 'p0' && Watch.merge(o)) watched = true; continue; }
      if (!best || o.at > best.at) best = o;
    }
    let addons = false;
    if (best && best.at > S.get('addonsChangedAt', 0) && Array.isArray(best.addons)) {
      const list = best.addons.filter(a => /^http/.test(a.url)).map(a => ({ url: a.url, enabled: a.enabled !== false }));
      const same = JSON.stringify(list) === JSON.stringify(Addons.list().map(a => ({ url: a.url, enabled: a.enabled !== false })));
      Addons.save(list, false); S.set('addonsChangedAt', best.at);
      if (!same) { addons = true; await Addons.refreshAll(); }
    }
    return { addons, watched };
  },
  _last: 0,
  async onOpen(force, quiet) {
    if (!this.code) return null;
    if (!force && Date.now() - this._last < 5 * 60000) return null;
    this._last = Date.now();
    const r = await this.pull().catch(() => ({ addons: false, watched: false }));
    this.pushAddons().catch(() => { }); this.pushWatch().catch(() => { });
    if (r.addons) toast('Add-ons updated from your other device');
    if (r.addons || r.watched) route(true);
    else if (force && !quiet) toast('Your linked devices are up to date');
    return r;
  },
};

// ---------------------------------------------------------------- watch party (same messages as the app)
const Party = {
  ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  me: randomId().slice(0, 8),
  code: null, host: false, es: null, last: null, follow: null,
  get active() { return !!this.code; },
  start(code, host) {
    this.stop(true);
    this.code = code; this.host = host; this.last = null;
    const since = Math.floor(Date.now() / 1000);
    this.es = new EventSource(`${RELAY}/sisitv-party-${code}/sse?since=${since}`);
    this.es.onmessage = e => {
      let o; try { o = JSON.parse(e.data); } catch { return; }
      if (o.event && o.event !== 'message') return;
      let st; try { st = JSON.parse(o.message); } catch { return; }
      st.k = st.k || 'state';
      if (st.from === this.me) return;
      if (st.k === 'state') this.last = st;
      Player.onParty(st);
    };
    this.send({ from: this.me, k: 'hello', at: Date.now() });
    updatePartyButton();
  },
  stop(quiet) {
    if (this.code) this.send({ from: this.me, k: 'bye', at: Date.now() });
    this.es?.close(); this.es = null; this.code = null; this.last = null;
    if (!quiet) updatePartyButton();
  },
  send(st) {
    if (!this.code) return;
    fetch(`${RELAY}/sisitv-party-${this.code}`, { method: 'POST', body: JSON.stringify({ id: '', type: '', s: 0, e: 0, title: '', pos: 0, play: false, ...st }) }).catch(() => { });
  },
  /** Where the sender is now, allowing for the time the message took (at most 5 s). */
  posNow(st) { return st.play ? st.pos + Math.min(5000, Math.max(0, Date.now() - st.at)) : st.pos; },
};
function updatePartyButton() {
  $('#partyBtn').classList.toggle('live', Party.active);
  $('#partyLabel').textContent = Party.active ? `Party ${Party.code}` : 'Party';
}

// ---------------------------------------------------------------- player
const Player = {
  v: null, hls: null, cur: null, ignoreUntil: 0, saveTimer: 0, heart: 0, audioCheck: 0, usingCompat: false, subs: [],

  init() {
    this.v = $('#video');
    $('#pBack').onclick = () => this.close();
    $('#pCompat').onclick = () => this.compat(true);
    $('#pSubs').onclick = () => this.subtitleMenu();
    $('#pParty').onclick = () => partyDialog();
    const bar = $('#playerBar'); let hideT = 0;
    const wake = () => { bar.classList.remove('hide'); clearTimeout(hideT); hideT = setTimeout(() => { if (!this.v.paused) bar.classList.add('hide'); }, 3500); };
    ['mousemove', 'touchstart', 'keydown'].forEach(e => $('#player').addEventListener(e, wake, { passive: true }));
    const v = this.v;
    v.addEventListener('play', () => { wake(); this.partySend(); });
    v.addEventListener('pause', () => { wake(); this.partySend(); this.save(); });
    v.addEventListener('seeked', () => this.partySend());
    v.addEventListener('timeupdate', () => { if (Date.now() - this.saveTimer > 10000) { this.saveTimer = Date.now(); this.save(); } });
    v.addEventListener('ended', () => this.finished());
    v.addEventListener('error', () => { if (this.cur && !this.usingCompat) this.compat(false); else if (this.cur) this.msg("This file can't play in the browser. Try another source.", [['Close', () => this.close()]]); });
    v.addEventListener('loadedmetadata', () => { if (this.cur?.startAt > 10000 && v.currentTime < 1) v.currentTime = this.cur.startAt / 1000; });
    document.addEventListener('keydown', e => {
      if ($('#player').hidden || e.target.tagName === 'INPUT') return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
      else if (e.key === 'ArrowLeft') v.currentTime = Math.max(0, v.currentTime - 10);
      else if (e.key === 'ArrowRight') v.currentTime += 30;
      else if (e.key === 'Escape') this.close();
      else if (e.key === 'f') (document.fullscreenElement ? document.exitFullscreen() : $('#player').requestFullscreen?.());
    });
  },

  msg(text, buttons = []) {
    const m = $('#pMsg');
    if (!text) { m.hidden = true; return; }
    m.innerHTML = `<div>${esc(text)}</div>` + buttons.map((b, i) => `<button class="btn small" data-i="${i}">${esc(b[0])}</button>`).join('');
    m.querySelectorAll('button').forEach(btn => btn.onclick = () => { m.hidden = true; buttons[+btn.dataset.i][1](); });
    m.hidden = false;
  },

  /** Opens the player: [r] is a resolved source {url, file, link, direct, rdId}. */
  async open(meta, season, episode, r, startAt = 0) {
    const series = meta.type === 'series' && episode > 0;
    const title = series ? `${meta.name} · S${pad2(season)}E${pad2(episode)}` : meta.name;
    const epName = series ? (meta.videos || []).find(x => x.season === season && (x.episode ?? x.number) === episode)?.name || '' : '';
    this.cur = {
      meta, season, episode, r, startAt, title,
      cw: { key: `addon:${meta.id}#${r.file}`, title, show: meta.name, binge: '', file: r.file, link: r.link, direct: r.direct,
        type: meta.type, id: meta.id, poster: meta.poster || '', ep_name: epName, ...(series ? { season, episode } : {}) },
    };
    if (!startAt) {                                   // carry on where you left off (also from the TV, via linked devices)
      const known = Watch.cw().find(x => x.key === this.cur.cw.key);
      if (known?.pos > 10000 && known.dur && known.pos < known.dur - 120000) this.cur.startAt = known.pos;
    }
    Watch.recordPlay(this.cur.cw.key.split('#')[0], meta.id, meta.type, meta.name);
    $('#pTitle').textContent = title;
    $('#player').hidden = false; document.body.style.overflow = 'hidden';
    this.usingCompat = false; this.subs = []; this.msg('');
    clearTimeout(this.audioCheck);
    // iPhone / iPad can't read MKV files: use Real-Debrid's browser-friendly stream straight away
    if (isIOS && !/\.(mp4|m4v|mov)(\?|$)/i.test(r.file + ' ' + r.url)) { await this.compat(false); }
    else { this.setSource(r.url); }
    // films with sound the browser can't decode (AC3, DTS…) play silently: offer the compatible stream
    this.audioCheck = setTimeout(() => {
      const v = this.v;
      const silent = (v.webkitAudioDecodedByteCount === 0) || (v.mozHasAudio === false) || (v.audioTracks && v.audioTracks.length === 0);
      if (!this.usingCompat && !v.paused && silent) this.msg('No sound? This file\'s sound may not play in a browser.', [['Use compatible stream', () => this.compat(true)], ['Keep', () => { }]]);
    }, 8000);
    this.loadSubtitles();
    if (Party.active) { const k = Party.last; if (k && this.same(k)) this.applyParty(k); this.partySend(true); }
    clearInterval(this.heart);
    this.heart = setInterval(() => { if (Party.active && Party.host && !this.v.paused) this.partySend(true); }, 120000);
  },

  setSource(url, isHls) {
    const v = this.v;
    this.hls?.destroy(); this.hls = null;
    if (isHls && !v.canPlayType('application/vnd.apple.mpegurl') && window.Hls?.isSupported()) {
      this.hls = new Hls({ maxBufferLength: 60 }); this.hls.loadSource(url); this.hls.attachMedia(v);
      this.hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) this.msg("Real-Debrid's stream stopped. Try another source.", [['Close', () => this.close()]]); });
    } else { v.src = url; }
    v.play().catch(() => { });
  },

  /** Real-Debrid's browser-friendly version (converted on the fly). */
  async compat(userAsked) {
    const c = this.cur; if (!c) return;
    const pos = this.v.currentTime > 5 ? this.v.currentTime * 1000 : c.startAt;
    this.msg('Switching to the browser-friendly stream…');
    try {
      let id = c.r.rdId;
      if (!id) {                                      // a link from an add-on (like Debridio): find the file in your Real-Debrid downloads
        const norm = x => String(x || '').toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[^a-z0-9]+/g, '');
        const name = norm(c.r.file);
        const dl = await RD.downloads().catch(() => []);
        const recent = dl.filter(d => Date.now() - Date.parse(d.generated || 0) < 10 * 60000);
        id = (dl.find(d => d.download === c.r.url || d.link === c.r.url) ||
              (name && dl.find(d => norm(d.filename) === name)) ||
              (name.length > 6 && dl.find(d => norm(d.filename).includes(name) || name.includes(norm(d.filename)))) ||
              recent[0])?.id;                                    // the add-on just opened it through your account: the newest one
      }
      if (!id) { const u = await RD.unrestrict(c.r.url).catch(() => null); id = u?.id; }
      if (!id && c.r.hash) {                          // last resort: open the same torrent on Real-Debrid ourselves
        this.msg('Getting it ready on Real-Debrid…');
        const again = await resolveSource(c.meta, { hash: c.r.hash, fileIdx: c.r.fileIdx, trackers: c.r.trackers }, c.season, c.episode);
        id = again.rdId;
      }
      if (!id) throw new Error("Real-Debrid doesn't have a browser-friendly version of this source");
      const t = await RD.transcode(id);
      const hlsUrl = t?.apple?.full || t?.liveMP4?.full;
      if (!hlsUrl) throw new Error('Real-Debrid has no browser-friendly version of this file');
      this.usingCompat = true; c.startAt = pos;
      this.setSource(hlsUrl, !!t?.apple?.full);
      this.msg('');
      if (userAsked) toast('Playing the browser-friendly stream');
    } catch (e) {
      this.msg((e.message || 'That didn\'t work') + '. Try another source.', [['Close', () => this.close()]]);
    }
  },

  save() {
    const c = this.cur, v = this.v; if (!c || !v.duration || !isFinite(v.duration)) return;
    const pos = v.currentTime * 1000, dur = v.duration * 1000;
    if (pos > dur - 120000) return;                   // nearly done: "finished" handles it
    if (pos > 60000) Watch.putContinue({ ...c.cw, pos: Math.round(pos), dur: Math.round(dur), at: Date.now() });
  },
  finished() {
    const c = this.cur; if (!c) return;
    Watch.markWatched(c.r.file); Watch.removeContinue(c.cw.key);
    this.close();
  },
  close() {
    const v = this.v;
    if (this.cur && v.duration && isFinite(v.duration) && v.currentTime * 1000 > v.duration * 1000 - 120000) { Watch.markWatched(this.cur.r.file); Watch.removeContinue(this.cur.cw.key); }
    else this.save();
    clearInterval(this.heart); clearTimeout(this.audioCheck);
    this.hls?.destroy(); this.hls = null;
    v.pause(); v.removeAttribute('src'); [...v.querySelectorAll('track')].forEach(t => t.remove()); v.load();
    this.cur = null; this.msg('');
    $('#player').hidden = true; document.body.style.overflow = '';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    route(true);
  },

  // ---- subtitles (from your subtitle add-ons; OpenSubtitles is built in)
  async loadSubtitles() {
    const c = this.cur; const id = c.meta.type === 'series' && c.episode ? `${c.meta.id}:${c.season}:${c.episode}` : c.meta.id;
    const lists = await Promise.all(Addons.offering('subtitles', c.meta.type).map(async ({ url }) => {
      try { return ((await getJSON(`${Addons.base(url)}/subtitles/${c.meta.type}/${enc(id)}.json`)).subtitles || []).filter(s => /^https?:/.test(s.url)); } catch { return []; }
    }));
    if (this.cur !== c) return;
    this.subs = lists.flat().slice(0, 80);
    const want = S.get('subLang', '');
    if (want) { const s = this.subs.find(x => (x.lang || '').toLowerCase() === want); if (s) this.useSub(s, true); }
  },
  subtitleMenu() {
    const langs = uniqBy(this.subs, s => s.lang).map(s => s.lang);
    if (!langs.length) { toast(this.cur ? 'No subtitles found for this title' : ''); return; }
    openSheet(`<div class="pad"><h3>Subtitles</h3><div class="list">
      <button class="item" data-l=""><div class="grow"><div class="t1">Off</div></div></button>
      ${langs.map(l => `<button class="item" data-l="${esc(l)}"><div class="grow"><div class="t1">${esc(langName(l))}</div><div class="t2">${this.subs.filter(s => s.lang === l).length} option(s)</div></div></button>`).join('')}
    </div></div>`, body => body.querySelectorAll('[data-l]').forEach(b => b.onclick = () => {
      closeSheet(); const l = b.dataset.l; S.set('subLang', l);
      if (!l) { [...this.v.textTracks].forEach(t => t.mode = 'disabled'); return; }
      this.useSub(this.subs.find(s => s.lang === l));
    }));
  },
  async useSub(s, quiet) {
    try {
      const raw = await getText(s.url);
      const vtt = raw.trim().startsWith('WEBVTT') ? raw : 'WEBVTT\n\n' + raw.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
      [...this.v.querySelectorAll('track')].forEach(t => t.remove());
      const tr = document.createElement('track'); tr.kind = 'subtitles'; tr.label = langName(s.lang); tr.srclang = (s.lang || 'en').slice(0, 2); tr.default = true;
      tr.src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      this.v.appendChild(tr); tr.addEventListener('load', () => { tr.track.mode = 'showing'; });
      setTimeout(() => { if (tr.track) tr.track.mode = 'showing'; }, 300);
      if (!quiet) toast('Subtitles: ' + langName(s.lang));
    } catch { if (!quiet) toast("Couldn't load those subtitles"); }
  },

  // ---- watch party
  state(kind = 'state') {
    const c = this.cur, v = this.v;
    return { from: Party.me, k: kind, id: c?.meta.id || '', type: c?.meta.type || '', s: c?.meta.type === 'series' ? c.season : 0, e: c?.meta.type === 'series' ? c.episode : 0,
      title: c?.title || '', pos: Math.round((v?.currentTime || 0) * 1000), play: !!v && !v.paused, at: Date.now() };
  },
  same(st) { const m = this.state(); return st.id === m.id && (st.s || 0) === m.s && (st.e || 0) === m.e; },
  partySend(force) { if (Party.active && this.cur && (force || Date.now() > this.ignoreUntil)) Party.send(this.state()); },
  applyParty(st) {
    const v = this.v; this.ignoreUntil = Date.now() + 1500;
    const target = Party.posNow(st) / 1000;
    if (Math.abs(target - v.currentTime) > 2.5) v.currentTime = target;
    if (st.play && v.paused) { v.play().catch(() => { }); toast('▶  Your friend pressed play'); }
    if (!st.play && !v.paused) { v.pause(); toast('⏸  Your friend paused'); }
  },
  onParty(st) {
    if (st.k === 'hello') { toast('A friend joined the watch party'); if (this.cur) this.partySend(true); return; }
    if (st.k === 'bye') { toast('A friend left the watch party'); return; }
    if (this.cur && this.same(st)) { this.applyParty(st); return; }
    if (!Party.host && st.id) {                         // the host is watching something else: offer to follow
      const go = () => { if (this.cur) this.close(); openTitle(st.type || 'movie', st.id, st.s ? { season: st.s, episode: st.e } : null); };
      if (this.cur) this.msg(`Your friend started ${st.title}.`, [['Follow', go], ['Stay', () => { }]]);
      else { toast(`Your friend is watching ${st.title}. Opening it…`); go(); }
    }
  },
};
const LANGS = { eng: 'English', en: 'English', spa: 'Spanish', es: 'Spanish', fre: 'French', fra: 'French', fr: 'French', ger: 'German', deu: 'German', de: 'German',
  ita: 'Italian', it: 'Italian', por: 'Portuguese', pob: 'Portuguese (Brazil)', pt: 'Portuguese', dut: 'Dutch', nld: 'Dutch', nl: 'Dutch', pol: 'Polish', pl: 'Polish',
  rus: 'Russian', ru: 'Russian', ara: 'Arabic', ar: 'Arabic', tur: 'Turkish', tr: 'Turkish', rum: 'Romanian', ron: 'Romanian', swe: 'Swedish', dan: 'Danish',
  nor: 'Norwegian', fin: 'Finnish', gre: 'Greek', ell: 'Greek', heb: 'Hebrew', hin: 'Hindi', chi: 'Chinese', zho: 'Chinese', jpn: 'Japanese', kor: 'Korean', hun: 'Hungarian', cze: 'Czech', ces: 'Czech' };
const langName = l => LANGS[(l || '').toLowerCase()] || (l || 'Unknown');

// ---------------------------------------------------------------- sheet (details, sources, dialogs)
function openSheet(html, after) {
  $('#sheetBody').innerHTML = html; $('#sheet').hidden = false;
  $('#sheet').scrollTop = 0; after?.($('#sheetBody'));
}
function closeSheet() { $('#sheet').hidden = true; $('#sheetBody').innerHTML = ''; }

// ---------------------------------------------------------------- cards and rows
const img = (id, size = 'medium') => `https://images.metahub.space/background/${size}/${id}/img`;
function posterCard(m) {
  const sub = [String(m.releaseInfo || m.year || '').slice(0, 4), m.imdbRating ? '★ ' + m.imdbRating : ''].filter(Boolean).join(' · ');
  return `<button class="card" data-open="${esc(m.type || 'movie')}|${esc(m.id)}" title="${esc(m.name)}">
    <div class="fallback">${esc(m.name)}</div>
    ${m.poster ? `<img loading="lazy" src="${esc(m.poster)}" alt="" onerror="this.remove()">` : ''}
    <div class="cap">${esc(m.name)}<small>${esc(sub)}</small></div></button>`;
}
function cwCard(o) {
  const left = o.dur ? fmtTime(o.dur - o.pos) + ' left' : '';
  const pic = /^tt/.test(o.id) ? img(o.id) : o.poster;
  return `<button class="card" data-cw="${esc(o.key)}" title="${esc(o.title)}">
    <div class="fallback">${esc(o.title)}</div>
    ${pic ? `<img loading="lazy" src="${esc(pic)}" alt="" onerror="this.remove()">` : ''}
    <div class="cap">${esc(o.title)}<small>${esc(left)}</small></div>
    <div class="bar" style="width:${o.dur ? Math.min(100, (o.pos / o.dur) * 100).toFixed(1) : 0}%"></div></button>`;
}

const ROWS = {
  home: [['continue', 'Continue watching'], ['mylist', 'My List'], ['coming', 'Coming soon'], ['newrel', 'New releases'], ['featured', 'Featured (highly rated)'],
    ['popmovies', 'Popular films'], ['popseries', 'Popular series']],
  movies: [['continue', 'Continue watching'], ['mylist', 'My List'], ['newrel', 'New releases'], ['featured', 'Featured (highly rated)'], ['genres', 'Genre rows (Action, Comedy…)'], ['popmovies', 'Popular films']],
  series: [['continue', 'Continue watching'], ['mylist', 'My List'], ['coming', 'Coming soon'], ['newrel', 'New series'], ['featured', 'Featured series'], ['genres', 'Genre rows (Drama, Crime…)'], ['popseries', 'Popular series']],
};
/** Row switches per page; add-on catalogue rows start off (a tidy page to begin with). */
const rowOn = (page, key) => { const off = S.get('rowsOff', {}), on = S.get('rowsOn', {}); return key.startsWith('addon:') ? (on[page] || []).includes(key) : !(off[page] || []).includes(key); };
function setRowOn(page, key, val) {
  const off = S.get('rowsOff', {}), on = S.get('rowsOn', {});
  off[page] = (off[page] || []).filter(k => k !== key); on[page] = (on[page] || []).filter(k => k !== key);
  (val ? on : off)[page].push(key); S.set('rowsOff', off); S.set('rowsOn', on);
}
function addonCatalogs(page) {
  const out = [];
  for (const { url, m } of Addons.offering('catalog')) {
    for (const c of m.catalogs || []) {
      const required = (c.extra || []).some(e => e.isRequired) || (c.extraRequired || []).length;
      if (required || !['movie', 'series'].includes(c.type)) continue;
      if (page === 'movies' && c.type !== 'movie') continue;
      if (page === 'series' && c.type !== 'series') continue;
      const title = `${c.name || m.name} · ${m.name}`;
      out.push({ key: 'addon:' + title, title, load: async () => ((await getJSON(`${Addons.base(url)}/catalog/${c.type}/${enc(c.id)}.json`).catch(() => ({}))).metas || []).map(x => ({ ...x, type: x.type || c.type })) });
    }
  }
  return out;
}

async function renderBrowse(page) {
  const view = $('#view');
  view.innerHTML = `<div class="spinner"></div>`;
  const type = page === 'series' ? 'series' : 'movie';
  const want = t => page === 'home' || (page === 'series') === (t === 'series');
  const seen = Watch.seenIds();
  const fresh = l => l.filter(m => m && m.id && !seen.has(m.id));
  const specs = [];
  const cw = Watch.cw().filter(o => want(o.type));
  if (cw.length) specs.push({ key: 'continue', title: 'Continue watching', wide: true, cw });
  const ml = S.get('mylist', []).filter(m => want(m.type));
  if (ml.length) specs.push({ key: 'mylist', title: 'My List', min: 1, load: async () => ml });
  if (page !== 'movies') specs.push({ key: 'coming', title: 'Coming soon', load: async () => (await Cinemeta.coming(type)).map(m => ({ ...m, type })) });
  specs.push({ key: 'newrel', title: page === 'series' ? 'New series' : 'New releases', load: async () => fresh((await Cinemeta.newest(type)).map(m => ({ ...m, type }))) });
  specs.push({ key: 'featured', title: page === 'series' ? 'Featured series' : 'Featured films', load: async () => fresh((await Cinemeta.featured(type)).map(m => ({ ...m, type }))) });
  if (page !== 'home') for (const g of (page === 'series' ? SERIES_GENRES : MOVIE_GENRES))
    specs.push({ key: 'genres', title: g, load: async () => shuffled(fresh((await Cinemeta.genre(type, g)).map(m => ({ ...m, type }))), strSeed(g)) });
  for (const a of addonCatalogs(page)) specs.push(a);
  if (page !== 'series') specs.push({ key: 'popmovies', title: 'Popular films', load: async () => fresh((await Cinemeta.popular('movie')).map(m => ({ ...m, type: 'movie' }))) });
  if (page !== 'movies') specs.push({ key: 'popseries', title: 'Popular series', load: async () => fresh((await Cinemeta.popular('series')).map(m => ({ ...m, type: 'series' }))) });

  const active = specs.filter(s => rowOn(page, s.key));
  const loaded = await Promise.all(active.map(async s => ({ ...s, items: s.cw ? null : (await s.load().catch(() => [])) })));
  if (location.hash.replace('#', '') !== page && !(page === 'home' && !location.hash)) return;   // you moved on meanwhile

  // each title only once on the page (Continue watching doesn't count), up to 30 per row
  const shown = new Set(); const rows = [];
  for (const r of loaded) {
    if (r.cw) { rows.push(r); continue; }
    const items = r.items.filter(m => !shown.has(m.id)).slice(0, 30);
    if (items.length >= (r.min || 3)) { items.forEach(m => shown.add(m.id)); rows.push({ ...r, items }); }
  }
  const heroMeta = (rows.find(r => r.items && r.key !== 'coming') || rows.find(r => r.items))?.items[0];
  view.innerHTML = (heroMeta ? heroHtml(heroMeta) : '') +
    (rows.length ? rows.map(r => `<section class="row"><h2>${esc(r.title)}</h2><div class="strip${r.wide ? ' wide' : ''}">
      ${r.cw ? r.cw.map(cwCard).join('') : r.items.map(posterCard).join('')}</div></section>`).join('')
      : `<p class="empty">Nothing to show yet. Check your connection, or turn rows on in Settings.</p>`);
  if (!RD.signedIn) view.insertAdjacentHTML('afterbegin', `<p class="empty">👋 Sign in to Real-Debrid and add your add-ons in <a href="#settings" style="color:var(--accent)">Settings</a> to start watching.</p>`);
}
function heroHtml(m) {
  return `<section class="hero" style="background-image:url('${img(m.id, 'large')}')">
    <h1>${esc(m.name)}</h1>
    <div class="meta">${esc([String(m.releaseInfo || '').slice(0, 4), m.imdbRating ? '★ ' + m.imdbRating + ' IMDb' : '', (m.genres || m.genre || []).slice(0, 3).join(', ')].filter(Boolean).join('  ·  '))}</div>
    <p>${esc(m.description || '')}</p>
    <div class="btns"><button class="btn primary" data-open="${esc(m.type)}|${esc(m.id)}">▶ Watch</button></div></section>`;
}

// ---------------------------------------------------------------- details
async function openTitle(type, id, ep) {
  openSheet(`<div class="spinner"></div>`);
  let m;
  try { m = await Cinemeta.meta(type, id); } catch { openSheet(`<div class="pad"><h3>Couldn't load this title</h3><p class="muted">Check your connection and try again.</p></div>`); return; }
  if (!m) { openSheet(`<div class="pad"><h3>Title not found</h3></div>`); return; }
  m.type = m.type || type;
  const inList = S.get('mylist', []).some(x => x.id === m.id);
  const trailer = m.trailers?.[0]?.source || m.trailerStreams?.[0]?.ytId;
  const facts = [String(m.releaseInfo || '').slice(0, 9), m.imdbRating ? '★ ' + m.imdbRating + ' IMDb' : '', (m.genres || m.genre || []).join(', '), m.runtime || ''].filter(Boolean).join('  ·  ');
  const seasons = [...new Set((m.videos || []).map(v => v.season).filter(s => s > 0))].sort((a, b) => a - b);
  openSheet(`<div class="backdrop" style="background-image:url('${img(m.id, 'large')}')"></div>
    <div class="pad">
      <h3>${esc(m.name)}</h3><div class="muted" style="color:var(--accent);font-weight:600">${esc(facts)}</div>
      <p class="muted">${esc(m.description || '')}</p>
      ${(m.cast || []).length ? `<p class="tiny">With ${esc(m.cast.slice(0, 6).join(', '))}</p>` : ''}
      <div class="btns">
        ${m.type === 'series' ? '' : `<button class="btn primary" id="dPlay">▶ Sources</button>`}
        ${trailer ? `<button class="btn" id="dTrailer">Trailer</button>` : ''}
        <button class="btn" id="dList">${inList ? '✓ In My List' : '＋ My List'}</button>
      </div>
      <div id="dTrailerBox"></div>
      ${seasons.length ? `<div class="chips" id="dSeasons">${seasons.map(s => `<button class="chip" data-s="${s}">Season ${s}</button>`).join('')}</div><div class="list" id="dEps"></div>` : ''}
    </div>`, body => {
    $('#dPlay', body)?.addEventListener('click', () => openSources(m, 0, 0));
    $('#dTrailer', body)?.addEventListener('click', () => {
      $('#dTrailerBox', body).innerHTML = `<div style="position:relative;aspect-ratio:16/9;margin-top:12px"><iframe style="position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:10px" src="https://www.youtube-nocookie.com/embed/${enc(trailer)}?autoplay=1" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe></div>`;
    });
    $('#dList', body).addEventListener('click', e => {
      let l = S.get('mylist', []); const had = l.some(x => x.id === m.id);
      l = had ? l.filter(x => x.id !== m.id) : [{ id: m.id, type: m.type, name: m.name, poster: m.poster, releaseInfo: m.releaseInfo, imdbRating: m.imdbRating }, ...l];
      S.set('mylist', l); e.target.textContent = had ? '＋ My List' : '✓ In My List';
    });
    const showSeason = s => {
      body.querySelectorAll('#dSeasons .chip').forEach(c => c.classList.toggle('on', +c.dataset.s === s));
      const eps = (m.videos || []).filter(v => v.season === s).sort((a, b) => (a.episode ?? a.number) - (b.episode ?? b.number));
      $('#dEps', body).innerHTML = eps.map(v => {
        const n = v.episode ?? v.number;
        const aired = v.released && new Date(v.released) > new Date() ? ' · coming ' + new Date(v.released).toLocaleDateString() : '';
        return `<button class="item ep" data-e="${n}">${v.thumbnail ? `<img loading="lazy" src="${esc(v.thumbnail)}" alt="">` : ''}
          <div class="grow"><div class="t1">${n}. ${esc(v.name || v.title || 'Episode ' + n)}</div><div class="t2">${esc((v.overview || v.description || '').slice(0, 140))}${aired}</div></div></button>`;
      }).join('');
      $('#dEps', body).querySelectorAll('[data-e]').forEach(b => b.onclick = () => openSources(m, s, +b.dataset.e));
    };
    body.querySelectorAll('#dSeasons .chip').forEach(c => c.onclick = () => showSeason(+c.dataset.s));
    if (seasons.length) showSeason(ep?.season && seasons.includes(ep.season) ? ep.season : (Watch.cw().find(x => x.id === m.id)?.season || seasons[0]));
    if (ep && m.type === 'series') openSources(m, ep.season, ep.episode);
    else if (ep === null && m.type !== 'series' && Party.active) openSources(m, 0, 0);
  });
}

// ---------------------------------------------------------------- sources
async function openSources(m, season, episode) {
  const series = m.type === 'series' && episode > 0;
  const title = series ? `${m.name} · S${pad2(season)}E${pad2(episode)}` : m.name;
  openSheet(`<div class="pad"><h3>${esc(title)}</h3><p class="muted" id="sStatus">Finding sources…</p><div class="spinner" id="sSpin"></div><div class="chips" id="sChips"></div><div class="list" id="sList"></div></div>`);
  if (!Addons.offering('stream', m.type).length) {
    $('#sSpin').remove(); $('#sStatus').innerHTML = 'No stream add-ons yet. Add one (like Debridio or Torrentio) in <a href="#settings" style="color:var(--accent)">Settings</a>, or link this browser to your SISI TV there.'; return;
  }
  const all = await findSources(m.type, series ? `${m.id}:${season}:${episode}` : m.id);
  if (!$('#sList')) return;
  $('#sSpin')?.remove();
  const draw = () => {
    const cachedOnly = S.get('cachedOnly', false);
    const list = all.filter(s => !cachedOnly || s.cached);
    $('#sChips').innerHTML = `<button class="chip${cachedOnly ? ' on' : ''}" id="sCached">⚡ Cached only</button>`;
    $('#sCached').onclick = () => { S.set('cachedOnly', !cachedOnly); draw(); };
    $('#sStatus').textContent = all.length ? `${list.length} source${list.length === 1 ? '' : 's'}${all.length > list.length ? ` · ${all.length - list.length} hidden` : ''}` +
      (all.some(s => !s.url) && !RD.signedIn ? ' · magnets need Real-Debrid (sign in in Settings)' : '') : 'No sources found for this title.';
    $('#sList').innerHTML = list.map((s, i) => {
      const facts = [s.cached ? '⚡ Cached' : 'Not cached', s.label, s.size ? fmtSize(s.size) : '', s.seeders ? '👤 ' + s.seeders : '', s.url ? 'Direct' : 'Real-Debrid'].filter(Boolean).join('  ·  ');
      return `<button class="item" data-i="${all.indexOf(s)}"><span class="badge${s.rank === 4 ? ' k4' : ''}">${esc(s.qlabel || (s.url ? 'HTTP' : 'P2P'))}</span>
        <div class="grow"><div class="t1">${esc(facts)}</div><div class="t2">${esc(s.title)}</div></div></button>`;
    }).join('');
    $('#sList').querySelectorAll('[data-i]').forEach(b => b.onclick = () => playSource(m, season, episode, all[+b.dataset.i]));
  };
  draw();
}
async function playSource(m, season, episode, s, startAt = 0) {
  if (!s.url && !RD.signedIn) { toast('Sign in to Real-Debrid in Settings to play this source'); return; }
  const st = $('#sStatus'); if (st) st.textContent = s.url ? 'Opening…' : 'Getting it ready on Real-Debrid…';
  try {
    const r = await resolveSource(m, s, season, episode);
    closeSheet();
    Player.open(m, season, episode, r, startAt);
  } catch (e) { toast(e.message || 'That source didn\'t work'); if (st) st.textContent = (e.message || 'That source didn\'t work') + ' Try another one.'; }
}
/** Continue watching: reopen the saved link (a fresh one from Real-Debrid if needed). */
async function resume(key) {
  const o = Watch.cw().find(x => x.key === key); if (!o) return;
  toast('Opening…', 2000);
  const meta = await Cinemeta.meta(o.type, o.id).catch(() => null) || { id: o.id, type: o.type, name: o.show || o.title, poster: o.poster, videos: [] };
  meta.type = meta.type || o.type;
  try {
    let r;
    if (o.direct) r = { url: o.link, file: o.file, link: o.link, direct: true, rdId: null };
    else { const u = await RD.unrestrict(o.link); r = { url: u.download, file: u.filename || o.file, link: o.link, direct: false, rdId: u.id }; }
    Player.open(meta, o.season || 0, o.episode || 0, r, o.pos);
  } catch {
    toast("That saved link has expired. Pick a source to carry on.");
    openTitle(o.type, o.id, o.season ? { season: o.season, episode: o.episode } : undefined);
  }
}

// ---------------------------------------------------------------- search
async function renderSearch(q) {
  const view = $('#view');
  view.innerHTML = `<div class="settings" style="max-width:none"><h2>Results for “${esc(q)}”</h2></div><div class="spinner"></div>`;
  const res = await Cinemeta.search(q);
  if (decodeURIComponent(location.hash.slice(8)) !== q) return;
  view.innerHTML = `<div class="settings" style="max-width:none"><h2>Results for “${esc(q)}”</h2></div>` +
    (res.length ? `<div class="grid">${res.map(posterCard).join('')}</div>` : `<p class="empty">Nothing found. Try a shorter title.</p>`);
}

// ---------------------------------------------------------------- watch party dialog
function partyDialog() {
  if (Party.active) {
    openSheet(`<div class="pad"><h3>Watch party</h3><p class="muted">You're in watch party</p><div class="code">${esc(Party.code)}</div>
      <p class="muted">Friends join with this code: here under 👥 Party › Join, or on SISI TV in Settings › Watch party › Join.
      Everyone plays the title from their own Real-Debrid; play, pause and jumps stay in sync.</p>
      <div class="btns"><button class="btn" id="pLeave">Leave the party</button></div></div>`, b => $('#pLeave', b).onclick = () => { Party.stop(); closeSheet(); toast('You left the watch party'); });
    return;
  }
  openSheet(`<div class="pad"><h3>Watch party</h3>
    <p class="muted">Watch together with friends on SISI TV or in their browser. Play, pause and jumps stay in sync. Everyone plays from their own Real-Debrid.</p>
    <div class="btns"><button class="btn primary" id="pStart">Start a party</button></div>
    <p class="tiny" style="margin-top:16px">Got a code from a friend?</p>
    <form class="field" id="pJoinForm"><input id="pCode" placeholder="Party code (6 letters)" autocapitalize="characters" autocomplete="off"><button class="btn">Join</button></form></div>`, b => {
    $('#pStart', b).onclick = () => {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), x => Party.ALPHABET[x % Party.ALPHABET.length]).join('');
      Party.start(code, true); partyDialog();
      if (Player.cur) Player.partySend(true);
    };
    $('#pJoinForm', b).onsubmit = e => {
      e.preventDefault();
      const code = $('#pCode', b).value.toUpperCase().split('').filter(c => Party.ALPHABET.includes(c)).join('');
      if (code.length < 4) { toast('That code doesn\'t look right'); return; }
      Party.start(code, false); closeSheet(); toast(`Joined watch party ${code}. Waiting for your friend…`);
    };
  });
}

// ---------------------------------------------------------------- settings
let loginTimer = 0;
async function renderSettings() {
  const view = $('#view');
  const addons = Addons.list();
  const page = S.get('rowsPage', 'home');
  const rowList = [...ROWS[page], ...addonCatalogs(page).map(a => [a.key, a.title + ' (add-on)'])];
  view.innerHTML = `<div class="settings">
    <section><h2>Real-Debrid</h2><div id="rdBox" class="muted">${RD.signedIn ? 'Checking your account…' : 'Not signed in.'}</div></section>

    <section><h2>Add-ons</h2>
      <p class="tiny">Cinemeta (film information) and OpenSubtitles are built in. Paste a Stremio add-on link (like your Debridio link) to add sources.</p>
      <div class="list">${addons.length ? addons.map((a, i) => `<div class="item"><div class="grow"><div class="t1">${esc(Addons.name(a.url))}</div><div class="t2">${esc(a.url.replace(/^https:\/\//, '').slice(0, 60))}…</div></div>
        <button class="switch${a.enabled !== false ? ' on' : ''}" data-tog="${i}" aria-label="On or off"></button><button class="btn small" data-rm="${i}">Remove</button></div>`).join('')
        : '<p class="muted">No add-ons yet. Link this browser to your SISI TV below to copy them, or paste one here.</p>'}</div>
      <form class="field" id="addForm"><input id="addUrl" placeholder="https://…/manifest.json" autocomplete="off"><button class="btn">Add</button></form>
    </section>

    <section><h2>Linked devices</h2>
      ${Sync.code ? `<p class="muted">Linked with code <b>${esc(Sync.code)}</b>. Add-ons, watched films and Continue watching stay the same as on your SISI TV.</p>
        <div class="btns"><button class="btn" id="syncNow">Sync now</button><button class="btn" id="syncOff">Unlink this browser</button></div>`
      : `<p class="muted">Copy your add-ons and what you've watched from SISI TV. On the TV: Settings › Linked devices › Start linking, then type the code here.</p>
        <form class="field" id="syncForm"><input id="syncCode" placeholder="Code like K7QM-3XPA-W2RD" autocapitalize="characters" autocomplete="off"><button class="btn">Join</button></form>
        <p class="tiny">No SISI TV yet? <button class="btn small" id="syncNew">Make a code here instead</button></p>`}
    </section>

    <section><h2>Rows</h2>
      <div class="chips">${['home', 'movies', 'series'].map(p => `<button class="chip${p === page ? ' on' : ''}" data-page="${p}">${{ home: 'Home', movies: 'Films', series: 'Series' }[p]}</button>`).join('')}</div>
      ${rowList.map(([k, name]) => `<div class="toggle"><span>${esc(name)}</span><button class="switch${rowOn(page, k) ? ' on' : ''}" data-row="${esc(k)}" aria-label="${esc(name)}"></button></div>`).join('')}
    </section>

    <section><h2>Sources</h2>
      <div class="toggle"><span>Only show ⚡ cached sources</span><button class="switch${S.get('cachedOnly', false) ? ' on' : ''}" id="cachedSw"></button></div>
    </section>

    <section><h2>About</h2><p class="muted">SISI TV ${VERSION}. Plays from your own Real-Debrid account and add-ons. No content is included.</p>
      <div class="btns"><button class="btn small" id="wipe">Clear everything on this browser</button></div></section>
  </div>`;

  // Real-Debrid
  const box = $('#rdBox');
  if (RD.signedIn) {
    RD.user().then(u => { box.innerHTML = `Signed in as <b>${esc(u.username)}</b> · ${esc(u.type)}${u.expiration ? ' until ' + esc(String(u.expiration).slice(0, 10)) : ''}
      <div class="btns" style="margin-top:10px"><button class="btn small" id="rdOut">Sign out</button></div>`; $('#rdOut').onclick = () => { RD.signOut(); renderSettings(); }; })
      .catch(e => { box.innerHTML = `${esc(e.message)}<div class="btns" style="margin-top:10px"><button class="btn small" id="rdOut">Sign out and try again</button></div>`; $('#rdOut').onclick = () => { RD.signOut(); renderSettings(); }; });
  } else {
    box.innerHTML = `<div class="btns"><button class="btn primary" id="rdIn">Sign in with a code</button></div>
      <details style="margin-top:10px"><summary class="tiny">Or use your API token</summary>
      <form class="field" id="tokForm"><input id="tok" placeholder="Token from real-debrid.com/apitoken" autocomplete="off"><button class="btn">Save</button></form></details>`;
    $('#rdIn').onclick = async () => {
      try {
        const dc = await RD.startLogin();
        box.innerHTML = `On your phone or computer, open <a href="${esc(dc.verification_url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(dc.verification_url)}</a> and enter:<div class="code">${esc(dc.user_code)}</div><p class="tiny">Waiting for you to approve…</p>`;
        clearInterval(loginTimer);
        const end = Date.now() + (dc.expires_in || 600) * 1000;
        loginTimer = setInterval(async () => {
          if (Date.now() > end) { clearInterval(loginTimer); box.textContent = 'The code expired. Try again.'; return; }
          if (await RD.pollLogin(dc).catch(() => false)) { clearInterval(loginTimer); toast('Signed in to Real-Debrid'); renderSettings(); }
        }, Math.max(5, dc.interval || 5) * 1000);
      } catch (e) { box.textContent = "Couldn't reach Real-Debrid: " + e.message + '. Try the API token option instead.'; }
    };
    $('#tokForm').onsubmit = async e => {
      e.preventDefault(); const t = $('#tok').value.trim(); if (!t) return;
      RD.useToken(t);
      try { await RD.user(); toast('Signed in to Real-Debrid'); } catch (err) { RD.signOut(); toast('That token didn\'t work: ' + err.message); }
      renderSettings();
    };
  }

  // add-ons
  view.querySelectorAll('[data-tog]').forEach(b => b.onclick = () => { const l = Addons.list(); const a = l[+b.dataset.tog]; a.enabled = a.enabled === false; Addons.save(l); renderSettings(); });
  view.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { const l = Addons.list(); l.splice(+b.dataset.rm, 1); Addons.save(l); renderSettings(); });
  $('#addForm').onsubmit = async e => {
    e.preventDefault();
    const raw = $('#addUrl').value.trim(); if (!raw) return;
    const url = Addons.clean(raw);
    try {
      const m = await Addons.fetchManifest(url);
      const l = Addons.list().filter(a => a.url !== url); l.push({ url, enabled: true }); Addons.save(l);
      toast(`Added ${m.name || 'add-on'}`); renderSettings();
    } catch (err) { toast("Couldn't add that add-on: " + err.message); }
  };

  // linked devices
  $('#syncForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const code = Sync.normalise($('#syncCode').value);
    if (!code) { toast("That code isn't right: it has 12 letters and numbers"); return; }
    S.set('syncCode', code); S.set('addonsChangedAt', 0);      // take the other device's add-ons
    toast('Linked. Getting your add-ons…');
    await Sync.onOpen(true); renderSettings();
  });
  $('#syncNew')?.addEventListener('click', () => {
    const code = Sync.newCode(); S.set('syncCode', code); S.set('addonsChangedAt', Date.now()); Sync.pushAddons().catch(() => { });
    openSheet(`<div class="pad"><h3>Your sync code</h3><div class="code">${esc(code)}</div><p class="muted">On your other SISI TV or browser, choose Linked devices › Join and type this code. Keep it private: it unlocks your add-on links.</p></div>`);
    renderSettings();
  });
  $('#syncNow')?.addEventListener('click', () => Sync.onOpen(true));
  $('#syncOff')?.addEventListener('click', () => { S.del('syncCode'); toast('Unlinked. Your add-ons here stay as they are.'); renderSettings(); });

  // rows
  view.querySelectorAll('[data-page]').forEach(b => b.onclick = () => { S.set('rowsPage', b.dataset.page); renderSettings(); });
  view.querySelectorAll('[data-row]').forEach(b => b.onclick = () => { setRowOn(page, b.dataset.row, !rowOn(page, b.dataset.row)); b.classList.toggle('on'); });
  $('#cachedSw').onclick = e => { S.set('cachedOnly', !S.get('cachedOnly', false)); e.target.classList.toggle('on'); };
  $('#wipe').onclick = () => { if (confirm('Sign out and remove your add-ons, history and settings from this browser?')) { Object.keys(localStorage).filter(k => k.startsWith('sisi.')).forEach(k => localStorage.removeItem(k)); location.reload(); } };
}

// ---------------------------------------------------------------- pages
function route() {
  const h = decodeURIComponent(location.hash.slice(1)) || 'home';
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === h));
  if (h.startsWith('search/')) return renderSearch(h.slice(7));
  if (h === 'settings') return renderSettings();
  if (['home', 'movies', 'series'].includes(h)) return renderBrowse(h);
  location.hash = '#home';
}

document.addEventListener('click', e => {
  const open = e.target.closest('[data-open]');
  if (open) { const [type, id] = open.dataset.open.split('|'); openTitle(type, id); return; }
  const cw = e.target.closest('[data-cw]');
  if (cw) { resume(cw.dataset.cw); return; }
  if (e.target === $('#sheet')) closeSheet();
});
document.addEventListener('contextmenu', e => {                 // right-click / long-press a Continue watching card to remove it
  const cw = e.target.closest('[data-cw]'); if (!cw) return;
  e.preventDefault();
  if (confirm('Remove from Continue watching?')) { Watch.removeContinue(cw.dataset.cw); route(); }
});
$('#sheetClose').onclick = closeSheet;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
$('#searchForm').onsubmit = e => { e.preventDefault(); const q = $('#searchBox').value.trim(); if (q) location.hash = '#search/' + encodeURIComponent(q); };
$('#partyBtn').onclick = partyDialog;
window.addEventListener('hashchange', route);
window.addEventListener('focus', () => Sync.onOpen(false));
window.addEventListener('beforeunload', () => { Player.save(); if (Party.active) Party.send({ from: Party.me, k: 'bye', at: Date.now() }); });

(async function start() {
  Player.init();
  route();
  await Addons.refreshAll();                                    // fresh add-on details (catalogues, subtitles)
  await Sync.onOpen(true, true).catch(() => { });
})();
