/* ============================================================================
 * Sokoban :: levelsource.js — асинхронная выдача уровней.
 *
 * Зачем: generate() синхронна и на поздних уровнях занимает до ~120 мс на
 * десктопе (замер: lvl 50 ≈ 48 мс, lvl 100 ≈ 120 мс), а в мобильном
 * WebView Telegram это ×5…×10 — заметный фриз интерфейса.
 *
 * Два механизма:
 *   1. Worker — генерация вне UI-потока (недоступен на file:// → фолбэк).
 *   2. Предгенерация — следующий уровень собирается, пока игрок читает
 *      оверлей «УРОВЕНЬ ПРОЙДЕН», и к моменту нажатия «ДАЛЬШЕ» уже готов.
 *
 * Контракт один на оба пути: request() всегда асинхронна.
 * ========================================================================== */
(function (global) {
  'use strict';
  var NS = global.Sokoban = global.Sokoban || {};

  /* Метка версии для обхода кэша: деплой дописывает ?v=<sha> к src скриптов
   * в index.html, отсюда она попадает и в URL воркера. Локально (и при
   * открытии с диска) query нет — строка пустая, поведение прежнее. */
  var VER = (function () {
    var el = global.document.currentScript;
    var q = el && el.src ? el.src.indexOf('?') : -1;
    return q >= 0 ? el.src.slice(q) : '';
  })();

  var worker = null;
  var workerDead = false;
  var seq = 0;

  /** @type {!Object<number, function(!Object)>} колбэки по id запроса */
  var pending = {};

  /** @type {?{n:number, seed:number, level:?Object, cb:?function(!Object)}} */
  var cache = null;

  /** @return {?Worker} воркер или null, если среда его не даёт */
  function getWorker() {
    if (worker || workerDead) return worker;
    // file:// запрещает воркеры почти во всех браузерах — не тратим время.
    if (typeof Worker === 'undefined' || global.location.protocol === 'file:') {
      workerDead = true;
      return null;
    }
    try {
      worker = new Worker('js/gen-worker.js' + VER);
      worker.onmessage = function (e) {
        var cb = pending[e.data.id];
        delete pending[e.data.id];
        if (!cb) return;
        if (e.data.error || !e.data.level) cb(generateSync(e.data.n, e.data.seed));
        else cb(e.data.level);
      };
      worker.onerror = function () {
        // Воркер умер (CSP, 404) — добиваем все висящие запросы синхронно.
        workerDead = true;
        var stuck = pending;
        pending = {};
        Object.keys(stuck).forEach(function (id) { stuck[id](null); });
        worker = null;
      };
    } catch (e) {
      workerDead = true;
      worker = null;
    }
    return worker;
  }

  /** @return {!Object} уровень, собранный в UI-потоке */
  function generateSync(n, seed) {
    return NS.generator.generate(n, seed);
  }

  /**
   * Запускает генерацию, результат уходит в cb.
   * @param {number} n номер уровня
   * @param {number} seed
   * @param {function(!Object)} cb
   */
  function produce(n, seed, cb) {
    var w = getWorker();
    if (w) {
      var id = ++seq;
      pending[id] = function (level) {
        cb(level || generateSync(n, seed)); // воркер отвалился — доделываем сами
      };
      w.postMessage({ id: id, n: n, seed: seed });
      return;
    }
    // Фолбэк: отдаём кадр браузеру, чтобы заставка успела отрисоваться.
    global.setTimeout(function () { cb(generateSync(n, seed)); }, 40);
  }

  /**
   * Уровень по номеру. Если он был предгенерирован — отдаётся мгновенно
   * (но всё равно асинхронно, чтобы вызывающий код имел один сценарий).
   * @param {number} n
   * @param {number} seed
   * @param {function(!Object)} cb
   */
  function request(n, seed, cb) {
    if (cache && cache.n === n && cache.seed === seed) {
      var c = cache;
      cache = null;
      if (c.level) { global.setTimeout(function () { cb(c.level); }, 0); return; }
      c.cb = cb; // генерация ещё идёт — просто перехватываем её результат
      return;
    }
    cache = null;
    produce(n, seed, cb);
  }

  /**
   * Фоновая заготовка уровня. Вызывать сразу после победы на предыдущем.
   * @param {number} n
   * @param {number} seed
   */
  function prefetch(n, seed) {
    if (cache && cache.n === n && cache.seed === seed) return;
    var slot = { n: n, seed: seed, level: null, cb: null };
    cache = slot;
    produce(n, seed, function (level) {
      slot.level = level;
      if (slot.cb) { var cb = slot.cb; slot.cb = null; if (cache === slot) cache = null; cb(level); }
    });
  }

  /** Сбрасывает заготовку (новая партия — новый seed). */
  function reset() { cache = null; }

  NS.levelSource = { request: request, prefetch: prefetch, reset: reset };
})(typeof window !== 'undefined' ? window : globalThis);
