/* ============================================================================
 * Sokoban :: tg.js — адаптер Telegram Mini Apps.
 *
 * Единственный модуль, который знает про window.Telegram.WebApp. Вне
 * Telegram (открытие index.html с диска или с обычного сайта) все методы
 * работают как заглушки поверх window/localStorage, поэтому остальной код
 * не содержит ни одной проверки «а мы в телеге?».
 *
 * Минимальные версии Bot API (см. core.telegram.org/bots/webapps):
 *   6.1 expand, viewportStableHeight, HapticFeedback, BackButton, setHeaderColor
 *   6.9 CloudStorage
 *   7.7 disableVerticalSwipes
 *   8.0 safeAreaInset / contentSafeAreaInset, requestFullscreen
 * Всё, что новее клиента пользователя, тихо деградирует.
 * ========================================================================== */
(function (global) {
  'use strict';
  var NS = global.Sokoban = global.Sokoban || {};

  /** @const {string} ключ сейва в CloudStorage / localStorage */
  var STORE_KEY = 'sokoban_save';

  /** @const {string} цвет фона и шапки — под ретро-палитру игры */
  var CHROME_COLOR = '#140c1c';

  var wa = (global.Telegram && global.Telegram.WebApp) || null;

  /* Скрипт telegram-web-app.js создаёт объект WebApp всегда, даже в обычном
   * браузере. Признак реального запуска внутри клиента — заполненный
   * platform (в браузере он 'unknown'). */
  var inTg = !!(wa && wa.platform && wa.platform !== 'unknown');

  /**
   * @param {string} v версия Bot API, например '7.7'
   * @return {boolean} поддерживает ли текущий клиент эту версию
   */
  function atLeast(v) {
    return inTg && typeof wa.isVersionAtLeast === 'function' && wa.isVersionAtLeast(v);
  }

  /** @param {function()} fn выполнить, проглотив исключение старого клиента */
  function safe(fn) { try { fn(); } catch (e) { /* старый клиент — игнор */ } }

  /* ------------------------------------------------------------------ *
   *                          инициализация                             *
   * ------------------------------------------------------------------ */

  /**
   * Готовит окно мини-аппа: разворачивает на весь экран, гасит вертикальные
   * свайпы (иначе движение по полю сворачивает приложение) и красит хром
   * клиента в цвет игры.
   *
   * expand() растягивает мини-апп до максимума, который клиент готов дать
   * шторке. На планшете этот максимум — маленькое окно посреди экрана, и
   * поле выходит крошечным независимо от вёрстки. Реальный размер даёт
   * только requestFullscreen (Bot API 8.0): мини-апп занимает весь экран.
   * Где не поддерживается (десктоп, старые клиенты) — прилетает
   * fullscreenFailed, остаётся обычный expand().
   *
   * @param {function()=} onViewport колбэк на изменение размеров вьюпорта
   */
  function init(onViewport) {
    applyViewportVars();
    if (!inTg) {
      global.addEventListener('resize', function () {
        applyViewportVars();
        if (onViewport) onViewport();
      });
      return;
    }
    // Имя приложения уже показано в шапке клиента — CSS по этому классу
    // убирает дублирующий логотип на узких экранах.
    if (global.document.body) global.document.body.classList.add('in-telegram');
    safe(function () { wa.ready(); });
    safe(function () { wa.expand(); });
    if (atLeast('7.7')) safe(function () { wa.disableVerticalSwipes(); });
    if (atLeast('6.1')) {
      safe(function () { wa.setHeaderColor(CHROME_COLOR); });
      safe(function () { wa.setBackgroundColor(CHROME_COLOR); });
    }
    if (atLeast('8.0')) safe(function () { wa.setBottomBarColor(CHROME_COLOR); });

    var relay = function () { applyViewportVars(); if (onViewport) onViewport(); };
    safe(function () { wa.onEvent('viewportChanged', relay); });
    if (atLeast('8.0')) {
      safe(function () { wa.onEvent('safeAreaChanged', relay); });
      safe(function () { wa.onEvent('contentSafeAreaChanged', relay); });
      // Полноэкранный режим меняет и вьюпорт, и вырезы: в нём шапка
      // прозрачная, а кнопки клиента висят поверх страницы — их зона
      // приходит в contentSafeAreaInset и уже учтена в applyViewportVars().
      safe(function () { wa.onEvent('fullscreenChanged', relay); });
      safe(function () { wa.onEvent('fullscreenFailed', relay); });
      if (!wa.isFullscreen) safe(function () { wa.requestFullscreen(); });
    }
    global.addEventListener('resize', relay);
  }

  /* ------------------------------------------------------------------ *
   *                        вьюпорт и безопасные зоны                   *
   * ------------------------------------------------------------------ */

  /**
   * Высота видимой области. В Telegram window.innerHeight врёт (учитывает
   * область под свёрнутой шапкой), поэтому берём viewportStableHeight —
   * высоту в последнем «устоявшемся» состоянии.
   * @return {number} px
   */
  function viewportHeight() {
    if (inTg && wa.viewportStableHeight) return wa.viewportStableHeight;
    return global.innerHeight;
  }

  /** @return {number} px */
  function viewportWidth() {
    return global.innerWidth;
  }

  /**
   * Сумма системных вырезов (челка, домашняя полоса) и вырезов клиента
   * (шапка мини-аппа). Bot API 8.0+; на старых клиентах — нули, их
   * подстрахует env(safe-area-inset-*) в CSS.
   * @return {{top:number, bottom:number, left:number, right:number}}
   */
  function safeArea() {
    var z = { top: 0, bottom: 0, left: 0, right: 0 };
    if (!atLeast('8.0')) return z;
    var a = wa.safeAreaInset || z, b = wa.contentSafeAreaInset || z;
    return {
      top: (a.top || 0) + (b.top || 0),
      bottom: (a.bottom || 0) + (b.bottom || 0),
      left: (a.left || 0) + (b.left || 0),
      right: (a.right || 0) + (b.right || 0)
    };
  }

  /** @const {number} ниже этой высоты вьюпорта включается компактный режим */
  var COMPACT_H = 560;

  /** Прокидывает размеры в CSS-переменные (--vh, --sa-*) и включает
   *  компактный режим. Медиазапросы здесь бесполезны: в Telegram высота
   *  окна не меняется, «сжимается» только вьюпорт мини-аппа. */
  function applyViewportVars() {
    var s = global.document.documentElement.style;
    var sa = safeArea();
    var h = viewportHeight();
    var body = global.document.body;
    if (body) body.classList.toggle('compact', h - sa.top - sa.bottom < COMPACT_H);
    s.setProperty('--vh', h + 'px');
    s.setProperty('--sa-top', sa.top + 'px');
    s.setProperty('--sa-bottom', sa.bottom + 'px');
    s.setProperty('--sa-left', sa.left + 'px');
    s.setProperty('--sa-right', sa.right + 'px');
  }

  /* ------------------------------------------------------------------ *
   *                             тактильная отдача                      *
   * ------------------------------------------------------------------ */

  var haptic = {
    /** @param {string} style 'light'|'medium'|'heavy'|'rigid'|'soft' */
    impact: function (style) {
      if (atLeast('6.1')) safe(function () { wa.HapticFeedback.impactOccurred(style); });
    },
    /** @param {string} type 'error'|'success'|'warning' */
    notify: function (type) {
      if (atLeast('6.1')) safe(function () { wa.HapticFeedback.notificationOccurred(type); });
    }
  };

  /* ------------------------------------------------------------------ *
   *                              хранилище                             *
   * ------------------------------------------------------------------ */

  /* CloudStorage привязан к аккаунту и переживает переустановку клиента;
   * вне Telegram (и на клиентах < 6.9) откатываемся на localStorage. */
  var store = {
    /** @param {function(?Object)} cb получает разобранный сейв или null */
    load: function (cb) {
      if (atLeast('6.9')) {
        try {
          wa.CloudStorage.getItem(STORE_KEY, function (err, val) {
            cb(err ? null : parse(val));
          });
          return;
        } catch (e) { /* падаем в localStorage */ }
      }
      cb(parse(lsGet()));
    },
    /** @param {?Object} data null стирает сейв */
    save: function (data) {
      var raw = data === null ? '' : JSON.stringify(data);
      if (atLeast('6.9')) {
        try {
          if (raw) wa.CloudStorage.setItem(STORE_KEY, raw, function () {});
          else wa.CloudStorage.removeItem(STORE_KEY, function () {});
          return;
        } catch (e) { /* падаем в localStorage */ }
      }
      lsSet(raw);
    }
  };

  function parse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function lsGet() { try { return global.localStorage.getItem(STORE_KEY); } catch (e) { return null; } }
  function lsSet(raw) {
    try {
      if (raw) global.localStorage.setItem(STORE_KEY, raw);
      else global.localStorage.removeItem(STORE_KEY);
    } catch (e) { /* приватный режим — сейва не будет */ }
  }

  /* ------------------------------------------------------------------ *
   *                        нативные кнопки клиента                     *
   * ------------------------------------------------------------------ */

  var mainCb = null;

  var mainButton = {
    /**
     * Дублирует главное действие оверлея в нативную кнопку внизу экрана.
     * @param {string} text
     * @param {function()} cb
     * @return {boolean} true, если кнопка реально показана (тогда дубль
     *     внутри панели можно скрыть)
     */
    show: function (text, cb) {
      if (!inTg || !wa.MainButton) return false;
      var ok = false;
      safe(function () {
        if (mainCb) wa.MainButton.offClick(mainCb);
        mainCb = cb;
        wa.MainButton.setParams({ text: text, color: '#597dce', text_color: '#deeed6' });
        wa.MainButton.onClick(mainCb);
        wa.MainButton.show();
        ok = !!wa.MainButton.isVisible;
      });
      return ok;
    },
    hide: function () {
      if (!inTg || !wa.MainButton) return;
      safe(function () {
        if (mainCb) { wa.MainButton.offClick(mainCb); mainCb = null; }
        wa.MainButton.hide();
      });
    }
  };

  var backCb = null;

  var backButton = {
    /** @param {function()} cb */
    show: function (cb) {
      if (!atLeast('6.1') || !wa.BackButton) return;
      safe(function () {
        if (backCb) wa.BackButton.offClick(backCb);
        backCb = cb;
        wa.BackButton.onClick(backCb);
        wa.BackButton.show();
      });
    },
    hide: function () {
      if (!atLeast('6.1') || !wa.BackButton) return;
      safe(function () {
        if (backCb) { wa.BackButton.offClick(backCb); backCb = null; }
        wa.BackButton.hide();
      });
    }
  };

  NS.tg = {
    inTelegram: inTg,
    init: init,
    viewportHeight: viewportHeight,
    viewportWidth: viewportWidth,
    safeArea: safeArea,
    haptic: haptic,
    store: store,
    mainButton: mainButton,
    backButton: backButton
  };
})(typeof window !== 'undefined' ? window : globalThis);
