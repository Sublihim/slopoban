/* ============================================================================
 * Sokoban :: gen-worker.js — генерация уровня в фоновом потоке.
 *
 * Классический Worker: importScripts подтягивает те же solver.js и
 * generator.js (они UMD-нейтральны и цепляются к globalThis). Уровень
 * уходит обратно структурным клонированием — Uint8Array-маски переживают
 * его без конвертаций.
 * ========================================================================== */
/* global importScripts, self */
'use strict';
importScripts('solver.js', 'generator.js');

self.onmessage = function (e) {
  var msg = e.data;
  try {
    var level = self.Sokoban.generator.generate(msg.n, msg.seed);
    self.postMessage({ id: msg.id, level: level });
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err && err.message || err) });
  }
};
