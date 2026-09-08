/* ============================================================================
 * Sokoban :: main.js — управление, экраны и связка модулей.
 *
 * Ввод: клавиатура (десктоп и Telegram Desktop), экранная крестовина и
 * свайпы по полю (мобильный клиент). Все обращения к Telegram идут через
 * NS.tg — вне мессенджера тот же код работает как обычная веб-страница.
 * ========================================================================== */
(function () {
  'use strict';
  var NS = window.Sokoban;

  var game = new NS.Game();
  var renderer = new NS.Renderer(game, document.getElementById('app'));

  /* ------------------------------ прогресс ------------------------------ */

  function saveProgress() { NS.tg.store.save(game.toSave()); }
  function clearProgress() { NS.tg.store.save(null); }

  /* ------------------------------ экраны -------------------------------- */

  function startLevelFlow() {
    renderer.hideOverlay();
    renderer.buildBoard();
    renderer.toast('УРОВЕНЬ ' + game.levelNum);
    syncBackButton();
  }

  /** Запрос уровня + заставка на время генерации. Генерация идёт в
   *  воркере (или, если он недоступен, в UI-потоке после отрисовки
   *  заставки), поэтому интерфейс не «замерзает». */
  function loadAndStart() {
    renderer.showOverlay('ПОДГОТОВКА', ['Сборка склада...'], [], 'info');
    syncBackButton();
    var n = game.levelNum;
    NS.levelSource.request(n, game.levelSeed(n), function (level) {
      game.beginLevel(level);
      saveProgress();
      startLevelFlow();
    });
  }

  function afterMove(res) {
    if (!res || !res.moved) return;
    renderer.drawState();
    NS.tg.haptic.impact(res.pushed ? 'medium' : 'light');

    if (res.won) {
      NS.tg.haptic.notify('success');
      saveProgress();
      // Пока игрок читает оверлей победы — собираем следующий уровень.
      if (game.levelNum < NS.constants.MAX_LEVEL) {
        var nxt = game.levelNum + 1;
        NS.levelSource.prefetch(nxt, game.levelSeed(nxt));
      }
      setTimeout(function () { renderer.showLevelWon(); syncBackButton(); }, 250);
      return;
    }
    if (res.lost) {
      NS.tg.haptic.notify('error');
      setTimeout(function () {
        if (game.status === 'gameOver') { clearProgress(); renderer.showGameOver(); }
        else { saveProgress(); renderer.showLevelLost(); }
        syncBackButton();
      }, 250);
    }
  }

  function handleAction(act) {
    switch (act) {
      case 'new':
        game.newCampaign();
        NS.levelSource.reset();
        loadAndStart();
        break;
      case 'continue': // сейв уже применён к game при загрузке
        loadAndStart();
        break;
      case 'next':
        if (!game.advance()) { clearProgress(); renderer.showVictory(); syncBackButton(); }
        else loadAndStart();
        break;
      case 'retry':
        game.retryLevel(); // та же раскладка, генерации нет
        startLevelFlow();
        break;
      case 'restart-yes':
        renderer.hideOverlay();
        game.restartLevel();
        if (game.status === 'gameOver') { clearProgress(); renderer.showGameOver(); }
        else { saveProgress(); renderer.showLevelLost(); }
        syncBackButton();
        break;
      case 'restart-no':
        renderer.hideOverlay();
        syncBackButton();
        break;
    }
  }
  renderer.onAction = handleAction;

  /* клики по кнопкам оверлея */
  renderer.overlay.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (btn) handleAction(btn.dataset.act);
  });

  /* ------------------------------- ввод --------------------------------- */

  function overlayOpen() { return renderer.overlay.classList.contains('show'); }

  function tryMove(dir) {
    if (game.status !== 'play' || overlayOpen()) return;
    afterMove(game.move(dir));
  }

  function tryUndo() {
    if (game.status !== 'play' || overlayOpen()) return;
    if (game.undo()) { renderer.drawState(); NS.tg.haptic.impact('soft'); }
    else renderer.toast('НЕЧЕГО ОТМЕНЯТЬ');
  }

  /* клавиатура */
  var KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right'
  };

  document.addEventListener('keydown', function (e) {
    if (game.status !== 'play' || overlayOpen()) {
      // Enter/Space активируют единственную «основную» кнопку оверлея
      if (e.code === 'Enter' || e.code === 'Space') {
        var btn = renderer.overlay.querySelector('.btn');
        if (btn) { e.preventDefault(); btn.click(); }
      } else if (e.code === 'Escape') {
        var cancel = renderer.overlay.querySelector('[data-act="restart-no"]');
        if (cancel) cancel.click();
      }
      return;
    }
    var dir = KEYS[e.code];
    if (dir) { e.preventDefault(); tryMove(dir); return; }
    if (e.code === 'KeyZ') { tryUndo(); return; }
    if (e.code === 'KeyR') { renderer.showRestartConfirm(); syncBackButton(); }
  });

  /* Экранные кнопки: pointerdown вместо click — в мобильном WebView click
   * приходит с задержкой и «съедается» при быстром тапе. */
  function onPress(el, fn) {
    if (!el) return;
    el.addEventListener('pointerdown', function (e) { e.preventDefault(); fn(); });
    // Клавиатурная активация кнопки pointerdown не порождает.
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    });
  }

  document.querySelectorAll('[data-dir]').forEach(function (b) {
    onPress(b, function () { tryMove(b.dataset.dir); });
  });
  onPress(document.getElementById('btn-undo'), tryUndo);
  onPress(document.getElementById('btn-restart'), function () {
    if (game.status === 'play' && !overlayOpen()) { renderer.showRestartConfirm(); syncBackButton(); }
  });

  /* Свайпы по полю — основной способ игры на телефоне: один свайп =
   * один ход. Вертикальные свайпы клиента погашены в tg.init(), иначе
   * они сворачивали бы мини-апп. */
  var SWIPE_MIN = 24; // px, ниже — считаем случайным дрожанием
  var sx = 0, sy = 0, tracking = false;
  var boardEl = document.getElementById('board');

  boardEl.addEventListener('pointerdown', function (e) {
    tracking = true; sx = e.clientX; sy = e.clientY;
  });
  boardEl.addEventListener('pointerup', function (e) {
    if (!tracking) return;
    tracking = false;
    var dx = e.clientX - sx, dy = e.clientY - sy;
    var ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) < SWIPE_MIN) return;
    tryMove(ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  });
  boardEl.addEventListener('pointercancel', function () { tracking = false; });

  /* --------------------- нативная кнопка «назад» ------------------------ */

  /** В игре «назад» = перезапуск уровня (с подтверждением), в диалоге
   *  подтверждения — отмена. На остальных экранах кнопка не нужна. */
  function syncBackButton() {
    var cancel = renderer.overlay.querySelector('[data-act="restart-no"]');
    if (cancel) { NS.tg.backButton.show(function () { handleAction('restart-no'); }); return; }
    if (game.status === 'play' && !overlayOpen()) {
      NS.tg.backButton.show(function () { renderer.showRestartConfirm(); syncBackButton(); });
      return;
    }
    NS.tg.backButton.hide();
  }

  /* ------------------------ вьюпорт и запуск ---------------------------- */

  /* Пересборка поля при изменении окна. В Telegram вьюпорт меняется не
   * только при повороте: он «дышит» при разворачивании мини-аппа и при
   * появлении клавиатуры. */
  var resizeTimer = null;
  NS.tg.init(function () {
    if (game.status !== 'play') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { renderer.buildBoard(); }, 150);
  });

  /* Точка доступа для отладки и автотестов; игровой логики не содержит. */
  NS.app = { game: game, renderer: renderer };

  NS.tg.store.load(function (save) {
    var ok = game.restore(save);
    renderer.showMenu(ok ? save : null);
    syncBackButton();
  });
})();
