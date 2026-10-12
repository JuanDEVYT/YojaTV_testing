// language: JavaScript, file: plugin.js, target: QuickJS (Kino Engine), apiVersion: 6
// Multi-source aggregator for YojaTV. Each source is one entry in SOURCES; the exports fan out,
// merge, rank and isolate failures per source. Refs are "<srcId>:<path>" (path is source-local).
// Sources behind a browser check use kino.browser.page (manifest "browser": "pages").

/* ---------- shared utilities ---------- */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' };

function cleanText(s) {
  if (!s) return '';
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
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

/** Sanitize a title/slug into a valid Kino item id (<=128 chars, ITEM_ID_RE charset). */
function sanitizeId(raw, prefix) {
  const base = String(raw || '').toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^-+|-+$/g, '');
  let id = (prefix ? prefix + '-' : '') + base;
  if (!ITEM_ID_RE.test(id)) id = id.replace(/[^A-Za-z0-9._~-]/g, '');
  return id.length > 128 ? id.slice(0, 128) : id;
}

/* ---------- logging & debug ---------- */

const PLUGIN_VERSION = '3.0.5';

function log(...args) {
  try {
    if (typeof kino !== 'undefined' && kino.log) {
      kino.log(`[YojaTV v${PLUGIN_VERSION}]`, ...args);
    }
  } catch {}
  try {
    if (typeof console !== 'undefined' && console.log) {
      console.log(`[YojaTV v${PLUGIN_VERSION}]`, ...args);
    }
  } catch {}
}

log(`Iniciando plugin YojaTV v${PLUGIN_VERSION} - Por JuandreXter, YojanderGaming y einer_bg`);

async function fetchText(url, headers) {
  log(`[HTTP GET] -> ${url}`);
  try {
    const res = await kino.fetch(url, { headers: { ...HEADERS, ...(headers || {}) } });
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

async function resolveEmbedUrl(embedUrl, referer) {
  if (!embedUrl || typeof embedUrl !== 'string') return null;
  let u = embedUrl.trim();
  if (u.startsWith('//')) u = 'https:' + u;
  if (!u.startsWith('http')) return null;
  if (u.includes('youtube.com') || u.includes('youtu.be')) return null;

  if (/\.(m3u8|mp4)($|\?)/i.test(u)) {
    return { url: u, headers: { 'User-Agent': UA } };
  }

  if (u.includes('vimeos.net') || u.includes('vimeos.zip')) {
    const v = await fetchText(u, { Referer: referer || 'https://vimeos.net/' });
    if (v.ok) {
      const unpacked = extractPackedJs(v.text);
      const m3u = (unpacked || v.text).match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) return { url: m3u[1], headers: { 'User-Agent': UA, 'Referer': 'https://vimeos.net/' } };
      const mp4 = (unpacked || v.text).match(/(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/i);
      if (mp4) return { url: mp4[1], headers: { 'User-Agent': UA, 'Referer': 'https://vimeos.net/' } };
    }
    return null;
  }

  if (u.includes('goodstream.one')) {
    const g = await fetchText(u, { Referer: referer || 'https://goodstream.one/' });
    if (g.ok) {
      const unpacked = extractPackedJs(g.text);
      const m3u = (unpacked || g.text).match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) return { url: m3u[1], headers: { 'User-Agent': UA, 'Referer': 'https://goodstream.one/' } };
      const mp4 = (unpacked || g.text).match(/(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/i);
      if (mp4) return { url: mp4[1], headers: { 'User-Agent': UA, 'Referer': 'https://goodstream.one/' } };
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

  if (u.includes('voe.sx')) {
    const vo = await fetchText(u, { Referer: referer });
    if (vo.ok) {
      const m3u = vo.text.match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) return { url: m3u[1], headers: { 'User-Agent': UA } };
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

  // Generic embed inspection
  try {
    const gen = await fetchText(u, { Referer: referer });
    if (gen.ok) {
      const unpacked = extractPackedJs(gen.text);
      const m3u = (unpacked || gen.text).match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) return { url: m3u[1], headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) } };
      const mp4 = (unpacked || gen.text).match(/(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/i);
      if (mp4) return { url: mp4[1], headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) } };
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
      const imgM = block.match(/data-src="([^"]+)"/i) || block.match(/src="(https?:\/\/[^"]+)"/i);
      items.push({ id, ref: 'vpo:' + type + ':' + slug, title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: type, poster: imgM ? imgM[1] : null });
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
      return st && st.url ? { label: 'VPO ' + nume, ...st } : { label: 'VPO ' + nume, url: embed };
    });

    const settled = await Promise.allSettled(postTasks);
    const streams = settled.filter((s) => s.status === 'fulfilled' && s.value && s.value.url).map((s) => s.value);
    if (streams.length === 0) return null;

    streams.sort((a, b) => {
      const aDir = /\.(m3u8|mp4)($|\?)/i.test(a.url);
      const bDir = /\.(m3u8|mp4)($|\?)/i.test(b.url);
      if (aDir && !bDir) return -1;
      if (!aDir && bDir) return 1;
      return 0;
    });

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
      return { label: serverName + (s.size ? ' (' + s.size + ')' : ''), url: decoded.trim() };
    });

    const settled = await Promise.allSettled(serverTasks);
    const streams = settled.filter((x) => x.status === 'fulfilled' && x.value && x.value.url).map((x) => x.value);
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

    const settled = await Promise.allSettled(opts.map((opt) => resolveEmbedUrl(opt, url)));
    const streams = settled
      .filter((x) => x.status === 'fulfilled' && x.value && x.value.url)
      .map((x) => x.value);

    if (streams.length === 0) return { url: opts[0], alternatives: opts.slice(1, 8).map((u, i) => ({ label: 'Servidor ' + (i + 2), url: u })) };

    streams.sort((a, b) => {
      const aV = a.url.includes('vimeos');
      const bV = b.url.includes('vimeos');
      if (aV && !bV) return 1;
      if (!aV && bV) return -1;
      return 0;
    });

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
      const block = r.text.slice(Math.max(0, m.index - 500), m.index + 500);
      const imgM = /data-src="([^"]+)"|src="([^"]+)"/.exec(block);
      const poster = imgM ? (imgM[1] || imgM[2]) : null;
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
      const block = r.text.slice(Math.max(0, m.index - 500), m.index + 500);
      const imgM = /data-src="([^"]+)"|src="([^"]+)"/.exec(block);
      const poster = imgM ? (imgM[1] || imgM[2]) : null;
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
        const unpacked = extractPackedJs(p.text);
        const m3u = (unpacked || p.text).match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
        return m3u ? { url: m3u[1], headers: { 'User-Agent': UA, 'Referer': 'https://vimeos.net/' } } : null;
      }
      const v = await fetchText(target, { Referer: playUrl });
      if (v.ok) {
        const unpacked = extractPackedJs(v.text);
        const m3u = (unpacked || v.text).match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
        if (m3u) return { url: m3u[1], headers: { 'User-Agent': UA, 'Referer': target.startsWith('https://vimeos.net') ? 'https://vimeos.net/' : target } };
        const mp4 = (unpacked || v.text).match(/(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/i);
        if (mp4) return { url: mp4[1], headers: { 'User-Agent': UA, 'Referer': target.startsWith('https://vimeos.net') ? 'https://vimeos.net/' : target } };
      }
      return null;
    }

    const settled = await Promise.allSettled(playMatches.map((pu) => resolvePlay(pu)));
    const streams = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value && r.value.url && !streams.some((x) => x.url === r.value.url)) {
        streams.push(r.value);
      }
    }
    if (streams.length === 0) return null;

    streams.sort((a, b) => {
      const aV = a.url.includes('vimeos');
      const bV = b.url.includes('vimeos');
      if (aV && !bV) return 1;
      if (!aV && bV) return -1;
      return 0;
    });

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
    const e = await fetchText(embedUrl, { Referer: detailUrl });
    if (e.ok) {
      const m3u = e.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      if (m3u) return { url: m3u[1] };
      const mp4 = e.text.match(/(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/i);
      if (mp4) return { url: mp4[1] };
    }
    return { url: embedUrl };
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
    await fetchText('https://sololatino.net/sanctum/csrf-cookie', { Referer: url });
    let xsrf = kino.cookies.get('https://sololatino.net/', 'XSRF-TOKEN');
    try { xsrf = xsrf ? decodeURIComponent(xsrf) : ''; } catch { xsrf = xsrf || ''; }

    async function resolveOpt(o) {
      const res = await postJson('https://sololatino.net/api/player-url', { t: o.token }, { Referer: url, Origin: 'https://sololatino.net', 'X-XSRF-TOKEN': xsrf || '' });
      if (!res) return null;
      let j;
      try { j = JSON.parse(getText(res)); } catch { return null; }
      const embedUrl = j && j.url;
      if (!embedUrl || !String(embedUrl).startsWith('http')) return null;
      const e = await fetchText(embedUrl, { Referer: url });
      if (e.ok) {
        const m3u = e.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
        if (m3u) return { label: o.label, url: m3u[1] };
        const ifrM = /<iframe[^>]+src="([^"]+)"/i.exec(e.text);
        if (ifrM) return { label: o.label, url: ifrM[1] };
      }
      return { label: o.label, url: embedUrl };
    }

    const settled = await Promise.allSettled(opts.map((o) => resolveOpt(o)));
    const streams = settled.filter((x) => x.status === 'fulfilled' && x.value).map((x) => x.value);
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
      const g = await fetchText(o.url, { Referer: frameUrl });
      if (!g.ok) return null;
      const m3u = g.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      if (m3u) return { label: o.label, url: m3u[1], headers: { 'Referer': 'https://embed.pelisgratishd.lat/' } };
      const mp4 = g.text.match(/(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/i);
      if (mp4) return { label: o.label, url: mp4[1], headers: { 'Referer': 'https://embed.pelisgratishd.lat/' } };
      return null;
    }

    const settled = await Promise.allSettled(opts.map((o) => resolveOpt(o)));
    const resolved = settled.filter((x) => x.status === 'fulfilled' && x.value).map((x) => x.value);

    if (resolved.length > 0) {
      const primary = resolved[0];
      return {
        url: primary.url,
        ...(primary.headers ? { headers: primary.headers } : {}),
        ...(resolved.length > 1 ? { alternatives: resolved.slice(1, 7).map((s) => ({ label: s.label, url: s.url, ...(s.headers ? { headers: s.headers } : {}) })) } : {})
      };
    }
    return { url: opts[0].url, alternatives: opts.slice(1, 6).map((x) => ({ label: x.label, url: x.url })) };
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
      if (srcM) return { url: srcM[1] };
      const iframeM = /<iframe[^>]+src="([^"]+)"/i.exec(r.text);
      if (iframeM) return { url: iframeM[1] };
      const m3u = r.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      if (m3u) return { url: m3u[1] };
    }
    const d = await fetchText(base);
    if (!d.ok) return null;
    const iframe2 = /<iframe[^>]+src="([^"]+)"/i.exec(d.text);
    if (iframe2) return { url: iframe2[1] };
    const playM = /data-url="([^"]+)"/.exec(d.text);
    if (playM) return { url: playM[1] };
    const m3u2 = d.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    return m3u2 ? { url: m3u2[1] } : null;
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
      items.push({ id, ref: 'ent:' + path, title: cleanText(m[4]) || slugToTitle(slug), kind: type, poster: m[3] || null });
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
    const iframes = [...r.text.matchAll(/<iframe[^>]+src="([^"]+)"/gi)].map((x) => x[1]);
    for (let ifr of iframes) {
      if (ifr.startsWith('//')) ifr = 'https:' + ifr;
      if (ifr.startsWith('http') && !ifr.includes('youtube.com')) return { url: ifr };
    }
    const vidM = /\/vidurl\/([^"\/]+)/.exec(r.text);
    if (vidM) {
      const v = await fetchText('https://entrepeliculasyseries.nz/vidurl/' + vidM[1] + '/');
      if (v.ok) {
        const m3u = v.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
        if (m3u) return { url: m3u[1] };
        const iframes2 = [...v.text.matchAll(/<iframe[^>]+src="([^"]+)"/gi)].map((x) => x[1]);
        for (let ifr of iframes2) {
          if (ifr.startsWith('//')) ifr = 'https:' + ifr;
          if (ifr.startsWith('http') && !ifr.includes('youtube.com')) return { url: ifr };
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
      if (/\.m3u8(\?|$)/i.test(s.url)) return { label: s.label, url: s.url };
      if (s.url.includes('mp4upload.com')) {
        const d = await jkanimeMp4upload(s.url);
        return d ? { label: s.label, url: d } : null;
      }
      const r = await fetchText(s.url, { Referer: url });
      if (!r.ok) return null;
      const m3u = r.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      if (m3u) return { label: s.label, url: m3u[1] };
      const mp4 = r.text.match(/(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/i);
      if (mp4) return { label: s.label, url: mp4[1] };
      return { label: s.label, url: s.url };
    }

    const settled = await Promise.allSettled(toResolve.map((s) => resolveAfvServer(s)));
    const streams = settled.filter((x) => x.status === 'fulfilled' && x.value).map((x) => x.value);
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
    return j.items.slice(0, 40).map((x) => {
      const type = x.type === 'tv' ? 'series' : 'movie';
      const id = sanitizeId(String(x.tmdbId), 'n79');
      return { id, ref: 'n79:' + type + ':' + x.tmdbId, title: cleanText(x.title) || slugToTitle(String(x.tmdbId)), kind: type, poster: x.poster || null, year: x.year ? String(x.year) : null, overview: cleanText(x.overview || ''), rating: x.rating ? Math.round(x.rating * 10) / 10 : null };
    }).filter((x) => x.ref);
  },
  async episodes(path) {
    const [type, tmdbId] = path.split(':');
    if (type !== 'series') return { episodes: [] };
    const j = await fetchJson('https://net79.cc/api/catalog/detail?tmdbId=' + tmdbId + '&type=tv');
    if (!j || !j.seasons) return { episodes: [] };
    const list = [];
    for (const s of j.seasons) {
      for (const e of (s.episodes || [])) list.push({ season: s.season || s.number || 1, number: e.episode || e.number || 1, title: e.title || null, ref: 'n79:serie:' + tmdbId + ':' + (s.season || 1) + ':' + (e.episode || 1) });
    }
    return { episodes: list };
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
    if (j.url) return { url: j.url };
    // Response may be array of quality sources [{quality, url}]
    if (Array.isArray(j)) {
      const sorted = j.filter((x) => x && x.url).sort((a, b) => {
        const qa = parseInt(String(a.quality || '0'));
        const qb = parseInt(String(b.quality || '0'));
        return qb - qa; // highest quality first
      });
      if (sorted.length > 0) {
        return {
          url: sorted[0].url,
          ...(sorted.length > 1 ? { alternatives: sorted.slice(1, 8).map((s) => ({ label: (s.quality || '') + 'p', url: s.url })) } : {})
        };
      }
    }
    if (j.sources) {
      const s = j.sources.find((x) => x.url) || j.sources[0];
      if (s && s.url) return { url: s.url };
    }
    return null;
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
    if (j && j.meta && j.meta.embed) return { url: j.meta.embed };
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
            return {
              url: urls[0],
              ...(urls.length > 1 ? { alternatives: urls.slice(1, 6).map((u, i) => ({ label: 'Servidor ' + (i + 2), url: u })) } : {})
            };
          }
        } catch {}
        const urlsRaw = [...txt.matchAll(/(https?:\/\/[^"'\s\\]+)/g)].map((m) => m[1]).filter((u) => !u.includes('youtube'));
        if (urlsRaw.length > 0) return { url: urlsRaw[0] };
      }
    }
    // Fallback: first non-youtube iframe
    const iframes = [...r.text.matchAll(/<iframe[^>]+src="([^"]+)"/gi)].map((m) => m[1]).filter((u) => !u.includes('youtube'));
    if (iframes.length > 0) return { url: iframes[0] };
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
    const r = await fetchText('https://www.pelisplushd.la/search?s=' + encodeURIComponent(q));
    if (!r.ok) return [];
    const items = [];
    const seen = new Set();
    // Match both absolute (https://www.pelisplushd.la/...) and relative (/pelicula/... or /serie/...) hrefs
    const re = /href="(?:https:\/\/www\.pelisplushd\.la)?(\/(?:pelicula|serie|pelicula-animada|serie-animada)\/[^"\/]+\/)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const path = m[1];
      const slug = path.split('/').filter(Boolean).pop();
      if (!isValidSlug(slug)) continue;
      const type = path.includes('/serie') ? 'series' : 'movie';
      const id = sanitizeId(slug, 'ppd');
      if (seen.has(id)) continue;
      seen.add(id);
      const block = r.text.slice(Math.max(0, m.index - 400), m.index + 600);
      const titleM = /alt="([^"]+)"/.exec(block);
      const imgM = /src="([^"]+)"/.exec(block);
      items.push({ id, ref: 'ppd:' + path, title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: type, poster: imgM ? imgM[1] : null });
    }
    return items;
  },
  async resolve(path) {
    const url = 'https://www.pelisplushd.la' + path;
    const r = await fetchText(url);
    if (!r.ok) return null;
    const dataUrlM = /data-url="([^"]+)"/.exec(r.text);
    if (dataUrlM) {
      const e = await fetchText(dataUrlM[1], { Referer: url });
      if (e.ok) {
        const m3u = e.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
        if (m3u) return { url: m3u[1] };
      }
      return { url: dataUrlM[1] };
    }
    const iframeM = /<iframe[^>]+src="([^"]+)"/i.exec(r.text);
    if (iframeM) return { url: iframeM[1] };
    const m3u = r.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    return m3u ? { url: m3u[1] } : null;
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
      const imgM = /src="([^"]+)"/.exec(block);
      items.push({ id, ref: '1mv:' + m[1], title: cleanText(titleM ? titleM[1] : '') || slugToTitle(slug), kind: 'movie', poster: imgM ? imgM[1] : null });
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
              const primary = valid[0];
              const primaryUrl = primary.link || primary.url;
              return {
                url: primaryUrl,
                ...(valid.length > 1 ? { alternatives: valid.slice(1, 6).map((s) => ({ label: s.name || 'Servidor', url: s.link || s.url })) } : {})
              };
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
      const e = await fetchText(iframeM[1], { Referer: url });
      if (e.ok) {
        const m3u = e.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
        if (m3u) return { url: m3u[1] };
      }
      return { url: iframeM[1] };
    }
    const m3u = r.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    return m3u ? { url: m3u[1] } : null;
  }
});

/* ---------- fan-out orchestration ---------- */

const SEARCH_TIMEOUT_MS = 12000;

async function safeSearch(src, q) {
  try { return await Promise.race([src.search(q), new Promise((r) => setTimeout(() => r([]), SEARCH_TIMEOUT_MS))]); }
  catch { return []; }
}

async function safeHome(src) {
  try { return src.home ? await src.home() : []; } catch { return []; }
}

function mergeAndRank(results, query) {
  const seen = new Set();
  const out = [];
  for (const group of results) {
    for (const item of group) {
      if (!item || !item.id || !item.ref || !item.title) continue;
      const key = item.id + '|' + item.ref;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  try { return kino.rank.filterRelevant(out, query); } catch { return out; }
}

/* ---------- exports ---------- */

export async function search(params) {
  await kino.sleep(0);
  let query = '';
  if (typeof params === 'string') query = params.trim();
  else if (params && typeof params.q === 'string') query = params.q.trim();
  else if (params && typeof params.query === 'string') query = params.query.trim();
  log(`[search] called with query: "${query}"`);
  if (!query) return [];

  const ids = Object.keys(SOURCES);
  log(`[search] dispatching query across ${ids.length} sources`);
  const settled = await Promise.allSettled(ids.map((id) => safeSearch(SOURCES[id], query)));
  const groups = settled.map((s, idx) => {
    const hits = s.status === 'fulfilled' ? s.value : [];
    log(`[search] source ${ids[idx]}: ${hits.length} items`);
    return hits;
  });
  const results = mergeAndRank(groups, query).slice(0, 100);
  log(`[search] total ranked results: ${results.length}`);
  return results;
}

export async function home() {
  await kino.sleep(0);
  log('[home] loading curated rows');
  const rows = [];

  const sl = await safeHome(SOURCES.sl);
  log(`[home] sl: ${sl.length} items`);
  if (sl.length) rows.push({ id: 'sl-estrenos', title: '🎬 SoloLatino · Estrenos', items: sl.slice(0, 30), genre: 'peliculas' });

  const cc = await safeHome(SOURCES.cc);
  log(`[home] cc: ${cc.length} items`);
  if (cc.length) rows.push({ id: 'cc-peliculas', title: '🍿 CineCalidad · Películas', items: cc.slice(0, 30), genre: 'peliculas' });

  const hs = await safeHome(SOURCES.hs);
  log(`[home] hs: ${hs.length} items`);
  if (hs.length) rows.push({ id: 'hs-estrenos', title: '⚡ HackStore · Cartelera', items: hs.slice(0, 30), genre: 'peliculas' });

  const pgh = await safeHome(SOURCES.pgh);
  log(`[home] pgh: ${pgh.length} items`);
  if (pgh.length) rows.push({ id: 'pgh-cine', title: '🎥 PelisGratisHDs · Cine', items: pgh.slice(0, 30), genre: 'peliculas' });

  const cv = await safeHome(SOURCES.cv);
  log(`[home] cv: ${cv.length} items`);
  if (cv.length) rows.push({ id: 'cv-series', title: '📺 CuevanaSerie · Series', items: cv.slice(0, 30), genre: 'series' });

  const av1 = await safeHome(SOURCES.av1);
  log(`[home] av1: ${av1.length} items`);
  if (av1.length) rows.push({ id: 'av1-anime', title: '🔥 AnimeAV1 · Últimos', items: av1.slice(0, 30), genre: 'anime' });

  const afv = await safeHome(SOURCES.afv);
  log(`[home] afv: ${afv.length} items`);
  if (afv.length) rows.push({ id: 'afv-anime', title: '⭐ AnimeFLV · Populares', items: afv.slice(0, 30), genre: 'anime' });

  const jk = await safeHome(SOURCES.jkanime);
  log(`[home] jk: ${jk.length} items`);
  if (jk.length) rows.push({ id: 'jk-episodios', title: '🎯 JKAnime · Últimos episodios', items: jk.slice(0, 30), genre: 'anime' });

  log(`[home] total rows: ${rows.length}`);
  return rows;
}

export async function section(tab) {
  await kino.sleep(0);
  const selectedTab = typeof tab === 'string' && tab ? tab : 'peliculas';
  log(`[section] opening tab: ${selectedTab}`);

  const tabs = [
    { id: 'peliculas', label: 'Películas' },
    { id: 'series', label: 'Series' },
    { id: 'anime', label: 'Anime' }
  ];

  const hero = {
    title: 'YojaTV Cine y Series',
    text: 'El mejor catálogo en español latino: estrenos de cartelera, series completas y anime en emisión.',
    image: 'https://image.tmdb.org/t/p/original/mKFLAevD84x6n6T91d1uD36gT6.jpg'
  };

  const rows = [];

  if (selectedTab === 'peliculas') {
    const sl = await safeHome(SOURCES.sl);
    const moviesSl = sl.filter((x) => x.kind === 'movie');
    if (moviesSl.length) rows.push({ id: 'sec-sl-movies', title: '🎬 SoloLatino · Películas', items: moviesSl.slice(0, 30), genre: 'peliculas' });

    const cc = await safeHome(SOURCES.cc);
    const moviesCc = cc.filter((x) => x.kind === 'movie');
    if (moviesCc.length) rows.push({ id: 'sec-cc-movies', title: '🍿 CineCalidad · Novedades', items: moviesCc.slice(0, 30), genre: 'peliculas' });

    const hs = await safeHome(SOURCES.hs);
    const moviesHs = hs.filter((x) => x.kind === 'movie');
    if (moviesHs.length) rows.push({ id: 'sec-hs-movies', title: '⚡ HackStore · Cartelera', items: moviesHs.slice(0, 30), genre: 'peliculas' });

    const pgh = await safeHome(SOURCES.pgh);
    const moviesPgh = pgh.filter((x) => x.kind === 'movie');
    if (moviesPgh.length) rows.push({ id: 'sec-pgh-movies', title: '🎥 PelisGratisHDs · HD', items: moviesPgh.slice(0, 30), genre: 'peliculas' });
  } else if (selectedTab === 'series') {
    const cv = await safeHome(SOURCES.cv);
    const seriesCv = cv.filter((x) => x.kind === 'series');
    if (seriesCv.length) rows.push({ id: 'sec-cv-series', title: '📺 CuevanaSerie · Populares', items: seriesCv.slice(0, 30), genre: 'series' });

    const sl = await safeHome(SOURCES.sl);
    const seriesSl = sl.filter((x) => x.kind === 'series');
    if (seriesSl.length) rows.push({ id: 'sec-sl-series', title: '🔥 SoloLatino · Temporadas', items: seriesSl.slice(0, 30), genre: 'series' });

    const pgh = await safeHome(SOURCES.pgh);
    const seriesPgh = pgh.filter((x) => x.kind === 'series');
    if (seriesPgh.length) rows.push({ id: 'sec-pgh-series', title: '✨ PelisGratisHDs · Series', items: seriesPgh.slice(0, 30), genre: 'series' });
  } else if (selectedTab === 'anime') {
    const av1 = await safeHome(SOURCES.av1);
    if (av1.length) rows.push({ id: 'sec-av1-anime', title: '🔥 AnimeAV1 · Últimos episodios', items: av1.slice(0, 30), genre: 'anime' });

    const afv = await safeHome(SOURCES.afv);
    if (afv.length) rows.push({ id: 'sec-afv-anime', title: '⭐ AnimeFLV · En emisión', items: afv.slice(0, 30), genre: 'anime' });

    const jk = await safeHome(SOURCES.jkanime);
    if (jk.length) rows.push({ id: 'sec-jk-anime', title: '🎯 JKAnime · Lo más visto', items: jk.slice(0, 30), genre: 'anime' });
  }

  log(`[section] returned ${rows.length} rows for tab ${selectedTab}`);
  return { tabs, tab: selectedTab, hero, rows };
}

export async function categories() {
  await kino.sleep(0);
  log('[categories] returning categories list');
  return [
    { id: 'cat-peliculas', title: 'Películas de Estreno', ref: 'browse:movies', art: 'https://image.tmdb.org/t/p/w780/mKFLAevD84x6n6T91d1uD36gT6.jpg' },
    { id: 'cat-series', title: 'Series de TV', ref: 'browse:series', art: 'https://image.tmdb.org/t/p/w780/9faGSFi5jam6pDWGNdcu8R8Gv5v.jpg' },
    { id: 'cat-anime', title: 'Anime Japonés', ref: 'browse:anime', art: 'https://image.tmdb.org/t/p/w780/kXfqcdQKsToO0OUXHcrrNCHDBzO.jpg' },
    { id: 'cat-accion', title: 'Acción y Aventura', ref: 'browse:action', art: 'https://image.tmdb.org/t/p/w780/mKFLAevD84x6n6T91d1uD36gT6.jpg' },
    { id: 'cat-terror', title: 'Terror y Suspenso', ref: 'browse:horror', art: 'https://image.tmdb.org/t/p/w780/9faGSFi5jam6pDWGNdcu8R8Gv5v.jpg' }
  ];
}

export async function browse(params) {
  await kino.sleep(0);
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

export async function resolve(params) {
  await kino.sleep(0);
  let ref = '';
  if (typeof params === 'string') ref = params;
  else if (params && typeof params.ref === 'string') ref = params.ref;
  log(`[resolve] resolving stream for ref: "${ref}"`);
  if (!ref) {
    log('[resolve ERROR] missing ref');
    throw kino.error('not_found', 'Referencia no especificada');
  }

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
  if (!src) {
    log(`[resolve ERROR] unknown source: ${srcId}`);
    throw kino.error('not_found', 'Fuente desconocida');
  }
  if (!src.resolve) {
    log(`[resolve ERROR] source ${srcId} does not support playback`);
    throw kino.error('unavailable', 'Esta fuente no soporta reproducción directa');
  }

  log(`[resolve] calling ${srcId}.resolve with path: "${path}"`);
  const stream = await src.resolve(path);
  if (!stream || !stream.url) {
    log(`[resolve ERROR] no stream returned from ${srcId}`);
    throw kino.error('unavailable', 'No se encontró un servidor de reproducción');
  }
  log(`[resolve OK] stream resolved: ${stream.url}`);
  return stream;
}
