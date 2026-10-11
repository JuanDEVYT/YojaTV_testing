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

async function fetchText(url, headers) {
  try {
    const res = await kino.fetch(url, { headers: { ...HEADERS, ...(headers || {}) } });
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    return { ok: true, status: res.status, text: getText(res), url: res.url };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e };
  }
}

async function fetchJson(url, headers) {
  const r = await fetchText(url, { Accept: 'application/json', ...(headers || {}) });
  if (!r.ok) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

async function postForm(url, form, headers) {
  try {
    const res = await kino.fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', ...(headers || {}) },
      body: form
    });
    if (!res.ok) return null;
    return res;
  } catch { return null; }
}

async function postJson(url, obj, headers) {
  try {
    const res = await kino.fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json', ...(headers || {}) },
      body: JSON.stringify(obj)
    });
    if (!res.ok) return null;
    return res;
  } catch { return null; }
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
    const streams = [];
    for (let nume = 1; nume <= 6; nume++) {
      const res = await postForm('https://ver-peliculas-online.net/wp-admin/admin-ajax.php',
        'action=doo_player_ajax&post=' + postIdM[1] + '&type=movie&nume=' + nume, { Referer: movieUrl });
      if (!res) continue;
      try {
        const j = res.json();
        if (j && typeof j.embed_url === 'string' && j.embed_url.startsWith('http')) {
          streams.push({ label: 'VPO ' + nume, url: j.embed_url.trim() });
        }
      } catch {}
    }
    if (streams.length === 0) return null;
    return { url: streams[0].url, alternatives: streams.slice(1, 8).map((s) => ({ label: s.label, url: s.url })) };
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
    const r = await fetchText('https://jkanime.net/buscar/' + encodeURIComponent(q) + '/1/');
    if (!r.ok) return [];
    const match = r.text.match(/var\s+animes\s*=\s*(\{[\s\S]*?\});\s*(?:var|\n|<)/);
    if (!match) return [];
    let data;
    try { data = JSON.parse(match[1]); } catch { return []; }
    const list = Array.isArray(data.data) ? data.data : [];
    return list.map((x) => {
      const slug = (x.slug || '').trim();
      if (!isValidSlug(slug)) return null;
      const isMovie = (x.tipo && x.tipo.toLowerCase().includes('pel')) || slug.includes('pelicula');
      return { id: slug, ref: 'jkanime:' + slug, title: cleanText(x.title) || slugToTitle(slug), kind: isMovie ? 'movie' : 'series', poster: x.image || null, overview: cleanText(x.synopsis || '') };
    }).filter(Boolean);
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
    const streams = [];
    for (const s of list) {
      if (!s.remote) continue;
      let decoded = '';
      try { decoded = atob(String(s.remote).trim()); } catch { continue; }
      if (!decoded.startsWith('http')) continue;
      const serverName = (s.server || 'Servidor').trim();
      let direct = null;
      if (decoded.includes('mediafire.com')) direct = await jkanimeMediafire(decoded);
      else if (decoded.includes('mp4upload.com')) direct = await jkanimeMp4upload(decoded);
      streams.push({ label: serverName + (s.size ? ' (' + s.size + ')' : ''), url: direct || decoded.trim() });
    }
    if (streams.length === 0) return null;
    return { url: streams[0].url, alternatives: streams.slice(1, 8).map((s) => ({ label: s.label, url: s.url })) };
  }
});

async function jkanimeMediafire(embedUrl) {
  const r = await fetchText(embedUrl);
  if (!r.ok) return null;
  const m = r.text.match(/href="(https?:\/\/download[^"]+)"/i) || r.text.match(/aria-label="Download file"\s+href="([^"]+)"/i);
  return m ? m[1] : null;
}

async function jkanimeMp4upload(embedUrl) {
  const r = await fetchText(embedUrl);
  if (!r.ok) return null;
  const m = r.text.match(/src:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i) || r.text.match(/player\.src\("(https?:\/\/[^"]+)"\)/i);
  return m ? m[1] : null;
}

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
    // path is a full episode/movie URL stored as ref, or "movie:<slug>"
    let url = path;
    if (!url.startsWith('http')) url = 'https://www.cinecalidad.am/ver-pelicula/' + path.split(':').pop() + '/';
    const r = await fetchText(url);
    if (!r.ok) return null;
    const opts = [];
    const optRe = /data-option="([^"]+)"/g;
    let om;
    while ((om = optRe.exec(r.text)) !== null) opts.push(om[1]);
    if (opts.length === 0) return null;
    return { url: opts[0], alternatives: opts.slice(1, 8).map((u, i) => ({ label: 'Servidor ' + (i + 2), url: u })) };
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
  async resolve(path) {
    const [cat, slug] = path.split(':');
    const detailUrl = 'https://www.hackstore.fo/' + cat + '/' + slug + '/';
    const r = await fetchText(detailUrl);
    if (!r.ok) return null;
    const playM = /play\.php\?u=([^&"'\s]+)&b=([^&"'\s]+)/.exec(r.text);
    if (!playM) return null;
    const playUrl = 'https://www.hackstore.fo/play.php?u=' + playM[1] + '&b=' + playM[2];
    const p = await fetchText(playUrl, { Referer: detailUrl });
    if (!p.ok) return null;
    const locM = /location\.href\s*=\s*['"]([^'"]+)['"]/i.exec(p.text);
    if (locM && locM[1]) {
      const target = locM[1];
      if (target.includes('vimeos.net')) {
        const v = await fetchText(target, { Referer: playUrl });
        if (v.ok) {
          const m3u = v.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
          if (m3u) return { url: m3u[1] };
        }
      }
      return { url: target };
    }
    const iframeM = /<iframe[^>]+src="([^"]+)"/i.exec(p.text);
    if (iframeM) {
      const emb = await fetchText(iframeM[1], { Referer: playUrl });
      if (emb.ok) {
        const m3u = emb.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
        if (m3u) return { url: m3u[1] };
      }
      return { url: iframeM[1] };
    }
    const m3u = p.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    return m3u ? { url: m3u[1] } : null;
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
    const gotoM = /href="(\/\/api\.cinehdplus\.org\/ir\/goto\.php\?h=[^"]+)"/i.exec(p.text) || /location\.href\s*=\s*["'](\/\/api\.cinehdplus\.org\/ir\/goto\.php\?h=[^"']+)["']/i.exec(p.text);
    if (gotoM) {
      const g = await fetchText('https:' + gotoM[1], { Referer: playerUrl });
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
    let body = 'action=cinehax_get_embed&_ajax_nonce=' + encodeURIComponent(nonceM[1]) + '&id=' + id + '&tipo=' + tipo;
    if (tipo === 'serie') body += '&season=' + season + '&episode=' + episode;
    const res = await postForm('https://cinehax.com/wp-admin/admin-ajax.php', body, { Referer: detailUrl });
    if (!res) return null;
    const txt = getText(res);
    const m3u = txt.match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
    if (m3u) return { url: m3u[1] };
    const mp4 = txt.match(/(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/i);
    if (mp4) return { url: mp4[1] };
    const embedM = /href="(https?:\/\/[^"]+)"/i.exec(txt);
    if (embedM) {
      const e = await fetchText(embedM[1]);
      if (e.ok) {
        const m2 = e.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
        if (m2) return { url: m2[1] };
      }
      return { url: embedM[1] };
    }
    return null;
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
    let token = kino.cookies.get('https://sololatino.net/', 'XSRF-TOKEN');
    try { token = token ? decodeURIComponent(token) : ''; } catch { token = token || ''; }
    for (const o of opts) {
      const res = await postJson('https://sololatino.net/api/player-url', { t: o.token }, { Referer: url, Origin: 'https://sololatino.net', 'X-XSRF-TOKEN': token || '' });
      if (!res) continue;
      let j;
      try { j = JSON.parse(getText(res)); } catch { continue; }
      const embedUrl = j && j.url;
      if (!embedUrl || !String(embedUrl).startsWith('http')) continue;
      const e = await fetchText(embedUrl, { Referer: url });
      if (e.ok) {
        const m3u = e.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
        if (m3u) return { url: m3u[1] };
        const iframeM = /<iframe[^>]+src="([^"]+)"/i.exec(e.text);
        if (iframeM) return { url: iframeM[1] };
      }
      return { url: embedUrl };
    }
    return null;
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
    for (const o of opts) {
      const g = await fetchText(o.url, { Referer: frameUrl });
      if (!g.ok) continue;
      const m3u = g.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      if (m3u) return { url: m3u[1], alternatives: opts.filter((x) => x !== o).slice(0, 6).map((x) => ({ label: x.label, url: x.url })) };
      const mp4 = g.text.match(/(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/i);
      if (mp4) return { url: mp4[1], alternatives: opts.filter((x) => x !== o).slice(0, 6).map((x) => ({ label: x.label, url: x.url })) };
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
registerSource({
  id: 'pluto',
  label: 'Pluto TV',
  kind: 'movie',
  async search(q) {
    const j = await fetchJson('https://service-media-search.clusters.pluto.tv/v1/search?query=' + encodeURIComponent(q) + '&limit=30');
    if (!j || !Array.isArray(j.hits)) return [];
    return j.hits.slice(0, 30).map((h, i) => {
      const id = sanitizeId(h.id || h.slug || String(i), 'pluto');
      return { id, ref: 'pluto:' + (h.id || h.slug || ''), title: cleanText(h.title) || slugToTitle(h.slug || ''), kind: 'movie', poster: h.poster || null, overview: h.description || null };
    }).filter((x) => x.ref && x.ref.split(':')[1]);
  },
  async resolve(path) {
    const j = await fetchJson('https://service-vod.clusters.pluto.tv/v2/item/' + path + '/playbackInfo?deviceMake=Chrome&deviceType=web&deviceVersion=126.0.0.0&appName=web&appVersion=unknown');
    if (j && j.data) {
      const m3u = String(j.data).match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      if (m3u) return { url: m3u[1] };
    }
    const s = await fetchJson('https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv/v2/stitch/hls/channel/' + path + '.m3u8?deviceId=1234567890123456&deviceMake=Chrome&deviceType=web&deviceVersion=126.0.0.0&appName=web&appVersion=unknown&clientID=1234567890123456&clientModelNumber=1.0.0&sessionID=1234567890123456&serverSideAds=false');
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
      if (zillaM) return { url: 'https://player.zilla-networks.com/m3u8/' + zillaM[1] };
      const m3u = r.text.match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i);
      if (m3u) return { url: m3u[1] };
      const mp4 = r.text.match(/(https?:\/\/[^"'\s\\]+\.mp4[^"'\s\\]*)/i);
      if (mp4) return { url: mp4[1] };
    }
    const pageUrl = ep
      ? 'https://animeav1.com/media/' + slug + '/' + ep
      : 'https://animeav1.com/media/' + slug;
    const hr = await fetchText(pageUrl);
    if (hr.ok) {
      const zillaM = /https?:\/\/player\.zilla-networks\.com\/(?:play|m3u8)\/([A-Za-z0-9_-]+)/.exec(hr.text);
      if (zillaM) return { url: 'https://player.zilla-networks.com/m3u8/' + zillaM[1] };
      const m3u = hr.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      if (m3u) return { url: m3u[1] };
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
    const streams = [];
    for (const s of servers) {
      let direct = null;
      if (/\.m3u8(\?|$)/i.test(s.url)) direct = s.url;
      else if (s.url.includes('mp4upload.com')) direct = await jkanimeMp4upload(s.url);
      else if (s.url.includes('voe.sx')) {
        const v = await fetchText(s.url, { Referer: url });
        if (v.ok) {
          const vm = v.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
          if (vm) direct = vm[1];
        }
      } else {
        const e = await fetchText(s.url, { Referer: url });
        if (e.ok) {
          const em = e.text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
          if (em) direct = em[1];
        }
      }
      streams.push({ label: s.label, url: direct || s.url });
    }
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
    const embedUrl = type === 'series'
      ? 'https://net79.cc/api/embed-tmdb?tmdbId=' + tmdbId + '&type=tv&season=' + season + '&episode=' + episode
      : 'https://net79.cc/api/embed-tmdb?tmdbId=' + tmdbId + '&type=movie';
    const j = await fetchJson(embedUrl);
    if (j && j.url) return { url: j.url };
    if (j && j.sources) {
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
    const j = await fetchJson('https://onlyflix.to/wp-json/wp/v2/' + (type === 'series' ? 'tv' : 'movies') + '/' + id);
    if (j && j.meta && j.meta.embed) return { url: j.meta.embed };
    const r = await fetchText('https://onlyflix.to/' + (type === 'series' ? 'tv' : 'movie') + '/' + id + '/');
    if (!r.ok) return null;
    const iframeM = /<iframe[^>]+src="([^"]+)"/i.exec(r.text);
    if (iframeM) return { url: iframeM[1] };
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
    const re = /<a[^>]+href="(https:\/\/www\.pelisplushd\.la\/[^"]+\/)"/g;
    let m;
    while ((m = re.exec(r.text)) !== null) {
      const path = m[1].replace('https://www.pelisplushd.la', '');
      const slug = path.split('/').filter(Boolean).pop();
      if (!isValidSlug(slug)) continue;
      const type = path.includes('/serie') ? 'series' : 'movie';
      const id = sanitizeId(slug, 'ppd');
      if (seen.has(id)) continue;
      seen.add(id);
      const block = r.text.slice(Math.max(0, m.index - 400), m.index + 400);
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
  if (!query) return [];

  const ids = Object.keys(SOURCES);
  const settled = await Promise.allSettled(ids.map((id) => safeSearch(SOURCES[id], query)));
  const groups = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
  return mergeAndRank(groups, query).slice(0, 100);
}

export async function home() {
  await kino.sleep(0);
  const rows = [];

  const sl = await safeHome(SOURCES.sl);
  if (sl.length) rows.push({ id: 'sl-estrenos', title: '🎬 SoloLatino · Estrenos', items: sl.slice(0, 30), genre: 'peliculas' });

  const av1 = await safeHome(SOURCES.av1);
  if (av1.length) rows.push({ id: 'av1-anime', title: '🔥 AnimeAV1 · Últimos', items: av1.slice(0, 30), genre: 'anime' });

  const afv = await safeHome(SOURCES.afv);
  if (afv.length) rows.push({ id: 'afv-anime', title: '⭐ AnimeFLV · Populares', items: afv.slice(0, 30), genre: 'anime' });

  const jk = await safeHome(SOURCES.jkanime);
  if (jk.length) rows.push({ id: 'jk-episodios', title: '🎯 JKAnime · Últimos episodios', items: jk.slice(0, 30), genre: 'anime' });

  const pgh = await safeHome(SOURCES.pgh);
  if (pgh.length) rows.push({ id: 'pgh-cine', title: '🎥 PelisGratisHDs · Cine', items: pgh.slice(0, 30), genre: 'peliculas' });

  const cv = await safeHome(SOURCES.cv);
  if (cv.length) rows.push({ id: 'cv-series', title: '📺 CuevanaSerie · Series', items: cv.slice(0, 30), genre: 'series' });

  return rows;
}

export async function browse(params) {
  await kino.sleep(0);
  let ref = '';
  if (typeof params === 'string') ref = params;
  else if (params && typeof params.cursor === 'string') ref = params.cursor;
  else if (params && params.ref) ref = params.ref;

  const [srcId, ...rest] = ref.split(':');
  const src = SOURCES[srcId];
  if (!src) return { items: [], next: null };

  const path = rest.join(':');
  if (src.episodes) {
    const eps = await src.episodes(path);
    const items = (eps.episodes || []).map((e) => ({
      id: sanitizeId(srcId + '-' + e.season + '-' + e.number),
      ref: e.ref,
      title: e.title || ('T' + (e.season || 1) + 'E' + e.number),
      kind: 'series'
    }));
    return { items: items.slice(0, 100), next: null };
  }
  return { items: [], next: null };
}

export async function episodes(params) {
  await kino.sleep(0);
  let ref = '';
  if (typeof params === 'string') ref = params;
  else if (params && typeof params.ref === 'string') ref = params.ref;
  if (!ref) return { episodes: [] };

  const [srcId, ...rest] = ref.split(':');
  const src = SOURCES[srcId];
  if (!src || !src.episodes) return { episodes: [] };

  const path = rest.join(':');
  const eps = await src.episodes(path);
  return { episodes: eps.episodes || [] };
}

export async function resolve(params) {
  await kino.sleep(0);
  let ref = '';
  if (typeof params === 'string') ref = params;
  else if (params && typeof params.ref === 'string') ref = params.ref;
  if (!ref) throw kino.error('not_found', 'Referencia no especificada');

  const [srcId, ...rest] = ref.split(':');
  const src = SOURCES[srcId];
  if (!src) throw kino.error('not_found', 'Fuente desconocida');
  if (!src.resolve) throw kino.error('unavailable', 'Esta fuente no soporta reproducción directa');

  const path = rest.join(':');
  const stream = await src.resolve(path);
  if (!stream || !stream.url) throw kino.error('unavailable', 'No se encontró un servidor de reproducción');
  return stream;
}
