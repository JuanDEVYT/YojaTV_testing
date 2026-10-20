// language: JavaScript, file: plugin.js, target: QuickJS (Kino Engine), apiVersion: 6
// Multi-source aggregator for YojaTV. Each source is one entry in SOURCES; the exports fan out,
// merge, rank and isolate failures per source. Refs are "<srcId>:<path>" (path is source-local).
// Sources behind a browser check use kino.browser.page (manifest "browser": "pages").

/* ---------- shared utilities ---------- */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' };

function cleanText(s) {
  if (!s) return '';
  const t = s
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  return undoubleUtf8(t).replace(/\s+/g, ' ').trim();
}

// Some sources serve UTF-8 bytes as Latin-1 ("MÃ©xico"): join lead+continuation pairs back.
function undoubleUtf8(s) {
  if (!/[\u00c2-\u00df][\u0080-\u00bf]/.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
    if (c >= 0xc2 && c <= 0xdf && n >= 0x80 && n <= 0xbf) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (n & 0x3f));
      i++;
    } else if (c > 0xff) {
      return s;
    } else {
      out += s.charAt(i);
    }
  }
  return out;
}

function getText(res) {
  if (!res) return '';
  if (typeof res.text === 'function') return res.text();
  if (typeof res.text === 'string') return res.text;
  return '';
}

function slugToTitle(slug) {
  return String(slug || '')
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const ITEM_ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;
const RESERVED_SLUGS = new Set([
  'directorio', 'horario', 'top', 'dash', 'comunidad', 'aplicacion', 'buscar',
  'historial', 'guardado', 'notificaciones', 'login', 'register', 'dashboard',
  'tipo', 'genero', 'estrenos', 'search', 'peliculas', 'series', 'anime', 'tv'
]);

function isValidSlug(s) {
  return typeof s === 'string' && ITEM_ID_RE.test(s) && !RESERVED_SLUGS.has(s);
}

/** Robust poster extractor: ignores data: placeholders, searches data-src/data-lazy-src/src, handles relative URLs. */
function extractPoster(htmlSnippet, baseDomain) {
  if (!htmlSnippet) return null;
  // Look for data-src, data-lazy-src, data-original, or src
  const re = /(?:data-src|data-lazy-src|data-original|data-srcset|srcset|src)=["']([^"'\s,]+)/gi;
  let m;
  let fallback = null;
  while ((m = re.exec(htmlSnippet)) !== null) {
    let candidate = m[1].trim();
    if (!candidate || candidate.startsWith('data:')) continue;
    if (candidate.startsWith('//')) candidate = 'https:' + candidate;
    else if (candidate.startsWith('/') && baseDomain) candidate = baseDomain.replace(/\/+$/, '') + candidate;
    if (candidate.startsWith('http')) return candidate;
    if (!fallback && candidate) fallback = candidate;
  }
  return fallback;
}

/** Best-effort "1080p" from a URL path/query, else null. */
function qualityFromUrl(u) {
  const m = /(?:^|[^\d])(2160|1080|720|576|480|360)p?(?=[^\d]|$)/i.exec(String(u || ''));
  return m ? m[1] + 'p' : null;
}

/** Label the player shows in "Servidor": "1080p: Net79", or whichever part is known. */
function srvLabel(q, server) {
  if (q && server) return q + ': ' + server;
  return q || server || null;
}

/** Rewrite a Stream's primary + alternatives labels as "quality: <name>" (apiVersion 6 shows the primary's label too). */
function labelStream(stream, name) {
  if (!stream || !stream.url) return stream;
  const qFrom = (url, lbl) => {
    if (typeof lbl === 'string') {
      const m = /^(\d{3,4}p)\b/.exec(lbl.trim());
      if (m) return m[1];
    }
    return qualityFromUrl(url);
  };
  const out = { ...stream };
  out.label = srvLabel(qFrom(out.url, out.label), name) || name;
  if (Array.isArray(out.alternatives)) {
    out.alternatives = out.alternatives.map((a) => ({
      ...a,
      label: srvLabel(qFrom(a.url, a.label), name) || name
    }));
  }
  return out;
}

/** Poster for a card whose image sits before the title anchor (bounded by the previous card's title). */
function extractCardPoster(html, anchorIndex, base) {
  const prev = html.lastIndexOf('title="', anchorIndex);
  const start = Math.max(prev >= 0 ? prev + 7 : 0, anchorIndex - 2000);
  return extractPoster(html.slice(start, anchorIndex + 600), base);
}

/** Sanitize a title/slug into a valid Kino item id (<=128 chars, ITEM_ID_RE charset). */
function sanitizeId(raw, prefix) {
  const base = String(raw || '').toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^-+|-+$/g, '');
  let id = (prefix ? prefix + '-' : '') + base;
  if (!ITEM_ID_RE.test(id)) id = id.replace(/[^A-Za-z0-9._~-]/g, '');
  return id.length > 128 ? id.slice(0, 128) : id;
}

/* ---------- logging & debug ---------- */

const PLUGIN_VERSION = '5.3.2';

function log(...args) {
  try {
    if (typeof kino !== 'undefined' && kino.log) {
      kino.log(`[YojaTV v${PLUGIN_VERSION}]`, ...args);
    }
  } catch {}
}

log(`Iniciando plugin YojaTV v${PLUGIN_VERSION} - Por JuandreXter, YojanderGaming y einer_bg`);

// Kino allows at most 60 kino.fetch per plugin call; count ours so the catalog enrichment
// stops before the engine rejects everything else in the same call.
let FETCH_BUDGET = 60;
function fetchBudgetReset() { FETCH_BUDGET = 60; }

async function fetchText(url, headers, timeoutMs) {
  if (FETCH_BUDGET <= 0) {
    log(`[HTTP GET BUDGET] cupo de 60 por llamada agotado <- ${url}`);
    return { ok: false, status: 0, text: '', budget: true };
  }
  FETCH_BUDGET--;
  log(`[HTTP GET] -> ${url}`);
  try {
    const opts = { headers: { ...HEADERS, ...(headers || {}) } };
    const t = Math.trunc(Number(timeoutMs));
    if (Number.isFinite(t) && t > 0) opts.timeoutMs = Math.min(t, 30000);
    const res = await kino.fetch(url, opts);
    if (!res.ok) {
      log(`[HTTP GET FAIL] ${res.status} <- ${url}`);
      return { ok: false, status: res.status, text: '' };
    }
    const txt = getText(res);
    log(`[HTTP GET OK] ${res.status} (${txt.length} chars) <- ${url}`);
    return { ok: true, status: res.status, text: txt, url: res.url };
  } catch (e) {
    log(`[HTTP GET ERROR] ${e ? e.message : e} <- ${url}`);
    return { ok: false, status: 0, text: '', error: e };
  }
}

async function fetchJson(url, headers) {
  const r = await fetchText(url, { Accept: 'application/json', ...(headers || {}) });
  if (!r.ok) return null;
  try {
    return JSON.parse(r.text);
  } catch (e) {
    log(`[JSON PARSE ERROR] <- ${url}`);
    return null;
  }
}

async function postForm(url, form, headers) {
  log(`[HTTP POST FORM] -> ${url}`);
  try {
    const res = await kino.fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', ...(headers || {}) },
      body: form
    });
    if (!res.ok) {
      log(`[HTTP POST FAIL] ${res.status} <- ${url}`);
      return null;
    }
    log(`[HTTP POST OK] ${res.status} <- ${url}`);
    return res;
  } catch (e) {
    log(`[HTTP POST ERROR] ${e ? e.message : e} <- ${url}`);
    return null;
  }
}

async function postJson(url, obj, headers) {
  log(`[HTTP POST JSON] -> ${url}`);
  try {
    const res = await kino.fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json', ...(headers || {}) },
      body: JSON.stringify(obj)
    });
    if (!res.ok) {
      log(`[HTTP POST JSON FAIL] ${res.status} <- ${url}`);
      return null;
    }
    log(`[HTTP POST JSON OK] ${res.status} <- ${url}`);
    return res;
  } catch (e) {
    log(`[HTTP POST JSON ERROR] ${e ? e.message : e} <- ${url}`);
    return null;
  }
}

/** kino.fetch, falling back to kino.browser.page when the plain fetch is blocked. */
async function getHtml(url, opts) {
  const o = opts || {};
  const plain = await fetchText(url, o.headers);
  if (plain.ok && plain.text && !isChallengePage(plain.text)) return plain;
  try {
    const page = await kino.browser.page(url, { waitFor: o.waitFor, timeoutMs: o.timeoutMs || 12000 });
    if (page && page.html) return { ok: true, status: page.status || 200, text: page.html, url: page.finalUrl || url };
  } catch (e) { /* browser unavailable under Node kit */ }
  return plain.ok ? plain : { ok: false, status: plain.status, text: '' };
}

function isChallengePage(html) {
  if (!html || html.length > 30000) return false;
  const t = html.toLowerCase();
  return t.includes('just a moment') || t.includes('cf-browser-verification') || t.includes('un momento') || t.includes('ddos-guard');
}

/** PelisGratisHDs' go_to_player arg: base64 of a rot13'd url. */
function decodePgh(s) {
  let b;
  try { b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; }
  const r = b.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
  return r.startsWith('http') ? r : null;
}

/** Pure JS unpacker for Dean Edwards p,a,c,k,e,d JavaScript */
function unpackDeanEdwards(p, a, c, k) {
  function e(c) {
    return (c < a ? '' : e(parseInt(c / a))) + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
  }
  while (c--) {
    if (k[c]) {
      p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]);
    }
  }
  return p;
}

function extractPackedJs(html) {
  if (!html) return '';
  const m = /eval\(function\(p,a,c,k,e,[rd]\)\{.*?return p\}\s*\('(.*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([^']*)'\.split\('\|'\)/s.exec(html);
  if (!m) return '';
  try {
    const p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    const a = parseInt(m[2], 10);
    const c = parseInt(m[3], 10);
    const k = m[4].split('|');
    return unpackDeanEdwards(p, a, c, k);
  } catch (err) {
    log(`[unpack ERROR] ${err ? err.message : err}`);
    return '';
  }
}

async function extractMediafire(embedUrl) {
  const r = await fetchText(embedUrl);
  if (!r.ok) return null;
  const m = r.text.match(/href="(https?:\/\/download[^"]+)"/i) || r.text.match(/aria-label="Download file"\s+href="([^"]+)"/i);
  return m ? m[1] : null;
}

async function extractMp4upload(embedUrl) {
  const r = await fetchText(embedUrl);
  if (!r.ok) return null;
  const m = r.text.match(/src:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i) || r.text.match(/player\.src\("(https?:\/\/[^"]+)"\)/i);
  return m ? m[1] : null;
}

function decodeVoePayload(ct, luts) {
  try {
    const rawLuts = luts.slice(2, -2).split("','");
    let txt = '';
    for (let i = 0; i < ct.length; i++) {
      let x = ct.charCodeAt(i);
      if (x > 64 && x < 91) {
        x = ((x - 52) % 26) + 65;
      } else if (x > 96 && x < 123) {
        x = ((x - 84) % 26) + 97;
      }
      txt += String.fromCharCode(x);
    }
    for (const lut of rawLuts) {
      txt = txt.split(lut).join('');
    }
    const b64_1 = atob(txt);
    let shifted = '';
    for (let i = 0; i < b64_1.length; i++) {
      shifted += String.fromCharCode(b64_1.charCodeAt(i) - 3);
    }
    const reversed = shifted.split('').reverse().join('');
    const finalJson = atob(reversed);
    return JSON.parse(finalJson);
  } catch (e) {
    return null;
  }
}

function binToHex(bin) {
  let hex = '';
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return hex;
}

// embed69-style pages: SHA-256 proof-of-work then AES-256-CBC over base64(IV||ct).
function solvePowKey(challenge, difficulty, salt) {
  const prefix = '0'.repeat(Math.max(1, difficulty | 0));
  for (let nonce = 0; nonce < 2000000; nonce++) {
    const hash = kino.crypto.hash('sha256', challenge + nonce);
    if (hash.startsWith(prefix)) return kino.crypto.hash('sha256', challenge + nonce + salt);
  }
  return null;
}

function decryptB64AesCbc(encB64, keyHex) {
  try {
    const raw = atob(encB64);
    if (raw.length <= 16) return null;
    return kino.crypto.decrypt('aes-256-cbc', {
      key: keyHex, keyEncoding: 'hex',
      iv: binToHex(raw.slice(0, 16)), ivEncoding: 'hex',
      data: btoa(raw.slice(16))
    });
  } catch { return null; }
}

async function resolveEmbed69(pageText, referer) {
  const powC = /const POW_CHALLENGE = '([^']+)'/.exec(pageText);
  const powD = /const POW_DIFFICULTY = (\d+)/.exec(pageText);
  const powS = /const POW_SALT = '([^']+)'/.exec(pageText);
  const dlM = /let dataLink = (\[[\s\S]*?\]);/.exec(pageText);
  if (!powC || !powS || !dlM) return null;
  const keyHex = solvePowKey(powC[1], powD ? +powD[1] : 3, powS[1]);
  if (!keyHex) return null;
  let dataLink;
  try { dataLink = JSON.parse(dlM[1]); } catch { return null; }
  if (!Array.isArray(dataLink) || !dataLink.length) return null;
  // Prefer the LATINO file, then any other.
  const files = dataLink.slice().sort((a, b) => (b.video_language === 'LAT') - (a.video_language === 'LAT'));
  const candidates = [];
  for (const f of files) {
    if (!f || !Array.isArray(f.sortedEmbeds)) continue;
    for (const e of f.sortedEmbeds) {
      if (!e || !e.link) continue;
      const url = decryptB64AesCbc(e.link, keyHex);
      if (url && url.startsWith('http') && !candidates.some((c) => c.url === url)) {
        candidates.push({ name: e.servername || 'Servidor', url });
      }
    }
  }
  for (const c of candidates.slice(0, 6)) {
    const st = await resolveEmbedUrl(c.url, referer);
    if (st && st.url) return st;
  }
  return null;
}

/* ---------- resolve stream collection ---------- */
// Lower is better. Host penalties first: a vimeos/goodstream URL is only offered
// when nothing healthier settled in time. vimeos = 99: its manifest 403s in the
// player while our own probe passes, so it must NEVER win as primary — it is
// offered only when it is the single candidate (last resort).
function streamScore(u) {
  if (u.includes('goodstream.one') || u.includes('goodstream.uno')) return 20;
  if (u.includes('vimeos.net') || u.includes('vimeos.zip')) return 99;
  if (/\.mp4(\?|$)/i.test(u)) return 1;
  if (/\.m3u8(\?|$)/i.test(u)) return 3;
  return 5;
}

// Collectors stop waiting at a healthy/low-score stream, but NEVER at vimeos:
// it stays in the race as a candidate and only surfaces if nothing else settles
// (their own timeoutMs bounds how long that wait can take).
function earlyExit(st) {
  const sc = streamScore(st.url);
  if (sc >= 99) return false;
  return st.probe === true || sc <= 5;
}

// Bait floor: the fake "intros" posing as movies measured 2.5 and 7.2 MB; any
// real movie/episode is orders of magnitude larger. Size comes free from the
// Range probe's Content-Range; unknown size keeps the stream (no false blocks).
const MIN_MP4_BYTES = 15 * 1024 * 1024;

function headerValue(headers, name) {
  if (!headers) return null;
  if (headers[name] != null) return headers[name];
  const low = name.toLowerCase();
  if (headers[low] != null) return headers[low];
  for (const k in headers) if (k.toLowerCase() === low) return headers[k];
  return null;
}

// Health check that EMULATES THE PLAYER's request: same method (GET), same
// headers, Range bytes=0-1 for progressive mp4, and cookies:false — the player
// has no cookie jar. A HEAD with plugin cookies can pass while the player still
// gets 403 (vimeos on device): only streams that answer this request are offered.
// For mp4 it also reads the total size from the Range response and drops bait
// files (fake intros smaller than MIN_MP4_BYTES). Verdicts are logged so device
// logs show WHY a server was dropped.
async function probeStream(url, headers) {
  const h = { ...HEADERS, ...(headers || {}) };
  const isMp4 = /\.mp4(\?|$)/i.test(url);
  if (isMp4) h.Range = 'bytes=0-1';
  try {
    const res = await kino.fetch(url, { method: 'GET', headers: h, cookies: false, timeoutMs: 8000 });
    const ok = !!res && (res.ok || res.status === 206);
    if (!ok) {
      log(`[probe] descartado (${res && res.status ? res.status : 'err'}) <- ${url}`);
      return false;
    }
    let sizeNote = '';
    if (isMp4) {
      const cr = String(headerValue(res.headers, 'Content-Range') || '');
      const total = cr.includes('/') ? parseInt(cr.split('/')[1], 10) : parseInt(headerValue(res.headers, 'Content-Length') || '0', 10);
      if (total > 0 && total < MIN_MP4_BYTES) {
        log(`[probe] descartado (cebo ${(total / 1048576).toFixed(1)}MB < 15MB) <- ${url}`);
        return false;
      }
      if (total >= MIN_MP4_BYTES) sizeNote = ` ${(total / 1048576).toFixed(0)}MB`;
    }
    log(`[probe] ok (${res.status}${sizeNote}) <- ${url}`);
    return true;
  } catch (e) {
    log(`[probe] descartado (${e && e.message ? e.message : 'err'}) <- ${url}`);
    return false;
  }
}

// Runs every probe in parallel and STOPS WAITING at the first healthy stream
// (a health-checked URL or a low-score one), so one server that hangs — goodstream
// used to block an entire resolve for 15 s — no longer stalls the answer. The
// remaining probes keep running under their own timeoutMs but are not awaited.
async function collectStreams(probes) {
  const pending = probes.map((p) => Promise.resolve(p).then((v) => v, () => null));
  const results = [];
  while (pending.length > 0) {
    const raced = pending.map((p) => p.then((v) => ({ p, v })));
    const done = await Promise.race(raced);
    const i = pending.indexOf(done.p);
    if (i >= 0) pending.splice(i, 1);
    const st = done.v;
    if (!st || !st.url) continue;
    if (results.some((x) => x.url === st.url)) {
      if (earlyExit(st)) break;
      continue;
    }
    results.push(st);
    if (earlyExit(st)) break;
  }
  return results
    .sort((a, b) => streamScore(a.url) - streamScore(b.url))
    .map((s) => {
      const clean = {};
      for (const k in s) if (k !== 'probe') clean[k] = s[k];
      return clean;
    });
}

async function resolveEmbedUrl(embedUrl, referer) {
  if (!embedUrl || typeof embedUrl !== 'string') return null;
  let u = embedUrl.trim();
  if (u.startsWith('//')) u = 'https:' + u;
  if (!u.startsWith('http')) return null;
  if (u.includes('youtube.com') || u.includes('youtu.be')) return null;
  if (u.includes('bigbuckbunny') || u.includes('test-videos.co.uk')) return null;

  if (u.includes('player.zilla-networks.com')) {
    const directZilla = u.replace('/play/', '/m3u8/');
    return { url: directZilla, headers: { 'User-Agent': UA, 'Referer': referer || 'https://animeav1.com/' } };
  }

  if (/\.(m3u8|mp4)($|\?)/i.test(u) && !u.includes('/e/') && !u.includes('/embed') && !u.includes('streamtape.com')) {
    const headers = { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) };
    if (/\.mp4($|\?)/i.test(u)) {
      // Direct mp4: reachability + bait-size gate (fake intros live here).
      if (!(await probeStream(u, headers))) return null;
      return { url: u, headers, probe: true };
    }
    return { url: u, headers };
  }

  if (u.includes('embed69.org') || u.includes('pelisserieshoy.com')) {
    const pg = await fetchText(u, { Referer: referer });
    if (pg.ok) {
      const st = await resolveEmbed69(pg.text, u);
      if (st && st.url) return st;
    }
    return null;
  }

  if (u.includes('vimeos.net') || u.includes('vimeos.zip')) {
    const v = await fetchText(u, { Referer: referer || 'https://vimeos.net/' }, 12000);
    if (v.ok) {
      const unpacked = extractPackedJs(v.text);
      const m3u = (unpacked || v.text).match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) {
        // Probe with the player's exact request (GET, no cookie jar): a CDN
        // that 403s the player is not worth offering.
        const headers = { 'User-Agent': UA, Referer: u };
        if (await probeStream(m3u[1], headers)) return { url: m3u[1], headers, probe: true };
        log(`[vimeos] manifiesto no reproduce desde este dispositivo <- ${u}`);
        return null;
      }
      const mp4 = (unpacked || v.text).match(/(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/i);
      if (mp4 && !mp4[1].includes('bigbuckbunny') && !mp4[1].includes('test-videos')) {
        const headers = { 'User-Agent': UA, Referer: u };
        if (await probeStream(mp4[1], headers)) return { url: mp4[1], headers, probe: true };
        log(`[vimeos] mp4 no reproduce desde este dispositivo <- ${u}`);
        return null;
      }
    }
    return null;
  }

  if (u.includes('goodstream.one') || u.includes('goodstream.uno')) {
    const g = await fetchText(u, { Referer: referer || 'https://goodstream.one/' }, 6000);
    if (g.ok) {
      const unpacked = extractPackedJs(g.text);
      const m3u = (unpacked || g.text).match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) {
        const headers = { 'User-Agent': UA, Referer: 'https://goodstream.one/' };
        if (await probeStream(m3u[1], headers)) return { url: m3u[1], headers, probe: true };
        log(`[goodstream] manifiesto no reproduce <- ${u}`);
        return null;
      }
      const mp4 = (unpacked || g.text).match(/(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/i);
      if (mp4 && !mp4[1].includes('bigbuckbunny') && !mp4[1].includes('test-videos')) {
        const headers = { 'User-Agent': UA, Referer: 'https://goodstream.one/' };
        if (await probeStream(mp4[1], headers)) return { url: mp4[1], headers, probe: true };
        log(`[goodstream] mp4 no reproduce <- ${u}`);
        return null;
      }
    }
    return null;
  }

  if (u.includes('videoapp.zip')) {
    const va = await fetchText(u, { Referer: referer || 'https://videoapp.zip/' });
    if (va.ok) {
      const ifr = /<iframe[^>]+src="([^"]+)"/i.exec(va.text);
      if (ifr) return resolveEmbedUrl(ifr[1], u);
    }
    return null;
  }

  // VOE rotates its alias domains over time; keep the known set in one place.
  const VOE_HOSTS = ['voe.sx', 'megankiddifference.com', 'chaliceguzzlerlandlord.com', 'derricknationtop.com', 'opuxa.lat'];
  if (VOE_HOSTS.some((h) => u.includes(h))) {
    const vo = await fetchText(u, { Referer: referer });
    if (vo.ok) {
      // 1. Check for VOE's encrypted JSON payload + loader script
      const payloadM = vo.text.match(/json">\["([^"]+)"]<\/script>\s*<script\s*src="([^"]+)/);
      if (payloadM) {
        let scriptUrl = payloadM[2];
        if (scriptUrl.startsWith('//')) scriptUrl = 'https:' + scriptUrl;
        else if (scriptUrl.startsWith('/')) {
          try {
            const origin = new URL(u).origin;
            scriptUrl = origin + scriptUrl;
          } catch {
            scriptUrl = 'https://megankiddifference.com' + scriptUrl;
          }
        }
        const sRes = await fetchText(scriptUrl, { Referer: u });
        if (sRes.ok) {
          const lutsM = sRes.text.match(/(\[(?:'\W{2}'[,\]]){1,9})/);
          if (lutsM) {
            const decoded = decodeVoePayload(payloadM[1], lutsM[1]);
            if (decoded && decoded.source && !decoded.source.includes('bigbuckbunny') && !decoded.source.includes('test-videos')) {
              return { url: decoded.source, headers: { 'User-Agent': UA, Referer: u } };
            }
          }
        }
      }
      // 2. Direct HLS
      const m3u = vo.text.match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) return { url: m3u[1], headers: { 'User-Agent': UA, Referer: u } };
      // 3. JS-redirect follow
      const redir = /(?:window\.location\.href|location\.href)\s*=\s*['"]([^'"]+)['"]/i.exec(vo.text);
      if (redir && !VOE_HOSTS.some((h) => redir[1].includes(h)) && !redir[1].includes(u)) return resolveEmbedUrl(redir[1], u);
    }
    return null;
  }

  if (u.includes('filemoon.sx')) {
    const fm = await fetchText(u, { Referer: referer });
    if (fm.ok) {
      const unpacked = extractPackedJs(fm.text);
      const m3u = (unpacked || fm.text).match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) return { url: m3u[1], headers: { 'User-Agent': UA } };
    }
    return null;
  }

  if (u.includes('mediafire.com')) {
    const mf = await extractMediafire(u);
    if (mf) return { url: mf };
    return null;
  }

  if (u.includes('mp4upload.com')) {
    const mp = await extractMp4upload(u);
    if (mp) return { url: mp };
    return null;
  }

  if (u.includes('vidhide') || u.includes('callistanise.com')) {
    const vh = await fetchText(u, { Referer: referer });
    if (vh.ok) {
      const unpacked = extractPackedJs(vh.text);
      const m3u = (unpacked || vh.text).match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) return { url: m3u[1], headers: { 'User-Agent': UA, 'Referer': u } };
    }
    return null;
  }

  if (u.includes('streamwish') || u.includes('flaswish.com') || u.includes('sfastwish.com')) {
    const sw = await fetchText(u, { Referer: referer });
    if (sw.ok) {
      const unpacked = extractPackedJs(sw.text);
      const m3u = (unpacked || sw.text).match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) return { url: m3u[1], headers: { 'User-Agent': UA, 'Referer': u } };
    }
    return null;
  }

  // Generic embed inspection
  try {
    const gen = await fetchText(u, { Referer: referer }, 10000);
    if (gen.ok) {
      // Check for VOE pattern on unbranded mirror
      const payloadM = gen.text.match(/json">\["([^"]+)"]<\/script>\s*<script\s*src="([^"]+)/);
      if (payloadM) {
        let scriptUrl = payloadM[2];
        if (scriptUrl.startsWith('//')) scriptUrl = 'https:' + scriptUrl;
        else if (scriptUrl.startsWith('/')) {
          try { scriptUrl = new URL(u).origin + scriptUrl; } catch {}
        }
        const sRes = await fetchText(scriptUrl, { Referer: u });
        if (sRes.ok) {
          const lutsM = sRes.text.match(/(\[(?:'\W{2}'[,\]]){1,9})/);
          if (lutsM) {
            const decoded = decodeVoePayload(payloadM[1], lutsM[1]);
            if (decoded && decoded.source && !decoded.source.includes('bigbuckbunny') && !decoded.source.includes('test-videos')) {
              return { url: decoded.source, headers: { 'User-Agent': UA, Referer: u } };
            }
          }
        }
      }

      const unpacked = extractPackedJs(gen.text);
      const m3u = (unpacked || gen.text).match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) return { url: m3u[1], headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) } };
      const mp4 = (unpacked || gen.text).match(/(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/i);
      if (mp4 && !mp4[1].includes('bigbuckbunny') && !mp4[1].includes('test-videos')) {
        return { url: mp4[1], headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) } };
      }
      const ifr = /<iframe[^>]+src="([^"]+)"/i.exec(gen.text);
      if (ifr && !ifr[1].includes(u)) return resolveEmbedUrl(ifr[1], u);
    }
  } catch {}

  return null;
}

/* ---------- source registry ---------- */
// Each entry: { id, label, host, mode, search(q), home(), detail(ref), episodes(ref), resolve(ref) }
// `ref` is the source-local path; the plugin's public ref is "<id>:<path>".

const SOURCES = {};

function registerSource(src) { SOURCES[src.id] = src; }

/* --- VPO (ver-peliculas-online.net) --- */
registerSource({
  id: 'vpo',
  label: 'Ver Películas Online',
  kind: 'movie',
  async search(q) {
    const r = await fetchText('https://ver-peliculas-online.net/?s=' + encodeURIComponent(q));
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const cardRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
    let m;
    while ((m = cardRe.exec(r.text)) !== null) {
      const block = m[1];
      const linkM = block.match(/href="https:\/\/ver-peliculas-online\.net\/(pelicula|serie)\/([^"\/]+)\/?"/i);
      if (!linkM) continue;
      const type = linkM[1] === 'serie' ? 'series' : 'movie';
      const slug = linkM[2].trim();
      const id = sanitizeId(slug, 'vpo');
      if (seen.has(id)) continue;
      seen.add(id);
      const titleM = block.match(/alt="([^"]+)"/i) || block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      const poster = extractPoster(block, 'https://ver-peliculas-online.net');
      items.push({ id, ref: 'vpo:' + type + ':' + slug, title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: type, poster });
    }
    return items;
  },
  async home() {
    const r = await fetchText('https://ver-peliculas-online.net/');
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const cardRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
    let m;
    while ((m = cardRe.exec(r.text)) !== null) {
      const block = m[1];
      const linkM = block.match(/href="https:\/\/ver-peliculas-online\.net\/(pelicula|serie)\/([^"\/]+)\/?"/i);
      if (!linkM) continue;
      const type = linkM[1] === 'serie' ? 'series' : 'movie';
      const slug = linkM[2].trim();
      const id = sanitizeId(slug, 'vpo');
      if (seen.has(id)) continue;
      seen.add(id);
      const titleM = block.match(/alt="([^"]+)"/i) || block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
      const poster = extractPoster(block, 'https://ver-peliculas-online.net');
      items.push({ id, ref: 'vpo:' + type + ':' + slug, title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: type, poster, badges: ['HD'] });
    }
    return items;
  },
  async resolve(path) {
    const [type, slug] = path.split(':');
    if (type !== 'movie') return null;
    const movieUrl = 'https://ver-peliculas-online.net/pelicula/' + slug + '/';
    const r = await fetchText(movieUrl);
    if (!r.ok) return null;
    const postIdM = r.text.match(/<body[^>]*class="[^"]*postid-(\d+)[^"]*"/i) || r.text.match(/id="post-(\d+)"/i);
    if (!postIdM) return null;
    const postTasks = [1, 2, 3, 4, 5, 6].map(async (nume) => {
      const res = await postForm('https://ver-peliculas-online.net/wp-admin/admin-ajax.php',
        'action=doo_player_ajax&post=' + postIdM[1] + '&type=movie&nume=' + nume, { Referer: movieUrl });
      if (!res) return null;
      let embed = null;
      try {
        const j = typeof res.json === 'function' ? res.json() : JSON.parse(getText(res));
        if (j && typeof j.embed_url === 'string' && j.embed_url.startsWith('http')) embed = j.embed_url.trim();
      } catch {}
      if (!embed) return null;
      const st = await resolveEmbedUrl(embed, movieUrl);
      return (st && st.url) ? { label: 'VPO ' + nume, ...st } : null;
    });

    const streams = await collectStreams(postTasks);
    if (streams.length === 0) return null;

    const primary = streams[0];
    const alts = streams.slice(1, 8).map((s) => ({
      label: s.label,
      url: s.url,
      ...(s.headers ? { headers: s.headers } : {})
    }));

    return {
      url: primary.url,
      ...(primary.headers ? { headers: primary.headers } : {}),
      ...(alts.length > 0 ? { alternatives: alts } : {})
    };
  },
  async episodes(path) {
    const [type, slug] = path.split(':');
    if (type === 'movie') return { episodes: [] };
    const r = await fetchText('https://ver-peliculas-online.net/serie/' + slug + '/');
    if (!r.ok) return { episodes: [] };
    const list = [];
    const epRe = new RegExp('/serie/' + slug.replace(/[-]/g, '[-]') + '/temporada-(\\d+)/capitulo-(\\d+)/', 'gi');
    let m;
    const seen = new Set();
    while ((m = epRe.exec(r.text)) !== null) {
      const key = m[1] + '-' + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ season: +m[1], number: +m[2], title: 'T' + m[1] + 'E' + m[2], ref: 'vpo:' + slug + ':' + m[1] + ':' + m[2] });
    }
    return { episodes: list };
  }
});

/* --- JKANIME (anime) --- */
registerSource({
  id: 'jkanime',
  label: 'JKAnime',
  kind: 'anime',
  async search(q) {
    const r = await fetchText('https://jkanime.net/buscar/' + encodeURIComponent(q) + '/');
    if (!r.ok) return [];
    const match = r.text.match(/var\s+animes\s*=\s*(\{[\s\S]*?\});\s*(?:var|\n|<)/);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        const list = Array.isArray(data.data) ? data.data : [];
        if (list.length > 0) {
          return list.map((x) => {
            const slug = (x.slug || '').trim();
            if (!isValidSlug(slug)) return null;
            const isMovie = (x.tipo && x.tipo.toLowerCase().includes('pel')) || slug.includes('pelicula');
            return { id: slug, ref: 'jkanime:' + slug, title: cleanText(x.title) || slugToTitle(slug), kind: isMovie ? 'movie' : 'series', poster: x.image || null, overview: cleanText(x.synopsis || '') };
          }).filter(Boolean);
        }
      } catch {}
    }
    const items = [];
    const seen = new Set();
    const cardRe = /<a[^>]+href="https:\/\/jkanime\.net\/([a-z0-9-]+)\/"[^>]*>[\s\S]{0,300}?<h5>([^<]+)<\/h5>/gi;
    let cm;
    while ((cm = cardRe.exec(r.text)) !== null) {
      const slug = cm[1];
      if (!isValidSlug(slug) || seen.has(slug)) continue;
      seen.add(slug);
      items.push({ id: slug, ref: 'jkanime:' + slug, title: cleanText(cm[2]) || slugToTitle(slug), kind: 'series' });
    }
    return items;
  },
  async home() {
    const r = await fetchText('https://jkanime.net/');
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<div class="card">\s*<a href="https:\/\/jkanime\.net\/([a-z0-9-]+)\/">[\s\S]{0,400}?<img[^>]+alt="([^"]+)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const slug = m[1];
      if (!isValidSlug(slug)) continue;
      if (seen.has(slug)) continue;
      seen.add(slug);
      items.push({ id: slug, ref: 'jkanime:' + slug, title: cleanText(m[2]) || slugToTitle(slug), kind: 'series' });
    }
    return items;
  },
  async episodes(path) {
    const slug = path.split('/')[0];
    if (!isValidSlug(slug)) return { episodes: [] };
    const r = await fetchText('https://jkanime.net/' + slug + '/');
    if (!r.ok) return { episodes: [] };
    let maxEp = 0;
    const epNumRe = new RegExp(slug.replace(/-/g, '-') + '\\/(\\d+)\\/', 'gi');
    let em;
    while ((em = epNumRe.exec(r.text)) !== null) { const n = +em[1]; if (n > maxEp) maxEp = n; }
    if (maxEp <= 0) maxEp = 1;
    if (maxEp > 5000) maxEp = 5000;
    return { episodes: Array.from({ length: maxEp }, (_, i) => ({ number: i + 1, season: 1, title: 'Episodio ' + (i + 1), ref: 'jkanime:' + slug + '/' + (i + 1) })) };
  },
  async resolve(path) {
    const epPath = path.endsWith('/') ? path : path + '/';
    const r = await fetchText('https://jkanime.net/' + epPath);
    if (!r.ok) return null;
    const serversMatch = r.text.match(/var\s+servers\s*=\s*(\[[\s\S]*?\]);/);
    if (!serversMatch) return null;
    let list;
    try { list = JSON.parse(serversMatch[1]); } catch { return null; }
    if (!Array.isArray(list) || list.length === 0) return null;

    const serverTasks = list.map(async (s) => {
      if (!s.remote) return null;
      let decoded = '';
      try { decoded = atob(String(s.remote).trim()); } catch { return null; }
      if (!decoded.startsWith('http')) return null;
      const serverName = (s.server || 'Servidor').trim();
      const st = await resolveEmbedUrl(decoded, 'https://jkanime.net/');
      if (st && st.url) return { label: serverName + (s.size ? ' (' + s.size + ')' : ''), ...st };
      return null;
    });

    const streams = await collectStreams(serverTasks);
    if (streams.length === 0) return null;

    const primary = streams[0];
    const alts = streams.slice(1, 8).map((st) => ({
      label: st.label,
      url: st.url,
      ...(st.headers ? { headers: st.headers } : {})
    }));

    return {
      url: primary.url,
      ...(primary.headers ? { headers: primary.headers } : {}),
      ...(alts.length > 0 ? { alternatives: alts } : {})
    };
  }
});

/* --- CINECALIDAD (DooPlay variant, direct data-option embeds) --- */
registerSource({
  id: 'cc',
  label: 'CineCalidad',
  kind: 'movie',
  async search(q) {
    const r = await fetchText('https://www.cinecalidad.am/?s=' + encodeURIComponent(q));
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<article id="post-(\d+)"[^>]*>([\s\S]*?)(?=<article id="post-|<\/main>|<footer)/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const block = m[2];
      const hrefM = /href="(https:\/\/www\.cinecalidad\.am\/ver-(pelicula|serie)\/([^"\/]+)\/?)"/.exec(block);
      if (!hrefM) continue;
      const type = hrefM[2] === 'serie' ? 'series' : 'movie';
      const slug = hrefM[3];
      const id = sanitizeId(slug, 'cc');
      if (seen.has(id)) continue;
      seen.add(id);
      const titleM = /alt="([^"]+)"/.exec(block);
      const imgM = /data-src="([^"]+)"/.exec(block) || /src="(https?:\/\/[^"]+)"/.exec(block);
      items.push({ id, ref: 'cc:' + type + ':' + slug, title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: type, poster: imgM ? imgM[1] : null });
    }
    return items;
  },
  async home() {
    const r = await fetchText('https://www.cinecalidad.am/');
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<article id="post-(\d+)"[^>]*>([\s\S]*?)(?=<article id="post-|<\/main>|<footer)/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const block = m[2];
      const hrefM = /href="(https:\/\/www\.cinecalidad\.am\/ver-(pelicula|serie)\/([^"\/]+)\/?)"/.exec(block);
      if (!hrefM) continue;
      const type = hrefM[2] === 'serie' ? 'series' : 'movie';
      const slug = hrefM[3];
      const id = sanitizeId(slug, 'cc');
      if (seen.has(id)) continue;
      seen.add(id);
      const titleM = /alt="([^"]+)"/.exec(block);
      const imgM = /data-src="([^"]+)"/.exec(block) || /src="(https?:\/\/[^"]+)"/.exec(block);
      items.push({ id, ref: 'cc:' + type + ':' + slug, title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: type, poster: imgM ? imgM[1] : null, badges: ['HD', 'LATINO'] });
    }
    return items;
  },
  async episodes(path) {
    const [type, slug] = path.split(':');
    if (type !== 'series') return { episodes: [] };
    const r = await fetchText('https://www.cinecalidad.am/ver-serie/' + slug + '/');
    if (!r.ok) return { episodes: [] };
    const episodes = [];
    const epRe = /<div class="numerando">S(\d+)-E(\d+)<\/div>\s*<div class="episodiotitle">\s*<a href="([^"]+)"/g;
    let em;
    const seen = new Set();
    while ((em = epRe.exec(r.text)) !== null) {
      const s = +em[1], e = +em[2];
      const key = s + '-' + e;
      if (seen.has(key)) continue;
      seen.add(key);
      episodes.push({ season: s, number: e, title: 'T' + s + 'E' + e, ref: 'cc:' + em[3] });
    }
    return { episodes };
  },
  async resolve(path) {
    let url = path;
    if (!url.startsWith('http')) {
      const parts = path.split(':');
      const type = parts.length > 1 ? parts[0] : 'movie';
      const slug = parts.pop();
      url = 'https://www.cinecalidad.am/' + (type === 'series' ? 'ver-serie/' : 'ver-pelicula/') + slug + '/';
    }
    const r = await fetchText(url);
    if (!r.ok) return null;
    const opts = [];
    const optRe = /data-option="([^"]+)"/g;
    let om;
    while ((om = optRe.exec(r.text)) !== null) opts.push(om[1]);
    if (opts.length === 0) return null;

    const streams = await collectStreams(opts.map((opt) => resolveEmbedUrl(opt, url)));

    if (streams.length === 0) return null;

    const primary = streams[0];
    const alts = streams.slice(1, 8).map((st, i) => ({
      label: st.label || 'Servidor ' + (i + 2),
      url: st.url,
      ...(st.headers ? { headers: st.headers } : {})
    }));
    return {
      url: primary.url,
      ...(primary.headers ? { headers: primary.headers } : {}),
      ...(alts.length > 0 ? { alternatives: alts } : {})
    };
  }
});

/* --- HACKSTORE --- */
registerSource({
  id: 'hs',
  label: 'Hackstore',
  kind: 'movie',
  async search(q) {
    const r = await fetchText('https://www.hackstore.fo/?s=' + encodeURIComponent(q));
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<a[^>]+href="https:\/\/www\.hackstore\.fo\/(peliculas|series|animes)\/([^"\/]+)\/"[^>]*title="([^"]+)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const cat = m[1];
      const slug = m[2];
      const type = cat === 'series' ? 'series' : 'movie';
      const id = sanitizeId(slug, 'hs');
      if (seen.has(id)) continue;
      seen.add(id);
      const poster = extractCardPoster(r.text, m.index, 'https://www.hackstore.fo');
      items.push({ id, ref: 'hs:' + cat + ':' + slug, title: cleanText(m[3]) || slugToTitle(slug), kind: type, poster: poster || null });
    }
    return items;
  },
  async home() {
    const r = await fetchText('https://www.hackstore.fo/');
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<a[^>]+href="https:\/\/www\.hackstore\.fo\/(peliculas|series|animes)\/([^"\/]+)\/"[^>]*title="([^"]+)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const cat = m[1];
      const slug = m[2];
      const type = cat === 'series' ? 'series' : 'movie';
      const id = sanitizeId(slug, 'hs');
      if (seen.has(id)) continue;
      seen.add(id);
      const poster = extractCardPoster(r.text, m.index, 'https://www.hackstore.fo');
      const yearM = /\((\d{4})\)/.exec(m[3]);
      items.push({ id, ref: 'hs:' + cat + ':' + slug, title: cleanText(m[3]) || slugToTitle(slug), kind: type, poster: poster || null, year: yearM ? yearM[1] : null, badges: ['ESTRENO'] });
    }
    return items;
  },
  async resolve(path) {
    const [cat, slug] = path.split(':');
    const detailUrl = 'https://www.hackstore.fo/' + cat + '/' + slug + '/';
    const r = await fetchText(detailUrl);
    if (!r.ok) return null;

    const playMatches = [];
    const playRe = /play\.php\?u=([^&"'\s<>]+)&b=([^&"'\s<>]+)/g;
    let pm;
    while ((pm = playRe.exec(r.text)) !== null) {
      const u = 'https://www.hackstore.fo/play.php?u=' + pm[1] + '&b=' + pm[2];
      if (!playMatches.includes(u)) playMatches.push(u);
    }
    if (playMatches.length === 0) return null;

    async function resolvePlay(playUrl) {
      const p = await fetchText(playUrl, { Referer: detailUrl });
      if (!p.ok) return null;
      const locM = /location\.href\s*=\s*['"]([^'"]+)['"]/i.exec(p.text);
      const iframeM = /<iframe[^>]+src="([^"]+)"/i.exec(p.text);
      const target = locM ? locM[1] : (iframeM ? iframeM[1] : null);
      if (!target) {
        // Inline player — try packed JS extraction
        const unpacked = extractPackedJs(p.text);
        const m3u = (unpacked || p.text).match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
        if (m3u) return { url: m3u[1], headers: { 'User-Agent': UA, 'Referer': detailUrl } };
        return null;
      }
      // Use resolveEmbedUrl: handles vimeos, videoapp.zip→vimeos, voe.sx redirect, etc.
      return resolveEmbedUrl(target.startsWith('//') ? 'https:' + target : target, playUrl);
    }

    const streams = await collectStreams(playMatches.map((pu) => resolvePlay(pu)));
    if (streams.length === 0) return null;

    const primary = streams[0];
    const alts = streams.slice(1, 8).map((st, i) => ({
      label: 'Servidor ' + (i + 2),
      url: st.url,
      ...(st.headers ? { headers: st.headers } : {})
    }));
    return {
      url: primary.url,
      ...(primary.headers ? { headers: primary.headers } : {}),
      ...(alts.length > 0 ? { alternatives: alts } : {})
    };
  }
});

/* --- CINEHDPLUS --- */
registerSource({
  id: 'chp',
  label: 'CineHDPlus',
  kind: 'movie',
  async search(q) {
    const j = await fetchJson('https://cinehdplus.org/wp-json/api_v1/buscar/?keyword=' + encodeURIComponent(q));
    if (!Array.isArray(j)) return [];
    return j.slice(0, 40).map((x) => {
      const permalink = x.permalink || '';
      const slugM = /\/pelicula-[^/]+\/([^/]+)\/?$|\/series-[^/]+\/([^/]+)\/?$|\/[^/]+\/([^/]+)\/?$/.exec(permalink);
      const slug = slugM ? (slugM[1] || slugM[2] || slugM[3]) : '';
      const type = String(x.type || '').toLowerCase().includes('serie') ? 'series' : 'movie';
      const id = sanitizeId(String(x.id || slug), 'chp');
      return { id, ref: 'chp:' + type + ':' + permalink, title: cleanText(x.title) || slugToTitle(slug), kind: type, poster: x.thumbnail || null, year: x.meta && x.meta.date ? x.meta.date : null };
    }).filter((x) => x.ref);
  },
  async resolve(path) {
    const idx = path.indexOf(':');
    const type = idx >= 0 ? path.slice(0, idx) : path;
    const permalink = idx >= 0 ? path.slice(idx + 1) : '';
    if (!permalink) return null;
    const r = await fetchText(permalink);
    if (!r.ok) return null;
    const iframeM = /<iframe[^>]+src="(\/\/api\.cinehdplus\.org\/ir\/player\.php\?h=[^"]+)"/i.exec(r.text);
    if (!iframeM) return null;
    const playerUrl = 'https:' + iframeM[1];
    const p = await fetchText(playerUrl, { Referer: permalink });
    if (!p.ok) return null;
    const gotoM =
      /href="((?:https:)?\/\/api\.cinehdplus\.org\/ir\/goto\.php\?h=[^"']+|goto\.php\?h=[^"']+)"/i.exec(p.text) ||
      /location\.href\s*=\s*["']((?:https:)?\/\/api\.cinehdplus\.org\/ir\/goto\.php\?h=[^"']+|goto\.php\?h=[^"']+)["']/i.exec(p.text);
    if (gotoM) {
      let gotoUrl = gotoM[1];
      if (gotoUrl.startsWith('goto.php')) gotoUrl = 'https://api.cinehdplus.org/ir/' + gotoUrl;
      else if (gotoUrl.startsWith('//')) gotoUrl = 'https:' + gotoUrl;
      const g = await fetchText(gotoUrl, { Referer: playerUrl });
      if (g.ok) {
        const m3u = g.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
        if (m3u) return { url: m3u[1] };
        const voeM = /href="(https?:\/\/voe\.sx\/e\/[^"]+)"/i.exec(g.text);
        if (voeM) {
          const v = await fetchText(voeM[1]);
          if (v.ok) {
            const m3u2 = v.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
            if (m3u2) return { url: m3u2[1] };
          }
        }
        // redir chain: redir_ddh.php → rd.php (Base64+ROT13 encoded URL)
        const rdM = /href="(https?:\/\/api\.cinehdplus\.org\/ir\/rd\.php[^"]+)"/i.exec(g.text);
        if (rdM) {
          const rd = await fetchText(rdM[1], { Referer: gotoUrl });
          if (rd.ok) {
            const m3u3 = rd.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
            if (m3u3) return { url: m3u3[1] };
            const ifrM = /<iframe[^>]+src="([^"]+)"/i.exec(rd.text);
            if (ifrM) return { url: ifrM[1] };
          }
        }
      }
    }
    const m3u3 = p.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    return m3u3 ? { url: m3u3[1] } : null;
  }
});

/* --- CINEHAX --- */
registerSource({
  id: 'chx',
  label: 'CineHax',
  kind: 'movie',
  async search(q) {
    const r = await fetchText('https://cinehax.com/buscar/?q=' + encodeURIComponent(q));
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /href="\/ver\/\?tipo=(pelicula|serie)(?:&#038;|&)id=(\d+)(?:&#038;|&)?(?:season=(\d+))?(?:&#038;|&)?(?:episode=(\d+))?"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const tipo = m[1], id = m[2];
      const type = tipo === 'serie' ? 'series' : 'movie';
      const id2 = sanitizeId(id, 'chx');
      if (seen.has(id2)) continue;
      seen.add(id2);
      const block = r.text.slice(Math.max(0, m.index - 600), m.index + 600);
      const titleM = /alt="([^"]+)"/.exec(block) || /<h[23][^>]*>([^<]+)<\/h[23]>/i.exec(block);
      const imgM = /src="([^"]+)"/.exec(block);
      items.push({ id: id2, ref: 'chx:' + tipo + ':' + id, title: cleanText(titleM ? titleM[1] : '') || ('ID ' + id), kind: type, poster: imgM ? imgM[1] : null });
    }
    return items;
  },
  async episodes(path) {
    const [tipo, id] = path.split(':');
    if (tipo !== 'serie') return { episodes: [] };
    const r = await fetchText('https://cinehax.com/ver/?tipo=serie&id=' + id + '&season=1&episode=1');
    if (!r.ok) return { episodes: [] };
    const list = [];
    const epRe = /season=(\d+)[^"]*episode=(\d+)/g;
    let m;
    const seen = new Set();
    while ((m = epRe.exec(r.text)) !== null) {
      const key = m[1] + '-' + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ season: +m[1], number: +m[2], title: 'T' + m[1] + 'E' + m[2], ref: 'chx:serie:' + id + ':' + m[1] + ':' + m[2] });
    }
    return { episodes: list };
  },
  async resolve(path) {
    const parts = path.split(':');
    const tipo = parts[0], id = parts[1];
    const season = parts[2] || '1', episode = parts[3] || '1';
    const detailUrl = tipo === 'serie'
      ? 'https://cinehax.com/ver/?tipo=serie&id=' + id + '&season=' + season + '&episode=' + episode
      : 'https://cinehax.com/ver/?tipo=pelicula&id=' + id;
    const r = await fetchText(detailUrl);
    if (!r.ok) return null;
    const nonceM = /nonce"?\s*[:=]\s*"([^"]+)"/.exec(r.text);
    if (!nonceM) return null;
    // Fixed: nonce param name, tipo→type, added server=0
    let body = 'action=cinehax_get_embed&nonce=' + encodeURIComponent(nonceM[1]) + '&id=' + id + '&type=' + tipo + '&server=0';
    if (tipo === 'serie') body += '&season=' + season + '&episode=' + episode;
    const res = await postForm('https://cinehax.com/wp-admin/admin-ajax.php', body, { Referer: detailUrl });
    if (!res) return null;
    const txt = getText(res);
    // Response: {"success":true,"data":{"url":"https://unlimplay.com/..."}}
    let embedUrl = null;
    try {
      const j = JSON.parse(txt);
      if (j && j.success && j.data && j.data.url) embedUrl = j.data.url;
    } catch {}
    if (!embedUrl) {
      const m3u = txt.match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) return { url: m3u[1] };
      const mp4 = txt.match(/(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/i);
      if (mp4) return { url: mp4[1] };
      const urlM = /"url"\s*:\s*"(https?:\/\/[^"]+)"/i.exec(txt);
      if (urlM) embedUrl = urlM[1];
    }
    if (!embedUrl) return null;
    const st = await resolveEmbedUrl(embedUrl, detailUrl);
    return (st && st.url) ? st : null;
  }
});

/* --- SOLOLATINO --- */
registerSource({
  id: 'sl',
  label: 'SoloLatino',
  kind: 'movie',
  async search(q) {
    const j = await fetchJson('https://sololatino.net/api/search/suggest?q=' + encodeURIComponent(q));
    if (!Array.isArray(j)) return [];
    return j.slice(0, 40).map((x) => {
      const url = x.url || '';
      const m = /sololatino\.net\/(pelicula|serie|toon)\/([^/?#]+)/.exec(url);
      if (!m) return null;
      const type = m[1] === 'serie' || m[1] === 'toon' ? 'series' : 'movie';
      const slug = m[2];
      const id = sanitizeId(slug, 'sl');
      return { id, ref: 'sl:' + m[1] + ':' + slug, title: cleanText(x.title) || slugToTitle(slug), kind: type, poster: x.poster || null, year: x.year ? String(x.year) : null };
    }).filter(Boolean);
  },
  async home() {
    const r = await fetchText('https://sololatino.net/');
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<div class="card">[\s\S]{0,200}?<a href="https:\/\/sololatino\.net\/(pelicula|serie|toon)\/([^"\/?#]+)"[\s\S]{0,600}?<img[^>]+src="([^"]+)"[^>]+alt="([^"]+)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const cat = m[1], slug = m[2];
      const type = cat === 'pelicula' ? 'movie' : 'series';
      const id = sanitizeId(slug, 'sl');
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, ref: 'sl:' + cat + ':' + slug, title: cleanText(m[4]) || slugToTitle(slug), kind: type, poster: m[3] || null });
    }
    return items;
  },
  async episodes(path) {
    const [cat, slug] = path.split(':');
    if (!slug || cat === 'pelicula') return { episodes: [] };
    const r = await fetchText('https://sololatino.net/serie/' + slug + '/');
    if (!r.ok) return { episodes: [] };
    const list = [];
    const epRe = /href="https:\/\/sololatino\.net\/serie\/[^"]+\/temporada-(\d+)\/episodio-(\d+)"/g;
    let m;
    const seen = new Set();
    while ((m = epRe.exec(r.text)) !== null) {
      const key = m[1] + '-' + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ season: +m[1], number: +m[2], title: 'T' + m[1] + 'E' + m[2], ref: 'sl:' + slug + ':' + m[1] + ':' + m[2] });
    }
    return { episodes: list };
  },
  async resolve(path) {
    const parts = path.split(':');
    const url = parts.length >= 3
      ? 'https://sololatino.net/serie/' + parts[0] + '/temporada-' + parts[1] + '/episodio-' + parts[2]
      : 'https://sololatino.net/' + parts[0] + '/' + (parts[1] || parts[0]);
    const r = await fetchText(url);
    if (!r.ok) return null;
    const opts = [];
    const tokRe = /data-player-token="([^"]+)"[^>]*>\s*([^<]*)</g;
    let tm;
    while ((tm = tokRe.exec(r.text)) !== null) {
      opts.push({ token: tm[1], label: cleanText(tm[2]) || 'Servidor ' + (opts.length + 1) });
    }
    if (opts.length === 0) return null;
    if (!globalThis._slCsrfTs || (Date.now() - globalThis._slCsrfTs) > 1800000) {
      await fetchText('https://sololatino.net/sanctum/csrf-cookie', { Referer: url });
      globalThis._slCsrfTs = Date.now();
    }
    let xsrf = kino.cookies.get('https://sololatino.net/', 'XSRF-TOKEN');
    try { xsrf = xsrf ? decodeURIComponent(xsrf) : ''; } catch { xsrf = xsrf || ''; }

    async function resolveOpt(o) {
      const res = await postJson('https://sololatino.net/api/player-url', { t: o.token }, { Referer: url, Origin: 'https://sololatino.net', 'X-XSRF-TOKEN': xsrf || '' });
      if (!res) return null;
      let j;
      try { j = JSON.parse(getText(res)); } catch { return null; }
      const embedUrl = j && j.url;
      if (!embedUrl || !String(embedUrl).startsWith('http')) return null;
      // Use resolveEmbedUrl: tries m3u8/mp4 extraction, follows inner iframes, handles vimeos/voe etc.
      const st = await resolveEmbedUrl(embedUrl, url);
      if (st && st.url) return { label: o.label, ...st };
      return null;
    }

    const streams = await collectStreams(opts.map((o) => resolveOpt(o)));
    if (streams.length === 0) return null;
    return {
      url: streams[0].url,
      ...(streams.length > 1 ? { alternatives: streams.slice(1, 6).map((s) => ({ label: s.label, url: s.url })) } : {})
    };
  }
});

/* --- PELISGRATISHDS --- */
registerSource({
  id: 'pgh',
  label: 'PelisGratisHDs',
  kind: 'movie',
  async search(q) {
    const r = await fetchText('https://pelisgratishds.com/buscar/?q=' + encodeURIComponent(q));
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<a class="directory-card-link" href="(https:\/\/pelisgratishds\.com\/(pelicula|series)\/([^"\/]+)\/)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const type = m[2] === 'series' ? 'series' : 'movie';
      const slug = m[3];
      const id = sanitizeId(slug, 'pgh');
      if (seen.has(id)) continue;
      seen.add(id);
      const block = r.text.slice(m.index, m.index + 900);
      const titleM = /alt="([^"]+)"/.exec(block);
      const imgM = /src="(https:\/\/cdn[^"]+)"/.exec(block);
      items.push({ id, ref: 'pgh:' + type + ':' + slug, title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: type, poster: imgM ? imgM[1] : null });
    }
    return items;
  },
  async home() {
    const r = await fetchText('https://pelisgratishds.com/');
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<article class="pg-card">\s*<a href="https:\/\/pelisgratishds\.com\/(pelicula|series)\/([^"\/]+)\/">[\s\S]{0,400}?<img[^>]+src="([^"]+)"[^>]+alt="([^"]+)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const type = m[1] === 'series' ? 'series' : 'movie';
      const slug = m[2];
      const id = sanitizeId(slug, 'pgh');
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, ref: 'pgh:' + type + ':' + slug, title: cleanText(m[4]) || slugToTitle(slug), kind: type, poster: m[3] || null });
    }
    return items;
  },
  async episodes(path) {
    const [type, slug] = path.split(':');
    if (type === 'movie') return { episodes: [] };
    const r = await fetchText('https://pelisgratishds.com/series/' + slug + '/');
    if (!r.ok) return { episodes: [] };
    const ajaxM = /series-ajax\.php\?[^"']+/.exec(r.text);
    if (!ajaxM) return { episodes: [] };
    const j = await fetchJson('https://pelisgratishds.com/' + ajaxM[0]);
    if (!j || !Array.isArray(j)) return { episodes: [] };
    const list = [];
    for (const e of j) {
      list.push({ season: +(e.season || e.temporada || 1), number: +(e.episode || e.numero || e.number || 1), title: e.title || e.name || null, ref: 'pgh:' + slug + ':' + (e.season || e.temporada || 1) + ':' + (e.episode || e.numero || e.number || 1) });
    }
    return { episodes: list };
  },
  async resolve(path) {
    const parts = path.split(':');
    const type = parts[0], slug = parts[1];
    const cat = type === 'series' ? 'series' : 'pelicula';
    const detailUrl = 'https://pelisgratishds.com/' + cat + '/' + slug + '/';
    const r = await fetchText(detailUrl);
    if (!r.ok) return null;
    const embedM = /embed\.php\?id=(\d+)/.exec(r.text);
    if (!embedM) return null;
    // pelisgratishds.com/embed.php just iframes embed.pelisgratishd.lat with the same id.
    // Origin must NOT be sent: the frame answers 403 with it.
    const frameUrl = 'https://embed.pelisgratishd.lat/embed.php?id=' + embedM[1];
    const e = await fetchText(frameUrl, { Referer: 'https://pelisgratishds.com/' });
    if (!e.ok) return null;
    // each server option is go_to_player('<base64 of rot13(url)>', true)
    const opts = [];
    const goRe = /go_to_player\('([^']+)',\s*(?:true|false)\);?"?[^>]*>\s*(?:<img[^>]*>)?\s*<span>([^<]*)<\/span>/g;
    let gm;
    while ((gm = goRe.exec(e.text)) !== null) {
      const real = decodePgh(gm[1]);
      if (real) opts.push({ label: cleanText(gm[2]) || 'Servidor', url: real });
    }
    if (opts.length === 0) {
      const anyRe = /go_to_player\('([^']+)'/g;
      let am;
      while ((am = anyRe.exec(e.text)) !== null) {
        const real = decodePgh(am[1]);
        if (real) opts.push({ label: 'Servidor ' + (opts.length + 1), url: real });
      }
    }
    if (opts.length === 0) {
      const directM = /handleDirectLinkPlay\('([^']+)'\)/.exec(e.text);
      if (directM) opts.push({ label: 'Directo', url: directM[1] });
    }
    if (opts.length === 0) return null;

    // Parallelize all server fetches
    async function resolveOpt(o) {
      const st = await resolveEmbedUrl(o.url, frameUrl);
      if (st && st.url) return { label: o.label, ...st };
      return null;
    }

    const resolved = await collectStreams(opts.map((o) => resolveOpt(o)));

    if (resolved.length > 0) {
      const primary = resolved[0];
      return {
        url: primary.url,
        ...(primary.headers ? { headers: primary.headers } : {}),
        ...(resolved.length > 1 ? { alternatives: resolved.slice(1, 7).map((s) => ({ label: s.label, url: s.url, ...(s.headers ? { headers: s.headers } : {}) })) } : {})
      };
    }
    return null;
  }

});

/* --- CUEVANASERIE --- */
registerSource({
  id: 'cv',
  label: 'CuevanaSerie',
  kind: 'movie',
  async search(q) {
    const r = await fetchText('https://cuevanaserie.pro/search/' + encodeURIComponent(q));
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<div class="movie-item"><a href="(\/(?:peliculas|tv)\/([^"\/]+)\/)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const path = m[1];
      const slug = m[2];
      const type = path.startsWith('/tv/') ? 'series' : 'movie';
      const id = sanitizeId(slug, 'cv');
      if (seen.has(id)) continue;
      seen.add(id);
      const block = r.text.slice(m.index, m.index + 900);
      const titleM = /alt="([^"]+)"/.exec(block);
      const imgM = /src=(https?:\/\/[^ ]+)/.exec(block);
      const yearM = /<span class="year[^>]*>(\d{4})<\/span>/.exec(block);
      items.push({ id, ref: 'cv:' + path, title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: type, poster: imgM ? imgM[1] : null, year: yearM ? yearM[1] : null });
    }
    return items;
  },
  async home() {
    const r = await fetchText('https://cuevanaserie.pro/');
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<div class="movie-item">\s*<a href="(\/(?:peliculas|tv)\/[^"]+\/)">/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const path = m[1];
      const slug = path.split('/').filter(Boolean).pop();
      const type = path.startsWith('/tv/') ? 'series' : 'movie';
      const id = sanitizeId(slug, 'cv');
      if (seen.has(id)) continue;
      seen.add(id);
      const block = r.text.slice(m.index, m.index + 900);
      const titleM = /alt="([^"]+)"/.exec(block);
      const imgM = /src=(https?:\/\/[^ ]+)/.exec(block);
      items.push({ id, ref: 'cv:' + path, title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: type, poster: imgM ? imgM[1] : null });
    }
    return items;
  },
  async episodes(path) {
    // path = "/tv/<id>/<slug>/"
    const r = await fetchText('https://cuevanaserie.pro' + path);
    if (!r.ok) return { episodes: [] };
    const list = [];
    const epRe = /href="(\/tv\/[^"]+\/episodio[^"]*)"[^>]*>[^<]*<[^>]*>([^<]+)</g;
    let m;
    const seen = new Set();
    while ((m = epRe.exec(r.text)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      list.push({ number: list.length + 1, season: 1, title: cleanText(m[2]) || ('Episodio ' + (list.length + 1)), ref: 'cv:' + m[1] });
    }
    if (list.length === 0) {
      const altRe = /href="(\/tv\/[^"]+\/(\d+)x(\d+)[^"]*)"/g;
      while ((m = altRe.exec(r.text)) !== null) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        list.push({ season: +m[2], number: +m[3], title: 'T' + m[2] + 'E' + m[3], ref: 'cv:' + m[1] });
      }
    }
    return { episodes: list };
  },
  async resolve(path) {
    // path = "/peliculas/<slug>/" or "/tv/<id>/<slug>/". The detail page's player loads from
    // "<path>ver.html", which carries a videojs src({ src: ... }) or an iframe.
    const base = path.startsWith('/') ? 'https://cuevana-3.page' + path : 'https://cuevana-3.page/peliculas/' + path + '/';
    const ver = base.replace(/\/?$/, '/').replace(/\/$/, '') + '/ver.html';
    const r = await fetchText(ver, { Referer: base });
    if (r.ok) {
      const srcM = /player\.src\(\{\s*src:\s*['"]([^'"]+)['"]/i.exec(r.text) || /src:\s*['"](https?:\/\/[^'"]+)['"]/i.exec(r.text);
      if (srcM && /\.m3u8($|\?)/i.test(srcM[1])) return { url: srcM[1] };
      if (srcM && /\.mp4($|\?)/i.test(srcM[1])) {
        // cuevana serves direct mp4s — including 2.5MB fake-intro bait. Probe
        // with size gate; on failure keep scanning the page for other players.
        if (await probeStream(srcM[1], { Referer: base })) return { url: srcM[1], probe: true };
      }
      const m3u = r.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      if (m3u) return { url: m3u[1] };
      const iframeM = /<iframe[^>]+src="([^"]+)"/i.exec(r.text);
      if (iframeM) {
        const st = await resolveEmbedUrl(iframeM[1], ver);
        if (st && st.url) return st;
      }
    }
    const d = await fetchText(base);
    if (!d.ok) return null;
    const m3u2 = d.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    if (m3u2) return { url: m3u2[1] };
    const iframe2 = /<iframe[^>]+src="([^"]+)"/i.exec(d.text);
    if (iframe2) {
      const st = await resolveEmbedUrl(iframe2[1], base);
      if (st && st.url) return st;
    }
    const playM = /data-url="([^"]+)"/.exec(d.text);
    if (playM) {
      const st = await resolveEmbedUrl(playM[1], base);
      if (st && st.url) return st;
    }
    return null;
  }
});

/* --- PLUTO.TV (JSON API, free live/VOD) --- */
let _plutoToken = null;
let _plutoTokenTs = 0;
async function getPlutoToken() {
  const now = Date.now();
  if (_plutoToken && (now - _plutoTokenTs) < 3600000) return _plutoToken;
  const j = await fetchJson('https://boot.pluto.tv/v4/start?appName=web&appVersion=unknown&deviceVersion=126.0.0.0&deviceModel=web&deviceMake=Chrome&deviceType=web&clientID=web&clientModelNumber=1.0');
  const tok = j && (j.sessionToken || (j.session && j.session.sessionToken));
  if (tok) { _plutoToken = tok; _plutoTokenTs = now; }
  return _plutoToken || null;
}
registerSource({
  id: 'pluto',
  label: 'Pluto TV',
  kind: 'movie',
  async search(q) {
    // Fixed: param is q= not query=
    const j = await fetchJson('https://service-media-search.clusters.pluto.tv/v1/search?q=' + encodeURIComponent(q) + '&limit=30');
    if (!j || !Array.isArray(j.hits)) return [];
    return j.hits.slice(0, 30).map((h, i) => {
      const id = sanitizeId(h.id || h.slug || String(i), 'pluto');
      return { id, ref: 'pluto:' + (h.id || h.slug || ''), title: cleanText(h.title) || slugToTitle(h.slug || ''), kind: 'movie', poster: h.poster || null, overview: h.description || null };
    }).filter((x) => x.ref && x.ref.split(':')[1]);
  },
  async resolve(path) {
    const token = await getPlutoToken();
    const authHdr = token ? { 'Authorization': 'Bearer ' + token } : {};
    const j = await fetchJson('https://service-vod.clusters.pluto.tv/v2/item/' + path + '/playbackInfo?deviceMake=Chrome&deviceType=web&deviceVersion=126.0.0.0&appName=web&appVersion=unknown', authHdr);
    if (j && j.data) {
      const m3u = String(j.data).match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      if (m3u) return { url: m3u[1] };
    }
    if (j && j.streamingUrl) return { url: j.streamingUrl };
    const s = await fetchJson('https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv/v2/stitch/hls/channel/' + path + '.m3u8?deviceId=1234567890123456&deviceMake=Chrome&deviceType=web&deviceVersion=126.0.0.0&appName=web&appVersion=unknown&clientID=1234567890123456&clientModelNumber=1.0.0&sessionID=1234567890123456&serverSideAds=false', authHdr);
    if (s) {
      const m = JSON.stringify(s).match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      if (m) return { url: m[1] };
    }
    return null;
  }
});

/* --- ENTREPELICULASYSERIES --- */
registerSource({
  id: 'ent',
  label: 'EntrePeliculas',
  kind: 'movie',
  async search(q) {
    const r = await fetchText('https://entrepeliculasyseries.nz/search/?s=' + encodeURIComponent(q));
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<article class="post[^"]*">\s*<a href="(\/(?:pelicula|serie)\/([^"\/]+))">\s*<figure[^>]*>\s*<img src="([^"]+)"[^>]*alt="([^"]*)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const path = m[1];
      const slug = m[2];
      const type = path.startsWith('/serie/') ? 'series' : 'movie';
      const id = sanitizeId(slug, 'ent');
      if (seen.has(id)) continue;
      seen.add(id);
      const poster = extractPoster(m[0], 'https://entrepeliculasyseries.nz') || m[3];
      items.push({ id, ref: 'ent:' + path, title: tmdbQueryTitle(cleanText(m[4])) || slugToTitle(slug), kind: type, poster: poster || null });
    }
    return items;
  },
  async home() {
    const r = await fetchText('https://entrepeliculasyseries.nz/');
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<article class="post[^"]*">\s*<a href="(\/(?:pelicula|serie)\/([^"\/]+))">\s*<figure[^>]*>\s*<img src="([^"]+)"[^>]*alt="([^"]*)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const path = m[1];
      const slug = m[2];
      const type = path.startsWith('/serie/') ? 'series' : 'movie';
      const id = sanitizeId(slug, 'ent');
      if (seen.has(id)) continue;
      seen.add(id);
      const poster = extractPoster(m[0], 'https://entrepeliculasyseries.nz') || m[3];
      items.push({ id, ref: 'ent:' + path, title: tmdbQueryTitle(cleanText(m[4])) || slugToTitle(slug), kind: type, poster: poster || null, badges: ['LATINO'] });
    }
    return items;
  },
  async episodes(path) {
    if (!path.startsWith('/serie/')) return { episodes: [] };
    const r = await fetchText('https://entrepeliculasyseries.nz' + path);
    if (!r.ok) return { episodes: [] };
    const list = [];
    const epRe = /href="(\/serie\/[^"]+\/temporada[/-]\d+[/-]capitulo[/-]\d+)"[^>]*>/gi;
    let m;
    const seen = new Set();
    while ((m = epRe.exec(r.text)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const sM = /temporada[/-](\d+)/i.exec(m[1]);
      const eM = /capitulo[/-](\d+)/i.exec(m[1]);
      list.push({ season: sM ? +sM[1] : 1, number: eM ? +eM[1] : list.length + 1, title: 'T' + (sM ? sM[1] : '1') + 'E' + (eM ? eM[1] : list.length + 1), ref: 'ent:' + m[1] });
    }
    return { episodes: list };
  },
  async resolve(path) {
    const url = 'https://entrepeliculasyseries.nz' + path;
    const r = await fetchText(url);
    if (!r.ok) return null;
    const iframes = [...r.text.matchAll(/<iframe[^>]+src="([^"]+)"/gi)]
      .map((x) => (x[1].startsWith('//') ? 'https:' + x[1] : x[1]))
      .filter((ifr) => ifr.startsWith('http') && !ifr.includes('youtube.com'));
    if (iframes.length > 0) {
      const resolved = await Promise.all(iframes.slice(0, 4).map((ifr) => resolveEmbedUrl(ifr, url)));
      const valid = resolved.find((st) => st && st.url);
      if (valid) return valid;
    }
    const vidM = /\/vidurl\/([^"\/]+)/.exec(r.text);
    if (vidM) {
      const v = await fetchText('https://entrepeliculasyseries.nz/vidurl/' + vidM[1] + '/');
      if (v.ok) {
        const m3u = v.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
        if (m3u) return { url: m3u[1] };
        const iframes2 = [...v.text.matchAll(/<iframe[^>]+src="([^"]+)"/gi)]
          .map((x) => (x[1].startsWith('//') ? 'https:' + x[1] : x[1]))
          .filter((ifr) => ifr.startsWith('http') && !ifr.includes('youtube.com'));
        if (iframes2.length > 0) {
          const resolved2 = await Promise.all(iframes2.slice(0, 4).map((ifr) => resolveEmbedUrl(ifr, url)));
          const valid2 = resolved2.find((st) => st && st.url);
          if (valid2) return valid2;
        }
      }
    }
    const m3u = r.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    return m3u ? { url: m3u[1] } : null;
  }
});

/* --- ANIMEAV1 --- */
registerSource({
  id: 'av1',
  label: 'AnimeAV1',
  kind: 'anime',
  async search(q) {
    const r = await fetchText('https://animeav1.com/catalogo?search=' + encodeURIComponent(q));
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /href="\/media\/([^"]+)"[\s\S]{0,400}?<h3[^>]*>([^<]+)<\/h3>/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const slug = m[1];
      const id = sanitizeId(slug, 'av1');
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, ref: 'av1:' + slug, title: cleanText(m[2]) || slugToTitle(slug), kind: 'series' });
    }
    if (items.length === 0) {
      const altRe = /href="\/media\/([^"]+)"/g;
      while ((m = altRe.exec(r.text)) !== null) {
        const slug = m[1];
        const id = sanitizeId(slug, 'av1');
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ id, ref: 'av1:' + slug, title: slugToTitle(slug), kind: 'series' });
      }
    }
    return items;
  },
  async home() {
    const r = await fetchText('https://animeav1.com/catalogo');
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<img[^>]+alt="Portada de ([^"]+)"[\s\S]{0,800}?href="\/media\/([^"]+)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const title = cleanText(m[1]);
      const slug = m[2];
      if (!slug) continue;
      const id = sanitizeId(slug, 'av1');
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, ref: 'av1:' + slug, title: title || slugToTitle(slug), kind: 'series' });
    }
    return items;
  },
  async episodes(path) {
    const r = await fetchText('https://animeav1.com/media/' + path + '/__data.json');
    if (!r.ok) return { episodes: [] };
    let data;
    try { data = JSON.parse(r.text); } catch { return { episodes: [] }; }
    const episodes = [];
    const seen = new Set();
    for (const node of (data.nodes || [])) {
      if (!Array.isArray(node?.data)) continue;
      for (const item of node.data) {
        if (item && typeof item === 'object' && typeof item.number === 'number') {
          const num = item.number;
          if (!seen.has(num)) {
            seen.add(num);
            episodes.push({ season: 1, number: num, title: 'Episodio ' + num, ref: 'av1:' + path + ':' + num });
          }
        }
      }
    }
    episodes.sort((a, b) => a.number - b.number);
    return { episodes };
  },
  async resolve(path) {
    const parts = path.split(':');
    const slug = parts[0];
    const ep = parts[1];
    const dataUrl = ep
      ? 'https://animeav1.com/media/' + slug + '/' + ep + '/__data.json'
      : 'https://animeav1.com/media/' + slug + '/__data.json';
    const r = await fetchText(dataUrl);
    if (r.ok) {
      const zillaM = /https?:\/\/player\.zilla-networks\.com\/play\/([A-Za-z0-9_-]+)/.exec(r.text);
      if (zillaM) return { url: 'https://player.zilla-networks.com/m3u8/' + zillaM[1], headers: { 'Referer': 'https://animeav1.com/' } };
      const m3u = r.text.match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) return { url: m3u[1], headers: { 'Referer': 'https://animeav1.com/' } };
      const mp4 = r.text.match(/(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/i);
      if (mp4) return { url: mp4[1] };
    }
    const pageUrl = ep
      ? 'https://animeav1.com/media/' + slug + '/' + ep
      : 'https://animeav1.com/media/' + slug;
    const hr = await fetchText(pageUrl);
    if (hr.ok) {
      const zillaM = /https?:\/\/player\.zilla-networks\.com\/(?:play|m3u8)\/([A-Za-z0-9_-]+)/.exec(hr.text);
      if (zillaM) return { url: 'https://player.zilla-networks.com/m3u8/' + zillaM[1], headers: { 'Referer': 'https://animeav1.com/' } };
      const m3u = hr.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      if (m3u) return { url: m3u[1], headers: { 'Referer': 'https://animeav1.com/' } };
    }
    return null;
  }
});

/* --- ANIMEFLV --- */
registerSource({
  id: 'afv',
  label: 'AnimeFLV',
  kind: 'anime',
  async search(q) {
    const r = await fetchText('https://animeflv.or.at/?s=' + encodeURIComponent(q));
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<a href="(https:\/\/animeflv\.or\.at\/anime\/([^"\/]+)\/)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const slug = m[2];
      const id = sanitizeId(slug, 'afv');
      if (seen.has(id)) continue;
      seen.add(id);
      const block = r.text.slice(Math.max(0, m.index - 400), m.index + 400);
      const titleM = /alt="([^"]+)"/.exec(block);
      const imgM = /src="([^"]+)"/.exec(block);
      items.push({ id, ref: 'afv:' + slug, title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: 'series', poster: imgM ? imgM[1] : null });
    }
    return items;
  },
  async home() {
    const r = await fetchText('https://animeflv.or.at/');
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<a[^>]+title="([^"]+)"[^>]+href="https:\/\/animeflv\.or\.at\/anime\/([^"\/]+)\/"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const slug = m[2];
      const id = sanitizeId(slug, 'afv');
      if (seen.has(id)) continue;
      seen.add(id);
      const block = r.text.slice(m.index, m.index + 400);
      const imgM = /src="([^"]+)"/.exec(block);
      items.push({ id, ref: 'afv:' + slug, title: cleanText(m[1]) || slugToTitle(slug), kind: 'series', poster: imgM ? imgM[1] : null });
    }
    if (items.length === 0) {
      const postRe = /<a[^>]+class="thumbnail-link"[^>]+href="https:\/\/animeflv\.or\.at\/\d{4}\/\d{2}\/\d{2}\/([a-z0-9-]+)-episodio-(\d+)\//g;
      while ((m = postRe.exec(r.text)) !== null) {
        const slug = m[1], n = +m[2];
        const id = sanitizeId(slug, 'afv');
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ id, ref: 'afv:' + slug + ':' + n, title: slugToTitle(slug) + ' · Ep ' + n, kind: 'series' });
      }
    }
    return items;
  },
  async episodes(path) {
    const r = await fetchText('https://animeflv.or.at/anime/' + path + '/');
    if (!r.ok) return { episodes: [] };
    const list = [];
    const epRe = /href="(https:\/\/animeflv\.or\.at\/[^"]*episodio-(\d+)[^"]*)"/g;
    let m;
    const seen = new Set();
    while ((m = epRe.exec(r.text)) !== null) {
      const n = +m[2];
      if (seen.has(n)) continue;
      seen.add(n);
      list.push({ season: 1, number: n, title: 'Episodio ' + n, ref: 'afv:' + path + ':' + n + ':' + m[1] });
    }
    if (list.length === 0) {
      const dataM = /<script type="application\/json" class="animeflv-episodes-data">(\[[\s\S]*?\])<\/script>/.exec(r.text);
      if (dataM) {
        try {
          const arr = JSON.parse(dataM[1]);
          for (const e of arr) list.push({ season: 1, number: e.number || 1, title: 'Episodio ' + (e.number || 1), ref: 'afv:' + path + ':' + (e.number || 1) + ':' + (e.permalink || '') });
        } catch {}
      }
    }
    return { episodes: list };
  },
  async resolve(path) {
    // ref is <slug>:<n>:<url> and the url itself holds ':', so rejoin from index 2
    const cut = path.indexOf(':');
    const slug = cut === -1 ? path : path.slice(0, cut);
    const rest = cut === -1 ? '' : path.slice(cut + 1);
    const cut2 = rest.indexOf(':');
    const epUrl = cut2 === -1 ? '' : rest.slice(cut2 + 1);
    const url = epUrl.startsWith('http') ? epUrl : 'https://animeflv.or.at/anime/' + slug + '/episode-' + rest.slice(0, cut2 === -1 ? rest.length : cut2) + '/';
    const r = await fetchText(url);
    if (!r.ok) return null;
    // servers arrive base64-encoded in data-src / data-default-src
    const servers = [];
    const srcRe = /data-(?:default-)?src="([A-Za-z0-9+/=]{16,})"/g;
    let sm;
    while ((sm = srcRe.exec(r.text)) !== null) {
      let u = '';
      try { u = atob(sm[1]).trim(); } catch { continue; }
      if (!u.startsWith('http') || servers.some((x) => x.url === u)) continue;
      servers.push({ url: u, label: u.includes('zilla') ? 'Zilla' : u.includes('voe') ? 'VOE' : u.includes('mp4upload') ? 'Mp4Upload' : 'Servidor' });
    }
    if (servers.length === 0) return null;
    // Filter to known-safe hosts only to stay within request budget
    const ALLOWED_HOSTS = ['zilla-networks.com', 'mp4upload.com', 'voe.sx', 'filemoon.sx', 'goodstream.one', 'streamtape.com'];
    const validServers = servers.filter((s) => ALLOWED_HOSTS.some((h) => s.url.includes(h)) || /\.m3u8(\?|$)/i.test(s.url));
    const toResolve = (validServers.length > 0 ? validServers : servers).slice(0, 6);

    async function resolveAfvServer(s) {
      const st = await resolveEmbedUrl(s.url, url);
      if (st && st.url) return { label: s.label, ...st };
      return null;
    }

    const streams = await collectStreams(toResolve.map((s) => resolveAfvServer(s)));
    if (streams.length === 0) return null;
    return { url: streams[0].url, alternatives: streams.slice(1, 8).map((s) => ({ label: s.label, url: s.url })) };
  }
});

/* --- NET79 --- */
registerSource({
  id: 'n79',
  label: 'Net79',
  kind: 'movie',
  async search(q) {
    const j = await fetchJson('https://net79.cc/api/catalog/search?q=' + encodeURIComponent(q));
    if (!j || !Array.isArray(j.items)) return [];
    return j.items.filter((x) => +x.tmdbId > 0).slice(0, 40).map((x) => {
      const type = x.type === 'tv' ? 'series' : 'movie';
      const id = sanitizeId(String(x.tmdbId), 'n79');
      return { id, ref: 'n79:' + type + ':' + x.tmdbId, title: cleanText(x.title) || slugToTitle(String(x.tmdbId)), kind: type, poster: x.poster || null, year: x.year ? String(x.year) : null, overview: cleanText(x.overview || ''), rating: x.rating ? Math.round(x.rating * 10) / 10 : null, ids: { tmdb: +x.tmdbId } };
    }).filter((x) => x.ref);
  },
  async home() {
    const j = await fetchJson('https://net79.cc/api/catalog/search?q=a');
    if (!j || !Array.isArray(j.items)) return [];
    return j.items.filter((x) => +x.tmdbId > 0).slice(0, 30).map((x) => {
      const type = x.type === 'tv' ? 'series' : 'movie';
      const id = sanitizeId(String(x.tmdbId), 'n79');
      return { id, ref: 'n79:' + type + ':' + x.tmdbId, title: cleanText(x.title) || slugToTitle(String(x.tmdbId)), kind: type, poster: x.poster || null, year: x.year ? String(x.year) : null, badges: ['FULL HD'], ids: { tmdb: +x.tmdbId } };
    }).filter((x) => x.ref);
  },
  async episodes(path) {
    const [type, tmdbId] = path.split(':');
    if (type !== 'series') return { episodes: [] };
    // Primary: catalog detail endpoint
    const j = await fetchJson('https://net79.cc/api/catalog/detail?tmdbId=' + tmdbId + '&type=tv');
    if (j && j.seasons && j.seasons.length > 0) {
      const list = [];
      for (const s of j.seasons) {
        for (const e of (s.episodes || [])) list.push({ season: s.season || s.number || 1, number: e.episode || e.number || 1, title: e.title || null, ref: 'n79:serie:' + tmdbId + ':' + (s.season || 1) + ':' + (e.episode || 1) });
      }
      if (list.length > 0) return { episodes: list };
    }
    // Fallback: probe embed endpoint for seasons 1-3 episodes 1-26
    const list = [];
    for (let s = 1; s <= 3; s++) {
      let found = false;
      for (let e = 1; e <= 26; e++) {
        const ej = await fetchJson('https://net79.cc/api/embed-tmdb/' + tmdbId + '?type=tv&se=' + s + '&ep=' + e);
        if (!ej || (!ej.url && !ej.mp4 && !(Array.isArray(ej) && ej.length > 0) && !ej.sources)) break;
        list.push({ season: s, number: e, title: null, ref: 'n79:serie:' + tmdbId + ':' + s + ':' + e });
        found = true;
      }
      if (!found) break;
    }
    return { episodes: list.length > 0 ? list : [{ season: 1, number: 1, title: 'Episodio 1', ref: 'n79:serie:' + tmdbId + ':1:1' }] };
  },
  async resolve(path) {
    const parts = path.split(':');
    const type = parts[0], tmdbId = parts[1];
    const season = parts[2] || '1', episode = parts[3] || '1';
    // Fixed: path-based endpoint /api/embed-tmdb/<id>?type=...
    const embedUrl = type === 'series'
      ? 'https://net79.cc/api/embed-tmdb/' + tmdbId + '?type=tv&se=' + season + '&ep=' + episode
      : 'https://net79.cc/api/embed-tmdb/' + tmdbId + '?type=movie';
    const j = await fetchJson(embedUrl);
    if (!j) return null;
    // Gather candidates from every response shape, then health-check each one
    // like the player will (GET, no jar): the CDN behind these links rate-limits
    // with 429 and would otherwise poison the whole resolve with a dead URL.
    const rq = (x) => parseInt(String(x.resolution || x.quality || '0')) || 0;
    const cands = [];
    if (Array.isArray(j)) {
      cands.push(...j.filter((x) => x && x.url).sort((a, b) => rq(b) - rq(a)));
    } else {
      if (j.url) cands.push({ url: j.url });
      if (j.mp4) {
        const streams = (Array.isArray(j.streams) ? j.streams : []).filter((s) => s && s.url && s.url !== j.mp4);
        cands.push(...[{ url: j.mp4, resolution: j.resolution }].concat(streams).sort((a, b) => rq(b) - rq(a)));
      }
      if (j.sources) cands.push(...j.sources.filter((s) => s && s.url));
    }
    if (cands.length === 0) return null;
    const headers = { Referer: 'https://net79.cc/' };
    const ok = [];
    const seen = new Set();
    for (const c of cands.slice(0, 6)) {
      if (!c.url || seen.has(c.url)) continue;
      seen.add(c.url);
      if (await probeStream(c.url, headers)) ok.push(c);
    }
    if (ok.length === 0) {
      log(`[n79] ningún stream superó el sondeo para ${type}:${tmdbId}`);
      return null;
    }
    return {
      url: ok[0].url,
      headers,
      ...(rq(ok[0]) ? { label: rq(ok[0]) + 'p' } : {}),
      ...(ok.length > 1 ? { alternatives: ok.slice(1, 6).map((s) => ({ label: rq(s) ? rq(s) + 'p' : '', url: s.url, headers })) } : {})
    };
  }
});

/* --- ONLYFLIX --- */
registerSource({
  id: 'ofx',
  label: 'OnlyFlix',
  kind: 'movie',
  async search(q) {
    const j = await fetchJson('https://onlyflix.to/wp-json/wp/v2/search?search=' + encodeURIComponent(q) + '&per_page=30');
    if (!Array.isArray(j)) return [];
    return j.slice(0, 30).map((x) => {
      const type = String(x.subtype || x.type || '').toLowerCase().includes('serie') || String(x.subtype || '').toLowerCase() === 'tv' ? 'series' : 'movie';
      const id = sanitizeId(String(x.id), 'ofx');
      return { id, ref: 'ofx:' + type + ':' + x.id, title: cleanText(x.title) || slugToTitle(String(x.id)), kind: type };
    }).filter((x) => x.ref);
  },
  async resolve(path) {
    const [type, id] = path.split(':');
    const pageUrl = 'https://onlyflix.to/' + (type === 'series' ? 'tv' : 'movie') + '/' + id + '/';
    // Try REST meta first (fast path)
    const j = await fetchJson('https://onlyflix.to/wp-json/wp/v2/' + (type === 'series' ? 'tv' : 'movies') + '/' + id);
    if (j && j.meta && j.meta.embed) {
      const st = await resolveEmbedUrl(j.meta.embed, pageUrl);
      if (st && st.url) return st;
    }
    const r = await fetchText(pageUrl);
    if (!r.ok) return null;
    // Extract nonce + post_id for AJAX player list
    const nonceM = /"nonce"\s*:\s*"([^"]+)"/.exec(r.text) || /nonce['"]\s*[:=]\s*['"]([^'"]+)['"]/.exec(r.text);
    const postIdM = /"post_id"\s*:\s*(\d+)/.exec(r.text) || /data-post(?:-id)?=["'](\d+)["']/.exec(r.text);
    if (nonceM && postIdM) {
      const body = 'action=mcp_get_available_players&nonce=' + encodeURIComponent(nonceM[1]) + '&post_id=' + postIdM[1] + '&type=' + (type === 'series' ? 'tv' : 'movie');
      const res = await postForm('https://onlyflix.to/wp-admin/admin-ajax.php', body, { Referer: pageUrl });
      if (res) {
        const txt = getText(res);
        try {
          const pj = JSON.parse(txt);
          const players = pj && pj.data ? (Array.isArray(pj.data) ? pj.data : Object.values(pj.data)) : [];
          const urls = players.map((p) => p.url || p.link || p).filter((u) => typeof u === 'string' && u.startsWith('http'));
          if (urls.length > 0) {
            const resolved = await Promise.all(urls.slice(0, 4).map((u) => resolveEmbedUrl(u, pageUrl)));
            const valid = resolved.filter((st) => st && st.url);
            if (valid.length > 0) {
              return {
                url: valid[0].url,
                ...(valid[0].headers ? { headers: valid[0].headers } : {}),
                ...(valid.length > 1 ? { alternatives: valid.slice(1, 6).map((s, i) => ({ label: 'Servidor ' + (i + 2), url: s.url, ...(s.headers ? { headers: s.headers } : {}) })) } : {})
              };
            }
          }
        } catch {}
      }
    }
    // Fallback: first non-youtube iframe
    const iframes = [...r.text.matchAll(/<iframe[^>]+src="([^"]+)"/gi)].map((m) => m[1]).filter((u) => !u.includes('youtube'));
    for (const ifr of iframes.slice(0, 3)) {
      const st = await resolveEmbedUrl(ifr.startsWith('//') ? 'https:' + ifr : ifr, pageUrl);
      if (st && st.url) return st;
    }
    const m3u = r.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    return m3u ? { url: m3u[1] } : null;
  }
});

/* --- PELISPLUSD --- */
registerSource({
  id: 'ppd',
  label: 'PelisPlusHD',
  kind: 'movie',
  async search(q) {
    const r = await fetchText('https://pelisplushd.la/search?s=' + encodeURIComponent(q));
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /href="(?:https:\/\/pelisplushd\.la)?(\/(?:pelicula|serie|pelicula-animada|serie-animada)\/[^"\/]+(?:\/)?)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      let path = m[1];
      if (!path.endsWith('/')) path += '/';
      const slug = path.split('/').filter(Boolean).pop();
      if (!isValidSlug(slug)) continue;
      const type = path.includes('/serie') ? 'series' : 'movie';
      const id = sanitizeId(slug, 'ppd');
      if (seen.has(id)) continue;
      seen.add(id);
      const block = r.text.slice(Math.max(0, m.index - 200), m.index + 600);
      const titleM = /alt="([^"]+)"/.exec(block) || /data-title="([^"]+)"/.exec(block);
      const poster = extractPoster(block, 'https://pelisplushd.la');
      items.push({ id, ref: 'ppd:' + path, title: tmdbQueryTitle(cleanText(titleM ? titleM[1] : '')) || slugToTitle(slug), kind: type, poster });
    }
    return items;
  },
  async home() {
    const r = await fetchText('https://pelisplushd.la/');
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /href="(?:https:\/\/pelisplushd\.la)?(\/(?:pelicula|serie|pelicula-animada|serie-animada)\/[^"\/]+(?:\/)?)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      let path = m[1];
      if (!path.endsWith('/')) path += '/';
      const slug = path.split('/').filter(Boolean).pop();
      if (!isValidSlug(slug)) continue;
      const type = path.includes('/serie') ? 'series' : 'movie';
      const id = sanitizeId(slug, 'ppd');
      if (seen.has(id)) continue;
      seen.add(id);
      const block = r.text.slice(Math.max(0, m.index - 200), m.index + 600);
      const titleM = /alt="([^"]+)"/.exec(block) || /data-title="([^"]+)"/.exec(block);
      const poster = extractPoster(block, 'https://pelisplushd.la');
      items.push({ id, ref: 'ppd:' + path, title: tmdbQueryTitle(cleanText(titleM ? titleM[1] : '')) || slugToTitle(slug), kind: type, poster, badges: ['HD'] });
    }
    return items;
  },
  async resolve(path) {
    const url = 'https://pelisplushd.la' + path;
    const r = await fetchText(url);
    if (!r.ok) return null;
    const dataUrls = [...r.text.matchAll(/data-url="([^"]+)"/g)].map((m) => m[1]);
    if (dataUrls.length > 0) {
      const resolved = await collectStreams(dataUrls.map((du) => resolveEmbedUrl(du, url)));
      if (resolved.length > 0) {
        const primary = resolved[0];
        return {
          url: primary.url,
          ...(primary.headers ? { headers: primary.headers } : {}),
          ...(resolved.length > 1 ? { alternatives: resolved.slice(1, 7).map((s, i) => ({ label: 'Servidor ' + (i + 2), url: s.url, ...(s.headers ? { headers: s.headers } : {}) })) } : {})
        };
      }
    }
    const m3u = r.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    if (m3u) return { url: m3u[1] };
    const iframeM = /<iframe[^>]+src="([^"]+)"/i.exec(r.text);
    if (iframeM) {
      const st = await resolveEmbedUrl(iframeM[1], url);
      if (st && st.url) return st;
    }
    return null;
  }
});

/* --- 1MOVIES --- */
registerSource({
  id: '1mv',
  label: '1Movies',
  kind: 'movie',
  async search(q) {
    const r = await fetchText('https://1movies.stream/search?keyword=' + encodeURIComponent(q));
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<a[^>]+href="(https:\/\/1movies\.stream\/watch-movie\/([^"\/]+)\/)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const slug = m[2].replace(/-watch-online$/, '');
      const id = sanitizeId(slug, '1mv');
      if (seen.has(id)) continue;
      seen.add(id);
      const block = r.text.slice(Math.max(0, m.index - 600), m.index + 600);
      const titleM = /alt="([^"]+)"/.exec(block);
      const poster = extractPoster(block, 'https://1movies.stream');
      items.push({ id, ref: '1mv:' + m[1], title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: 'movie', poster });
    }
    return items;
  },
  async home() {
    const r = await fetchText('https://1movies.stream/');
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    const re = /<a[^>]+href="(https:\/\/1movies\.stream\/watch-movie\/([^"\/]+)\/)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const slug = m[2].replace(/-watch-online$/, '');
      const id = sanitizeId(slug, '1mv');
      if (seen.has(id)) continue;
      seen.add(id);
      const block = r.text.slice(Math.max(0, m.index - 600), m.index + 600);
      const titleM = /alt="([^"]+)"/.exec(block);
      const poster = extractPoster(block, 'https://1movies.stream');
      items.push({ id, ref: '1mv:' + m[1], title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: 'movie', poster, badges: ['HD'] });
    }
    return items;
  },
  async resolve(path) {
    const url = path.startsWith('http') ? path : 'https://1movies.stream' + path;
    const r = await fetchText(url);
    if (!r.ok) return null;
    // Extract data-token from the watch block — no static iframe on this site
    const tokenM = /data-token="([^"]+)"/.exec(r.text) || /class="watch_block"[^>]*data-(?:id|token)="([^"]+)"/.exec(r.text);
    if (tokenM) {
      const token = tokenM[1];
      const res = await postForm('https://1movies.stream/ajax/ajax.php', 'players=' + encodeURIComponent(token), { Referer: url, 'X-Requested-With': 'XMLHttpRequest' });
      if (res) {
        const txt = getText(res);
        try {
          const servers = JSON.parse(txt);
          if (Array.isArray(servers) && servers.length > 0) {
            const valid = servers.filter((s) => s && (s.link || s.url));
            if (valid.length > 0) {
              const urls = valid.map((s) => s.link || s.url).filter((u) => typeof u === 'string' && u.startsWith('http'));
              const resolved = await Promise.all(urls.slice(0, 4).map((u) => resolveEmbedUrl(u, url)));
              const okStreams = resolved.filter((st) => st && st.url);
              if (okStreams.length > 0) {
                return {
                  url: okStreams[0].url,
                  ...(okStreams[0].headers ? { headers: okStreams[0].headers } : {}),
                  ...(okStreams.length > 1 ? { alternatives: okStreams.slice(1, 6).map((s, i) => ({ label: 'Servidor ' + (i + 2), url: s.url, ...(s.headers ? { headers: s.headers } : {}) })) } : {})
                };
              }
            }
          }
        } catch {}
        const m3u = txt.match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
        if (m3u) return { url: m3u[1] };
      }
    }
    // Fallback: static iframe or m3u8 in page
    const iframeM = /<iframe[^>]+src="([^"]+)"/i.exec(r.text);
    if (iframeM) {
      const st = await resolveEmbedUrl(iframeM[1], url);
      if (st && st.url) return st;
    }
    const m3u = r.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    return m3u ? { url: m3u[1] } : null;
  }
});

/* ---------- TMDB catalog ---------- */

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const TMDB_CACHE_MS = 6 * 60 * 60 * 1000;

const TMDB_MOVIE_SRCS = ['cc', 'pgh', 'cv', 'sl', 'hs', 'chp', 'chx', 'ent', 'n79', 'ppd', 'ofx', '1mv', 'vpo'];
const TMDB_SERIES_SRCS = ['sl', 'cv', 'pgh', 'cc', 'ent', 'n79', 'chp', 'chx', 'hs', 'jkanime', 'av1', 'afv'];

function tmdbKey() {
  try { const k = kino.config.get('tmdbKey'); return typeof k === 'string' ? k.trim() : ''; } catch { return ''; }
}

/** TMDB can answer when Kino has its own key (0.9.53+, kino.tmdb) or the person set one. */
function tmdbReady() {
  return typeof kino.tmdb === 'function' || !!tmdbKey();
}

function tmdbLang() {
  try { const l = kino.config.get('tmdbLang'); return typeof l === 'string' && l ? l : 'es-MX'; } catch { return 'es-MX'; }
}

function tmdbWantSourceRows() {
  try { const v = kino.config.get('sourceRows'); return v === undefined ? true : !!v; } catch { return true; }
}

function tmdbCached(cacheKey) {
  try {
    const raw = kino.storage.get(cacheKey);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o.t !== 'number' || Date.now() - o.t > TMDB_CACHE_MS) return null;
    return o.v;
  } catch { return null; }
}

function tmdbStore(cacheKey, v) {
  try { kino.storage.set(cacheKey, JSON.stringify({ t: Date.now(), v }), { ttlMs: TMDB_CACHE_MS }); } catch {}
}

async function tmdbFetch(path, params) {
  const cacheKey = 'tmdb:' + path + ':' + JSON.stringify(params || {});
  const hit = tmdbCached(cacheKey);
  if (hit) return hit;
  let res = null;
  // Kino 0.9.53+ puts the key itself (kino.tmdb): no setting needed from the person.
  if (typeof kino.tmdb === 'function') {
    const q = {};
    if (params) for (const k in params) {
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') q[k] = v;
    }
    if (q.language === undefined) q.language = tmdbLang();
    delete q.api_key; // nunca en params: Kino lo rechaza con invalid_request
    try { res = await kino.tmdb(path, q); }
    catch (e) {
      const code = e && e.code;
      if (code === 'rate_limited') return null; // ya agotamos la cuota: no repetir con la propia
      res = null; // sin llave de Kino u otra falla: cae al respaldo de la llave propia
    }
  }
  if (!res) {
    if (!tmdbKey()) return null;
    const qs = ['api_key=' + encodeURIComponent(tmdbKey()), 'language=' + encodeURIComponent(tmdbLang())];
    if (params) {
      for (const k in params) {
        const v = params[k];
        if (v === undefined || v === null || v === '') continue;
        qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
      }
    }
    const url = TMDB_API + path + '?' + qs.join('&');
    res = await fetchJson(url, { Accept: 'application/json' });
  }
  if (res) tmdbStore(cacheKey, res);
  return res;
}

function tmdbImage(p, size) {
  return p ? TMDB_IMG + '/' + size + p : null;
}

function tmdbItem(x, kind) {
  const title = cleanText(kind === 'series' ? (x.name || x.title || '') : (x.title || x.name || ''));
  const date = x.release_date || x.first_air_date || '';
  return {
    id: sanitizeId('tmdb' + kind + x.id, 't'),
    ref: 'tmdb:' + kind + ':' + x.id + ':' + encodeURIComponent(title),
    title,
    kind,
    poster: tmdbImage(x.poster_path, 'w500'),
    backdrop: tmdbImage(x.backdrop_path, 'w780'),
    overview: cleanText(x.overview || ''),
    year: date ? date.slice(0, 4) : null,
    rating: x.vote_average ? Math.round(x.vote_average * 10) / 10 : null,
    ids: { tmdb: x.id }
  };
}

function tmdbRowsOf(j, kind) {
  if (!j || !Array.isArray(j.results)) return [];
  return j.results.filter((x) => x && x.id && !x.adult).map((x) => tmdbItem(x, kind));
}

async function tmdbHomeRows() {
  if (!tmdbReady()) return [];
  const rows = [];
  const specs = [
    { id: 'tmdb-trend-movies', title: '🔥 Tendencias de la semana · Películas', path: '/trending/movie/week', kind: 'movie', genre: 'peliculas' },
    { id: 'tmdb-popular-series', title: '📺 Series populares', path: '/tv/popular', kind: 'series', genre: 'series' },
    { id: 'tmdb-trend-anime', title: '⛩️ Anime en tendencia', path: '/discover/tv', kind: 'series', genre: 'anime', params: { with_genres: '16', sort_by: 'popularity.desc', 'with_original_language': 'ja' } },
    { id: 'tmdb-now-playing', title: '🎬 En cartelera', path: '/movie/now_playing', kind: 'movie', genre: 'peliculas' },
    { id: 'tmdb-top-series', title: '🏆 Mejor valoradas', path: '/tv/top_rated', kind: 'series', genre: 'series' },
    { id: 'tmdb-upcoming', title: '📅 Próximos estrenos', path: '/movie/upcoming', kind: 'movie', genre: 'peliculas' }
  ];
  const settled = await mapLimit(specs, 4, (s) => tmdbFetch(s.path, s.params));
  specs.forEach((s, i) => {
    const j = settled[i] || null;
    const items = tmdbRowsOf(j, s.kind);
    log(`[home] tmdb ${s.id}: ${items.length} items`);
    if (items.length) rows.push({ id: s.id, title: s.title, items: items.slice(0, 24), genre: s.genre });
  });
  return rows;
}

/** TMDB catalog rows for one section tab: items carry ids.tmdb + backdrop + overview + rating (full info pages). */
async function tmdbTabRows(tab) {
  const none = { rows: [], heroImage: null };
  if (!tmdbReady()) return none;
  const specs = tab === 'series' ? [
    { id: 'tmdb-series-pop', title: '📺 Series populares', path: '/tv/popular', kind: 'series' },
    { id: 'tmdb-series-top', title: '🏆 Mejor valoradas', path: '/tv/top_rated', kind: 'series' },
    { id: 'tmdb-series-air', title: '📡 Al aire', path: '/tv/on_the_air', kind: 'series' }
  ] : tab === 'anime' ? [
    { id: 'tmdb-anime-trend', title: '⛩️ Anime en tendencia', path: '/discover/tv', kind: 'series', params: { with_genres: '16', sort_by: 'popularity.desc', with_original_language: 'ja' } },
    { id: 'tmdb-anime-pop', title: '⭐ Anime popular', path: '/discover/tv', kind: 'series', params: { with_genres: '16', sort_by: 'popularity.desc' } }
  ] : [
    { id: 'tmdb-trend-movies', title: '🔥 Tendencias de la semana', path: '/trending/movie/week', kind: 'movie' },
    { id: 'tmdb-now-playing', title: '🎬 En cartelera', path: '/movie/now_playing', kind: 'movie' },
    { id: 'tmdb-pop-movies', title: '🌟 Populares', path: '/movie/popular', kind: 'movie' },
    { id: 'tmdb-top-movies', title: '🏆 Mejor valoradas', path: '/movie/top_rated', kind: 'movie' }
  ];
  const settled = await mapLimit(specs, 4, (s) => tmdbFetch(s.path, s.params));
  const rows = [];
  let heroImage = null;
  specs.forEach((s, i) => {
    const j = settled[i] || null;
    const items = tmdbRowsOf(j, s.kind);
    if (items.length && !heroImage) heroImage = items.find((x) => x.backdrop) ? items.find((x) => x.backdrop).backdrop : null;
    if (items.length) rows.push({ id: s.id, title: s.title, items: items.slice(0, 24), genre: tab });
  });
  log(`[section] tmdb ${tab}: ${rows.length} row(s)`);
  return { rows, heroImage };
}

async function tmdbSearchIds(query) {
  const j = await tmdbFetch('/search/multi', { query, include_adult: 'false' });
  if (!j || !Array.isArray(j.results)) return [];
  const out = [];
  for (const x of j.results) {
    if (!x || !x.id || x.media_type === 'person') continue;
    out.push({ kind: x.media_type === 'tv' ? 'series' : 'movie', id: x.id, title: cleanText(x.name || x.title || ''), year: (x.release_date || x.first_air_date || '').slice(0, 4) });
  }
  return out;
}

function tmdbNormTitle(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function tmdbEnrich(items, query) {
  if (!tmdbReady() || !items.length) return items;
  let hits;
  try { hits = await tmdbSearchIds(query); } catch { return items; }
  if (!hits.length) return items;
  const byTitle = {};
  for (const h of hits) {
    const k = tmdbNormTitle(h.title);
    if (k && !byTitle[k]) byTitle[k] = h;
  }
  for (const it of items) {
    if (it.ids && it.ids.tmdb) continue;
    const h = byTitle[tmdbNormTitle(tmdbQueryTitle(it.title))]
      || byTitle[tmdbNormTitle(stripYearSuffix(it.title))]
      || byTitle[tmdbNormTitle(it.title)];
    if (!h || h.kind !== (it.kind || 'movie')) continue;
    it.ids = { ...(it.ids || {}), tmdb: h.id };
    if (!it.year && h.year) it.year = h.year;
  }
  return items;
}

/** Title → TMDB hit cache (per session) so reopening a section doesn't re-query the same titles. */
const TMDB_LOOKUP = new Map();

/**
 * Fill in info-page fields Kino won't invent: ids.tmdb (drives synopsis/genres/rating/cast enrichment) and
 * backdrop (only your answer counts). One TMDB search per missing title, bounded and cached. Never throws.
 */
async function enrichDetails(items, cap = 36) {
  if (!tmdbReady() || !items || !items.length) return items;
  const pending = items.filter((x) => x && x.title && !(x.ids && x.ids.tmdb));
  let budget = cap;
  await mapLimit(pending, 5, async (it) => {
    if (FETCH_BUDGET <= 5) return;
    const norm = tmdbNormTitle(tmdbQueryTitle(it.title));
    if (!norm) return;
    let hit = TMDB_LOOKUP.get(norm);
    if (hit === undefined) {
      if (budget <= 0) return;
      budget--;
      let j = null;
      try {
        j = await tmdbFetch('/search/multi', { query: tmdbQueryTitle(it.title), include_adult: 'false' });
      } catch { j = null; }
      if (!j || !Array.isArray(j.results)) return; // fallo transitorio: sin cachear, el próximo llamado reintenta
      const want = it.kind === 'series' ? 'tv' : 'movie';
      const list = j.results.filter((x) => x && x.id && x.media_type !== 'person');
      const key = (x) => tmdbNormTitle(x.title || x.name);
      hit = list.find((x) => x.media_type === want && key(x) === norm)
         || list.find((x) => x.media_type === want && (key(x).includes(norm) || norm.includes(key(x))))
         || null;
      if (hit) {
        hit = { id: hit.id, backdrop_path: hit.backdrop_path || null, poster_path: hit.poster_path || null,
                overview: hit.overview || '', vote_average: hit.vote_average || 0,
                date: (hit.release_date || hit.first_air_date || '') };
      }
      TMDB_LOOKUP.set(norm, hit);
    }
    if (!hit) return;
    it.ids = { ...(it.ids || {}), tmdb: hit.id };
    if (!it.backdrop && hit.backdrop_path) it.backdrop = tmdbImage(hit.backdrop_path, 'w780');
    if (!it.overview && hit.overview) it.overview = cleanText(hit.overview);
    if (!it.year && hit.date) it.year = hit.date.slice(0, 4);
    if (!it.rating && hit.vote_average) it.rating = Math.round(hit.vote_average * 10) / 10;
    if (!it.poster && hit.poster_path) it.poster = tmdbImage(hit.poster_path, 'w500');
  });
  return items;
}

async function tmdbCandidates(title, kind) {
  const want = kind === 'series' ? 'series' : 'movie';
  const ids = kind === 'series' ? TMDB_SERIES_SRCS : TMDB_MOVIE_SRCS;
  const settled = await mapLimit(ids, SEARCH_CONCURRENCY, (id) => safeSearch(SOURCES[id], title));
  const out = [];
  const seen = new Set();
  const target = tmdbNormTitle(title);
  const scored = [];
  for (let i = 0; i < settled.length; i++) {
    const hits = settled[i] || [];
    for (const h of hits) {
      if (!h || !h.ref || h.kind !== want) continue;
      const norm = tmdbNormTitle(h.title);
      const score = norm === target ? 3 : (norm && target && (norm.includes(target) || target.includes(norm)) ? 2 : 1);
      if (score === 1) {
        // No title overlap at all: almost always a "related posts" false hit
        // that would burn the fetch budget resolving the WRONG movie. Keep it
        // only when at least one whole word still overlaps (not a substring:
        // "day" inside "doomsday" would wrongly match).
        const tw = new Set(target.split(' ').filter(Boolean));
        if (!norm.split(' ').filter((w) => w.length > 2).some((w) => tw.has(w))) continue;
      }
      scored.push({ srcId: ids[i], ref: h.ref, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  for (const s of scored) {
    if (seen.has(s.ref)) continue;
    seen.add(s.ref);
    out.push(s);
  }
  log(`[tmdb] "${title}" (${want}): ${out.length} candidate(s)`);
  return out;
}

function tmdbSplit(path) {
  const i1 = path.indexOf(':');
  if (i1 === -1) return { kind: path, id: '', title: '' };
  const kind = path.slice(0, i1);
  const rest = path.slice(i1 + 1);
  const i2 = rest.indexOf(':');
  if (i2 === -1) return { kind, id: rest, title: '' };
  return { kind, id: rest.slice(0, i2), title: decodeURIComponent(rest.slice(i2 + 1)) };
}

function tmdbRefParts(ref) {
  const parts = ref.split(':');
  return { srcId: parts[0], path: parts.slice(1).join(':') };
}

registerSource({
  id: 'tmdb',
  label: 'Catálogo TMDB',
  kind: 'movie',
  async search() { return []; },
  async episodes(path) {
    const { kind, title } = tmdbSplit(path);
    if (!title) return { episodes: [] };
    const cands = await tmdbCandidates(title, 'series');
    for (const c of cands) {
      const src = SOURCES[c.srcId];
      if (!src || !src.episodes) continue;
      const { path: p } = tmdbRefParts(c.ref);
      let eps;
      try { eps = await src.episodes(p); } catch { continue; }
      if (eps && eps.episodes && eps.episodes.length) {
        log(`[tmdb] episodes for "${title}" from ${c.srcId}: ${eps.episodes.length}`);
        return eps;
      }
    }
    return { episodes: [] };
  },
  async resolve(path) {
    const { kind, id, title } = tmdbSplit(path);
    // Fast path: n79 resolves straight from the TMDB id in a single request.
    if (id && kind !== 'series') {
      let st;
      try { st = await SOURCES.n79.resolve('movie:' + id); } catch { st = null; }
      if (st && st.url) {
        log(`[tmdb] resolved "${title || id}" via n79 (id ${id})`);
        return st;
      }
    }
    if (!title) return null;
    const cands = await tmdbCandidates(title, kind === 'series' ? 'series' : 'movie');
    for (const c of cands) {
      // The fast path already tried (and rejected) this exact n79 id: don't
      // spend a second round of fetches on the same dead stream.
      if (c.srcId === 'n79' && (c.ref === 'n79:movie:' + id || c.ref === 'n79:serie:' + id)) continue;
      const src = SOURCES[c.srcId];
      if (!src || !src.resolve) continue;
      const { path: p } = tmdbRefParts(c.ref);
      let st;
      try { st = await src.resolve(p); } catch { continue; }
      if (st && st.url) {
        log(`[tmdb] resolved "${title}" via ${c.srcId}`);
        return st;
      }
    }
    log(`[tmdb] no source resolved "${title}"`);
    return null;
  }
});

/* ---------- fan-out orchestration ---------- */

const SEARCH_CONCURRENCY = 5;

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let cursor = 0;
  const workers = [];
  const n = Math.max(1, Math.min(limit, list.length));
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (cursor < list.length) {
        const idx = cursor++;
        out[idx] = await fn(list[idx], idx);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

async function safeSearch(src, q) {
  try { return await src.search(q); } catch { return []; }
}

async function safeHome(src) {
  try { return src.home ? await src.home() : []; } catch { return []; }
}

function stripYearSuffix(s) {
  return String(s || '').replace(/\s*[('(]?\b(?:19|20)\d{2}\b[)]?\s*$/, '').trim();
}

const TMDB_JUNK_END = /^(online|gratis|hd|fhd|en|sub|espa[nñ]ol|latino|castellano|descargar|calidad|completa)$/i;
const TMDB_JUNK_START = /^(ver|mirar|watch|descargar)$/i;

/** Site titles carry promo junk ("VER X Online Gratis HD - Película completa"); peel it for TMDB. */
function tmdbQueryTitle(s) {
  const base = stripYearSuffix(s);
  const peeled = base
    .replace(/\s*[-–—]?\s*pel[íi]cula\s+completa\s*$/i, '')
    .replace(/\s*[-–—]?\s*serie\s+completa\s*$/i, '')
    .trim();
  const words = peeled.split(/\s+/).filter(Boolean);
  let guard = 0;
  while (words.length > 1 && guard++ < 5 && TMDB_JUNK_END.test(words[words.length - 1])) words.pop();
  guard = 0;
  while (words.length > 1 && guard++ < 3 && TMDB_JUNK_START.test(words[0])) words.shift();
  return words.join(' ') || base;
}

function addToGroup(g, item) {
  if (g.seen.has(item.ref)) return;
  g.seen.add(item.ref);
  g.refs.push(item.ref);
  const p = g.primary;
  if (!p.poster && item.poster) p.poster = item.poster;
  if (!p.year && item.year) p.year = item.year;
  if ((p.rating || 0) < (item.rating || 0)) p.rating = item.rating;
  if (!p.overview && item.overview) p.overview = item.overview;
  if (!p.ids && item.ids) p.ids = item.ids;
}

function newGroup(item) {
  return { primary: item, refs: [], seen: new Set(), norm: tmdbNormTitle(stripYearSuffix(item.title)) };
}

function mergeAndRank(results, query) {
  const all = [];
  for (const group of results) for (const item of group) if (item && item.id && item.ref && item.title) all.push(item);

  // Phase 1: group by TMDB id when present (most reliable identity).
  const byTmdb = new Map();
  const loose = [];
  for (const item of all) {
    const tid = item.ids && item.ids.tmdb;
    if (tid) {
      const key = (item.kind || 'movie') + '|t' + tid;
      let g = byTmdb.get(key);
      if (!g) { g = newGroup(item); byTmdb.set(key, g); }
      addToGroup(g, item);
    } else loose.push(item);
  }

  // Bucket loose items by title (year stripped). Attach to a matching TMDB group
  // when possible; otherwise keep together unless items show CONFLICTING years.
  const byNorm = new Map();
  for (const item of loose) {
    const kind = item.kind || 'movie';
    const base = kind + '|' + tmdbNormTitle(stripYearSuffix(item.title));
    let arr = byNorm.get(base);
    if (!arr) { arr = []; byNorm.set(base, arr); }
    arr.push(item);
  }
  const fallbackGroups = [];
  for (const [base, arr] of byNorm) {
    const kind = base.slice(0, base.indexOf('|'));
    const norm = base.slice(base.indexOf('|') + 1);
    const tg = [...byTmdb.values()].find((g) => g.norm === norm && (g.primary.kind || 'movie') === kind);
    if (tg) { for (const it of arr) addToGroup(tg, it); continue; }
    const years = [...new Set(arr.map((it) => it.year).filter(Boolean))];
    if (years.length <= 1) {
      const g = newGroup(arr[0]);
      for (const it of arr) addToGroup(g, it);
      fallbackGroups.push(g);
    } else {
      const byYear = new Map();
      for (const it of arr) {
        const y = it.year || years[0];
        let g = byYear.get(y);
        if (!g) { g = newGroup(it); byYear.set(y, g); }
        addToGroup(g, it);
      }
      for (const g of byYear.values()) fallbackGroups.push(g);
    }
  }

  const out = [];
  for (const g of [...byTmdb.values(), ...fallbackGroups]) {
    if (g.refs.length > 1 && (g.primary.kind || 'movie') !== 'series') {
      g.primary.ref = 'mg:' + encodeURIComponent(JSON.stringify(g.refs));
    }
    out.push(g.primary);
  }
  try { return kino.rank.filterRelevant(out, query); } catch { return out; }
}

/* ---------- exports ---------- */

export async function search(params) {
  await kino.sleep(0);
  fetchBudgetReset();
  let query = '';
  if (typeof params === 'string') query = params.trim();
  else if (params && typeof params.q === 'string') query = params.q.trim();
  else if (params && typeof params.query === 'string') query = params.query.trim();
  log(`[search] called with query: "${query}"`);
  if (!query) return [];

  const ids = Object.keys(SOURCES).filter((id) => id !== 'tmdb');
  log(`[search] dispatching query across ${ids.length} sources`);
  const groups = await mapLimit(ids, SEARCH_CONCURRENCY, async (id, idx) => {
    const hits = await safeSearch(SOURCES[id], query);
    log(`[search] source ${id}: ${hits.length} items`);
    return hits;
  });
  const all = [];
  for (const g of groups) for (const it of g) if (it) all.push(it);
  await tmdbEnrich(all, query);
  const results = mergeAndRank([all], query).slice(0, 100);
  log(`[search] total ranked results: ${results.length}`);
  return results;
}

export async function home() {
  await kino.sleep(0);
  fetchBudgetReset();
  log('[home] loading rows');

  const rows = await tmdbHomeRows();

  if (tmdbWantSourceRows()) {
    const sourcesList = [
      { key: 'sl', id: 'sl-estrenos', title: '🎬 SoloLatino · Estrenos', genre: 'peliculas' },
      { key: 'cc', id: 'cc-peliculas', title: '🍿 CineCalidad · Películas', genre: 'peliculas' },
      { key: 'hs', id: 'hs-estrenos', title: '⚡ HackStore · Cartelera', genre: 'peliculas' },
      { key: 'vpo', id: 'vpo-estrenos', title: '🌟 VerPelículasOnline · Novedades', genre: 'peliculas' },
      { key: 'pgh', id: 'pgh-cine', title: '🎥 PelisGratisHDs · Cine', genre: 'peliculas' },
      { key: 'ppd', id: 'ppd-populares', title: '✨ PelisPlusHD · Tendencias', genre: 'peliculas' },
      { key: 'ent', id: 'ent-estrenos', title: '💎 EntrePelículas · Destacados', genre: 'peliculas' },
      { key: 'cv', id: 'cv-series', title: '📺 CuevanaSerie · Series', genre: 'series' },
      { key: 'n79', id: 'n79-top', title: '🏆 Net79 · Top TMDb', genre: 'peliculas' },
      { key: '1mv', id: '1mv-cinema', title: '🌍 1Movies · Cinema', genre: 'peliculas' },
      { key: 'av1', id: 'av1-anime', title: '🔥 AnimeAV1 · Últimos', genre: 'anime' },
      { key: 'afv', id: 'afv-anime', title: '⭐ AnimeFLV · Populares', genre: 'anime' },
      { key: 'jkanime', id: 'jk-episodios', title: '🎯 JKAnime · Últimos episodios', genre: 'anime' }
    ];
    const settled = await mapLimit(sourcesList, SEARCH_CONCURRENCY, (s) => safeHome(SOURCES[s.key]));
    sourcesList.forEach((s, idx) => {
      const items = settled[idx] || [];
      log(`[home] ${s.key}: ${items.length} items`);
      if (items.length) rows.push({ id: s.id, title: s.title, items: items.slice(0, 30), genre: s.genre });
    });
  }

  log(`[home] total rows: ${rows.length}`);
  return rows;
}

export async function section(param) {
  await kino.sleep(0);
  fetchBudgetReset();
  let selectedTab = 'peliculas';
  if (typeof param === 'string' && param) selectedTab = param;
  else if (param && typeof param.tab === 'string' && param.tab) selectedTab = param.tab;
  log(`[section] opening tab: ${selectedTab}`);

  const tabs = [
    { id: 'peliculas', label: 'Películas' },
    { id: 'series', label: 'Series' },
    { id: 'anime', label: 'Anime' }
  ];

  const HERO_FALLBACK = 'https://image.tmdb.org/t/p/original/kXfqcdQKsToO0OUXHcrrNCHDBzO.jpg';
  const hero = {
    title: 'YojaTV Cine y Series',
    text: 'El mejor catálogo en español latino: estrenos de cartelera, series completas y anime en emisión.',
    image: HERO_FALLBACK
  };

  const rows = [];
  // TMDB catalog rows for this tab (rich: ids.tmdb + backdrop + overview) fetched alongside the source rows.
  const tmdbP = tmdbTabRows(selectedTab);

  if (selectedTab === 'peliculas') {
    const list = [
      { key: 'sl', id: 'sec-sl-movies', title: '🎬 SoloLatino · Películas' },
      { key: 'cc', id: 'sec-cc-movies', title: '🍿 CineCalidad · Novedades' },
      { key: 'hs', id: 'sec-hs-movies', title: '⚡ HackStore · Cartelera' },
      { key: 'vpo', id: 'sec-vpo-movies', title: '🌟 VerPelículasOnline · Estrenos' },
      { key: 'pgh', id: 'sec-pgh-movies', title: '🎥 PelisGratisHDs · HD' },
      { key: 'ppd', id: 'sec-ppd-movies', title: '✨ PelisPlusHD · Cine' },
      { key: 'ent', id: 'sec-ent-movies', title: '💎 EntrePelículas · Selección' },
      { key: 'n79', id: 'sec-n79-movies', title: '🏆 Net79 · Películas Populares' },
      { key: '1mv', id: 'sec-1mv-movies', title: '🌍 1Movies · Global' }
    ];
    const got = await mapLimit(list, SEARCH_CONCURRENCY, (s) => safeHome(SOURCES[s.key]));
    list.forEach((s, i) => {
      const mv = (got[i] || []).filter((x) => x.kind === 'movie');
      if (mv.length) rows.push({ id: s.id, title: s.title, items: mv.slice(0, 30), genre: 'peliculas' });
    });
  } else if (selectedTab === 'series') {
    const list = [
      { key: 'cv', id: 'sec-cv-series', title: '📺 CuevanaSerie · Populares' },
      { key: 'sl', id: 'sec-sl-series', title: '🔥 SoloLatino · Temporadas' },
      { key: 'pgh', id: 'sec-pgh-series', title: '✨ PelisGratisHDs · Series' },
      { key: 'ent', id: 'sec-ent-series', title: '💎 EntrePelículas · Capítulos' },
      { key: 'n79', id: 'sec-n79-series', title: '🏆 Net79 · Series Populares' }
    ];
    const got = await mapLimit(list, SEARCH_CONCURRENCY, (s) => safeHome(SOURCES[s.key]));
    list.forEach((s, i) => {
      const sv = (got[i] || []).filter((x) => x.kind === 'series');
      if (sv.length) rows.push({ id: s.id, title: s.title, items: sv.slice(0, 30), genre: 'series' });
    });
  } else if (selectedTab === 'anime') {
    const list = [
      { key: 'av1', id: 'sec-av1-anime', title: '🔥 AnimeAV1 · Últimos episodios' },
      { key: 'afv', id: 'sec-afv-anime', title: '⭐ AnimeFLV · En emisión' },
      { key: 'jkanime', id: 'sec-jk-anime', title: '🎯 JKAnime · Lo más visto' }
    ];
    const got = await mapLimit(list, SEARCH_CONCURRENCY, (s) => safeHome(SOURCES[s.key]));
    list.forEach((s, i) => {
      const an = got[i] || [];
      if (an.length) rows.push({ id: s.id, title: s.title, items: an.slice(0, 30), genre: 'anime' });
    });
  }

  const tmdb = await tmdbP;
  if (tmdb.heroImage) hero.image = tmdb.heroImage;
  // Give source rows the info-page fields Kino won't invent (ids.tmdb drives synopsis/rating/genres/cast;
  // backdrop only counts if we provide it). One round-robin pass so every row shares the bounded budget.
  const cols = rows.map((r) => r.items);
  const flat = [];
  const maxLen = cols.reduce((m, c) => Math.max(m, c.length), 0);
  for (let i = 0; i < maxLen; i++) for (const c of cols) if (c[i]) flat.push(c[i]);
  await enrichDetails(flat, 36);
  // TMDB rows first: they always carry full details and resolve via the n79 id fast path.
  rows.unshift(...tmdb.rows);

  log(`[section] returned ${rows.length} rows for tab ${selectedTab}`);
  return { tabs, tab: selectedTab, hero, rows };
}

export async function categories() {
  await kino.sleep(0);
  fetchBudgetReset();
  log('[categories] returning categories list');
  return [
    { id: 'cat-peliculas', title: 'Películas de Estreno', ref: 'browse:movies', art: 'https://image.tmdb.org/t/p/w780/eZ239CUp1d6OryZEBPnO2n87gMG.jpg' },
    { id: 'cat-series', title: 'Series de TV', ref: 'browse:series', art: 'https://image.tmdb.org/t/p/w780/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg' },
    { id: 'cat-anime', title: 'Anime Japonés', ref: 'browse:anime', art: 'https://image.tmdb.org/t/p/w780/rqbCbjB19amtOtFQbb3K2lgm2zv.jpg' },
    { id: 'cat-accion', title: 'Acción y Aventura', ref: 'browse:action', art: 'https://image.tmdb.org/t/p/w780/gqrnQA6Xppdl8vIb2eJc58VC1tW.jpg' },
    { id: 'cat-terror', title: 'Terror y Suspenso', ref: 'browse:horror', art: 'https://image.tmdb.org/t/p/w780/ecKQlAEG95k62SMGhvX83oEqANK.jpg' }
  ];
}

export async function settingsStatus() {
  const kt = typeof kino.tmdb === 'function';
  const hasKey = !!tmdbKey();
  const ready = kt || hasKey;
  const lang = tmdbLang();
  const src = tmdbWantSourceRows();
  const lines = [];
  lines.push(ready ? (kt ? 'Catálogo TMDB activo · llave de Kino (' + lang + ')' : 'Catálogo TMDB activo (' + lang + ')') : 'Sin API key de TMDB: el catálogo usa solo las fuentes');
  lines.push(src ? 'Filas de fuentes: activadas' : 'Filas de fuentes: ocultas');
  lines.push(ready ? (kt ? 'Búsqueda enriquecida con TMDb (sin llave propia)' : 'Búsqueda enriquecida con TMDb') : 'Pega tu API key para mejorar el catálogo');
  return { estado: lines.join(' · ') };
}

export async function browse(params) {
  await kino.sleep(0);
  fetchBudgetReset();
  let ref = '';
  if (typeof params === 'string') ref = params;
  else if (params && typeof params.cursor === 'string') ref = params.cursor;
  else if (params && params.ref) ref = params.ref;

  log(`[browse] called with ref: "${ref}"`);

  if (ref.startsWith('browse:')) {
    const topic = ref.slice(7);
    log(`[browse] browsing topic: "${topic}"`);
    if (topic === 'movies') {
      const sl = await safeHome(SOURCES.sl);
      const cc = await safeHome(SOURCES.cc);
      const hs = await safeHome(SOURCES.hs);
      const all = [...sl, ...cc, ...hs].filter((x) => x.kind === 'movie');
      log(`[browse] movies topic: ${all.length} items`);
      return { items: all.slice(0, 100), next: null };
    }
    if (topic === 'series') {
      const cv = await safeHome(SOURCES.cv);
      const sl = await safeHome(SOURCES.sl);
      const pgh = await safeHome(SOURCES.pgh);
      const all = [...cv, ...sl, ...pgh].filter((x) => x.kind === 'series');
      log(`[browse] series topic: ${all.length} items`);
      return { items: all.slice(0, 100), next: null };
    }
    if (topic === 'anime') {
      const av1 = await safeHome(SOURCES.av1);
      const afv = await safeHome(SOURCES.afv);
      const jk = await safeHome(SOURCES.jkanime);
      const all = [...av1, ...afv, ...jk];
      log(`[browse] anime topic: ${all.length} items`);
      return { items: all.slice(0, 100), next: null };
    }
    const sl = await safeHome(SOURCES.sl);
    const cc = await safeHome(SOURCES.cc);
    return { items: [...sl, ...cc].slice(0, 100), next: null };
  }

  const [srcId, ...rest] = ref.split(':');
  const src = SOURCES[srcId];
  if (!src) {
    log(`[browse] unknown source: ${srcId}`);
    return { items: [], next: null };
  }

  const path = rest.join(':');
  if (src.episodes) {
    log(`[browse] loading episodes from ${srcId} path: ${path}`);
    const eps = await src.episodes(path);
    const items = (eps.episodes || []).map((e) => ({
      id: sanitizeId(srcId + '-' + e.season + '-' + e.number),
      ref: e.ref,
      title: e.title || ('T' + (e.season || 1) + 'E' + e.number),
      kind: 'series'
    }));
    log(`[browse] ${items.length} episode items from ${srcId}`);
    return { items: items.slice(0, 100), next: null };
  }
  return { items: [], next: null };
}

export async function episodes(params) {
  await kino.sleep(0);
  fetchBudgetReset();
  let ref = '';
  if (typeof params === 'string') ref = params;
  else if (params && typeof params.ref === 'string') ref = params.ref;
  log(`[episodes] called with ref: "${ref}"`);
  if (!ref) return { episodes: [] };

  let srcId, path;
  if (ref.includes(':')) {
    const parts = ref.split(':');
    srcId = parts[0];
    path = parts.slice(1).join(':');
  } else {
    srcId = SOURCES[ref] ? ref : 'jkanime';
    path = ref;
  }

  const src = SOURCES[srcId];
  if (!src || !src.episodes) {
    log(`[episodes] source ${srcId} not found or has no episodes`);
    return { episodes: [] };
  }

  const eps = await src.episodes(path);
  log(`[episodes] ${srcId} returned ${(eps.episodes || []).length} episodes`);
  return { episodes: eps.episodes || [] };
}

async function resolveOneRef(ref) {
  let srcId, path;
  if (ref.includes(':')) {
    const parts = ref.split(':');
    srcId = parts[0];
    path = parts.slice(1).join(':');
  } else {
    srcId = SOURCES[ref] ? ref : 'cv';
    path = ref;
  }
  const src = SOURCES[srcId];
  if (!src || !src.resolve) return null;
  let stream;
  try { stream = await src.resolve(path); } catch { return null; }
  return stream && stream.url ? stream : null;
}

export async function resolve(params) {
  await kino.sleep(0);
  fetchBudgetReset();
  let ref = '';
  if (typeof params === 'string') ref = params;
  else if (params && typeof params.ref === 'string') ref = params.ref;
  log(`[resolve] resolving stream for ref: "${ref}"`);
  if (!ref) {
    log('[resolve ERROR] missing ref');
    throw kino.error('not_found', 'Referencia no especificada');
  }

  if (ref.startsWith('mg:')) {
    let refs = [];
    try { refs = JSON.parse(decodeURIComponent(ref.slice(3))); } catch {}
    if (!Array.isArray(refs) || !refs.length) {
      log('[resolve ERROR] malformed merged ref');
      throw kino.error('not_found', 'Referencia fusionada inválida');
    }
    log(`[resolve] merged ref across ${refs.length} sources`);
    const settled = await mapLimit(refs.slice(0, 8), 3, (r) => resolveOneRef(r));
    const streams = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s && s.url) {
        const sid = refs[i].split(':')[0];
        const name = (SOURCES[sid] && SOURCES[sid].label) || sid;
        let q = null;
        if (typeof s.label === 'string') {
          const m = /^(\d{3,4}p)\b/.exec(s.label.trim());
          if (m) q = m[1];
        }
        if (!q) q = qualityFromUrl(s.url);
        streams.push({ ...s, label: srvLabel(q, name) || name });
      }
    }
    if (!streams.length) {
      log('[resolve ERROR] no source resolved the merged ref');
      throw kino.error('unavailable', 'No se encontró un servidor de reproducción');
    }
    const primary = streams[0];
    const alts = streams.slice(1, 6).map((s) => ({ label: s.label || 'Servidor', url: s.url, ...(s.headers ? { headers: s.headers } : {}) }));
    log(`[resolve OK] merged resolved via ${streams.length} source(s): ${primary.url}`);
    return { url: primary.url, label: primary.label, ...(primary.headers ? { headers: primary.headers } : {}), ...(alts.length ? { alternatives: alts } : {}) };
  }

  const sid = ref.includes(':') ? ref.split(':')[0] : (SOURCES[ref] ? ref : 'cv');
  if (!SOURCES[sid]) {
    log(`[resolve ERROR] unknown source: ${sid}`);
    throw kino.error('not_found', 'Fuente desconocida');
  }
  const stream = await resolveOneRef(ref);
  if (!stream) {
    log(`[resolve ERROR] no stream returned for ${ref}`);
    throw kino.error('unavailable', 'No se encontró un servidor de reproducción');
  }
  log(`[resolve OK] stream resolved: ${stream.url}`);
  return labelStream(stream, SOURCES[sid].label || sid);
}
