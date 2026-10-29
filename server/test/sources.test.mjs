import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceStats, srcIdOfRef } from '../lib/sources.js';
import { qualityOf, qualityRank, labelFor, qualityFromUrl } from '../lib/quality.js';

test('srcIdOfRef lee la fuente del ref y no inventa con los mg', () => {
  assert.equal(srcIdOfRef('fuegocine:movie:abc'), 'fuegocine');
  assert.equal(srcIdOfRef('jkanime'), 'jkanime');
  assert.equal(srcIdOfRef('mg:%5B%22a%22%5D'), null);
  assert.equal(srcIdOfRef(''), null);
});

test('las fuentes rápidas quedan primero en el ranking', () => {
  const s = new SourceStats();
  s.observe('lenta', 4000, true);
  s.observe('lenta', 5000, true);
  s.observe('rapida', 300, true);
  s.observe('rapida', 250, true);
  // 'nueva' sin datos: puntúa lo neutral y no se cuela por delante de las que sí responden rápido

  const ranked = s.rankRefs(['lenta:x', 'nueva:y', 'rapida:z']);
  assert.equal(ranked[0], 'rapida:z');
  assert.equal(ranked[ranked.length - 1], 'lenta:x');
  assert.ok(s.score('rapida') < s.score('nueva'));
  assert.ok(s.score('nueva') < s.score('lenta'));
});

test('tres fallos seguidos abren el cortacircuitos y luego se cierra solo', () => {
  let now = 1_000_000;
  const s = new SourceStats({ now: () => now });
  s.observe('mala', 1000, false);
  s.observe('mala', 1000, false);
  assert.equal(s.isOpen('mala'), false, 'dos fallos no bastan');
  s.observe('mala', 1000, false);
  assert.equal(s.isOpen('mala'), true, 'tercer fallo abre');
  assert.equal(s.score('mala'), Number.POSITIVE_INFINITY);

  now += 46_000;
  assert.equal(s.isOpen('mala'), false, 'se cierra sola');
  assert.ok(Number.isFinite(s.score('mala')));
});

test('un acierto limpia los fallos seguidos', () => {
  const s = new SourceStats();
  s.observe('ok', 500, false);
  s.observe('ok', 500, false);
  s.observe('ok', 500, true);
  s.observe('ok', 500, false);
  s.observe('ok', 500, false);
  assert.equal(s.isOpen('ok'), false);
});

test('calidad: de la etiqueta, de la URL, y el rótulo armado', () => {
  assert.equal(qualityFromUrl('https://cdn.example.com/movie_1080p.mp4'), '1080p');
  assert.equal(qualityFromUrl('https://cdn.example.com/movie.mp4'), null);
  assert.equal(qualityOf({ label: '720p: FuegoCine', url: 'https://x/v.mp4' }), '720p');
  assert.equal(qualityOf({ label: 'FuegoCine', url: 'https://x/v_480.mp4' }), '480p');
  assert.equal(labelFor('1080p', 'FuegoCine'), '1080p: FuegoCine');
  assert.equal(labelFor(null, 'FuegoCine'), 'FuegoCine');
  assert.ok(qualityRank('2160p') > qualityRank('1080p'));
  assert.ok(qualityRank('1080p') > qualityRank('720p'));
  assert.ok(qualityRank(null) < qualityRank('480p'));
});
