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

/* Метка версии приезжает в query воркера (?v=<sha>, её проставляет деплой) и
 * передаётся дальше — иначе обновлённый воркер тянул бы старые solver.js и
 * generator.js из кэша. Локально query нет, строка пустая. */
var VER = self.location.search || '';
importScripts('solver.js' + VER, 'generator.js' + VER);

self.onmessage = function (e) {
  var msg = e.data;
  try {
    var level = self.Sokoban.generator.generate(msg.n, msg.seed);
    self.postMessage({ id: msg.id, level: level });
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err && err.message || err) });
  }
};
