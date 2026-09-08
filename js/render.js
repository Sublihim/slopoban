/* ============================================================================
 * Sokoban :: render.js — весь DOM: поле, HUD, оверлеи, тосты.
 *
 * Принцип: рендер НИЧЕГО не решает и не меняет в игре — только читает
 * состояние Game и превращает его в DOM. Спрайты (робот, ящики, стены)
 * нарисованы чистым CSS — см. style.css, здесь только классы.
 *
 * Поле — CSS-grid из w×h ячеек; при каждом изменении состояния классы
 * ячеек пересчитываются целиком (drawState). Для полей ≤ 27×17 это
 * дешевле и проще, чем точечные обновления.
 * ========================================================================== */
(function (global) {
  'use strict';
  var NS = global.Sokoban = global.Sokoban || {};

  /** @const {number} нижняя граница тайла: ниже спрайты нечитаемы */
  var MIN_TILE = 10;
  /** @const {number} верхняя: выше поле выглядит не пиксель-артом, а плакатом */
  var MAX_TILE = 64;

  /* Тексты причин провала; ключи приходят из game.failLevel(reason). */
  var FAIL_TEXT = {
    deadlock: 'Ящик застрял намертво — дотолкать его до цели уже невозможно.',
    pushes:   'Лимит шагов с грузом исчерпан.',
    restart:  'Уровень перезапущен вручную.'
  };

  /** root — контейнер приложения; все элементы ищутся один раз здесь. */
  function Renderer(game, root) {
    this.game = game;
    this.root = root;
    this.board = root.querySelector('#board');
    this.hudLevel = root.querySelector('#hud-level');
    this.hudSteps = root.querySelector('#hud-steps');
    this.hudPushes = root.querySelector('#hud-pushes');
    this.hudLives = root.querySelector('#hud-lives');
    this.hudPar = root.querySelector('#hud-par');
    this.overlay = root.querySelector('#overlay');
    /** @type {!Array<!Element>} DOM-ячейки в порядке обхода видимой части */
    this.cells = [];
    /** @type {!Array<number>} индекс клетки уровня для каждой DOM-ячейки */
    this.cellIndex = [];
    /** @type {!Array<?Element>} обратное соответствие: клетка уровня → DOM */
    this.cellAt = [];
    /** @type {?{x0:number, y0:number, w:number, h:number}} видимая часть */
    this.view = null;
    /** @type {?function(string)} обработчик действий кнопок (ставит main.js) */
    this.onAction = null;
  }

  /** Границы непустой части холста в клетках. Генератор рисует уровень на
   *  холсте до 27x17, но комнаты занимают в среднем ~80% по каждой стороне,
   *  а остальное — пустота по краям. Рисуем только этот прямоугольник:
   *  клетка получается примерно в 1.2 раза крупнее без правок генератора.
   *  Вырезанным может быть только void — bounding box по определению
   *  содержит все непустые клетки.
   *  @return {{x0:number, y0:number, w:number, h:number}} */
  Renderer.prototype.viewBounds = function () {
    var l = this.game.level;
    var full = { x0: 0, y0: 0, w: l.w, h: l.h };
    if (!l.voidMask) return full;
    var x0 = l.w, y0 = l.h, x1 = -1, y1 = -1;
    for (var y = 0; y < l.h; y++) {
      for (var x = 0; x < l.w; x++) {
        if (l.voidMask[y * l.w + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return full;   // холст целиком пустой — не наш случай, но пусть
    return { x0: x0, y0: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  };

  /** Высота всего, что занимает место кроме самих клеток: HUD,
   *  крестовина, подсказка, отступы #app и рамка поля. Меряется по
   *  факту: состав HUD, наличие крестовины и величина отступов зависят
   *  от экрана и компактного режима.
   *  @return {number} px */
  Renderer.prototype.chromeHeight = function () {
    var app = this.root, frame = this.board.parentElement;
    var cs = getComputedStyle(app);
    var h = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    var gap = parseFloat(cs.rowGap) || 0;
    var inFlow = 0;

    for (var i = 0; i < app.children.length; i++) {
      var el = app.children[i];
      // Оверлей позиционирован fixed — в потоке не участвует, как и всё
      // скрытое (логотип и подсказка в компактном режиме).
      if (getComputedStyle(el).position === 'fixed' || el.offsetParent === null) continue;
      inFlow++;
      if (el !== frame) h += el.offsetHeight;
    }
    if (inFlow > 1) h += gap * (inFlow - 1);

    var fs = getComputedStyle(frame);
    h += parseFloat(fs.paddingTop) + parseFloat(fs.paddingBottom) +
         parseFloat(fs.borderTopWidth) + parseFloat(fs.borderBottomWidth);
    return h;
  };

  /** Полная пересборка сетки поля. Вызывается при старте уровня
   *  (размеры уровня меняются от раскладки к раскладке) и при изменении
   *  вьюпорта — в Telegram он «дышит» при разворачивании мини-аппа. */
  Renderer.prototype.buildBoard = function () {
    var g = this.game, l = g.level;
    var b = this.board;
    b.innerHTML = '';
    this.cells = [];
    this.cellIndex = [];
    this.cellAt = new Array(l.w * l.h);
    var view = this.view = this.viewBounds();

    // Размеры берём у адаптера: в Telegram window.innerHeight завышен,
    // правду знает только viewportStableHeight, а вырезы — safeAreaInset.
    // Поле занимает всё доступное место: потолок только на сам тайл
    // (MAX_TILE), иначе на планшете и десктопе картинка тонет в пустоте.
    // Чётный размер тайла — чтобы пиксель-арт из CSS-градиентов не «плыл»
    // на полупикселях.
    var sa = NS.tg.safeArea();
    var maxW = NS.tg.viewportWidth() - 32 - sa.left - sa.right;
    var maxH = NS.tg.viewportHeight() - sa.top - sa.bottom - this.chromeHeight();
    var tile = Math.floor(Math.min(maxW / view.w, maxH / view.h));
    tile = Math.max(MIN_TILE, Math.min(tile, MAX_TILE));
    if (tile % 2) tile--;
    b.style.setProperty('--tile', tile + 'px');
    b.style.gridTemplateColumns = 'repeat(' + view.w + ', var(--tile))';

    for (var vy = 0; vy < view.h; vy++) {
      for (var vx = 0; vx < view.w; vx++) {
        var li = (view.y0 + vy) * l.w + (view.x0 + vx);
        var c = document.createElement('div');
        c.className = 'cell';
        b.appendChild(c);
        this.cells.push(c);
        this.cellIndex.push(li);
        this.cellAt[li] = c;
      }
    }
    this.drawState();
  };

  /** Перерисовка динамики: классы ячеек (пол/стена/пустота/цель),
   *  спрайты ящиков и игрока, HUD. Вызывается после каждого хода. */
  Renderer.prototype.drawState = function () {
    var g = this.game, l = g.level;
    for (var i = 0; i < this.cells.length; i++) {
      var li = this.cellIndex[i];
      var cls = 'cell';
      if (l.voidMask && l.voidMask[li]) cls += ' void';
      else if (l.walls[li]) cls += ' wall';
      else {
        cls += ' floor';
        if (l.goals[li]) cls += ' goal';
      }
      this.cells[i].className = cls;
      this.cells[i].innerHTML = '';
    }
    for (var j = 0; j < g.boxes.length; j++) {
      var bi = g.boxes[j];
      var cell = this.cellAt[bi];
      if (!cell) continue;   // ящик вне видимой части невозможен, но пусть
      var box = document.createElement('div');
      box.className = 'sprite box' + (l.goals[bi] ? ' on-goal' : '');
      cell.appendChild(box);
    }
    var pcell = this.cellAt[g.player];
    if (pcell) {
      var pl = document.createElement('div');
      pl.className = 'sprite player face-' + g.facing;
      pl.innerHTML = '<div class="px-head"></div><div class="px-body"></div>';
      pcell.appendChild(pl);
    }
    this.drawHud();
  };

  /** HUD: уровень, пешие шаги (без лимита), шаги с грузом (с лимитом,
   *  подсветка warn при остатке ≤3), оптимум, сердечки жизней. */
  Renderer.prototype.drawHud = function () {
    var g = this.game;
    this.hudLevel.textContent = String(g.levelNum).padStart(3, '0') + '/' + NS.constants.MAX_LEVEL;
    this.hudSteps.textContent = String(g.steps);
    this.hudPushes.textContent = String(g.pushes).padStart(2, '0') + '/' + g.pushLimit;
    this.hudPushes.parentElement.classList.toggle('warn', g.pushLimit - g.pushes <= 3);
    this.hudPar.textContent = g.level ? String(g.level.optimalPushes) : '--';

    var hearts = '';
    for (var i = 0; i < NS.constants.MAX_LIVES; i++) {
      hearts += '<span class="heart' + (i < g.lives ? ' full' : '') + '"></span>';
    }
    this.hudLives.innerHTML = hearts;
  };

  /* ------------------------- оверлеи-сообщения ------------------------- *
   * Единый конструктор showOverlay(title, lines[], buttons[], tone):
   * buttons — [{act, label}], act уходит в main.js через data-act;
   * tone ('info'|'win'|'lose') задаёт цвет рамки в CSS.
   * -------------------------------------------------------------------- */

  Renderer.prototype.showOverlay = function (title, lines, buttons, tone) {
    var o = this.overlay;
    o.className = 'overlay show tone-' + (tone || 'info');
    var html = '<div class="panel"><div class="panel-title">' + title + '</div>';
    for (var i = 0; i < lines.length; i++) html += '<p>' + lines[i] + '</p>';
    html += '<div class="panel-btns">';
    for (var j = 0; j < buttons.length; j++) {
      html += '<button class="btn" data-act="' + buttons[j].act + '">' + buttons[j].label + '</button>';
    }
    html += '</div></div>';
    o.innerHTML = html;
    this.syncMainButton(buttons);
  };

  /** Дублирует кнопку с флагом main в нативную кнопку Telegram. Дубль
   *  внутри панели прячем ТОЛЬКО если клиент подтвердил показ нативной —
   *  иначе игрок остался бы без единственного действия.
   *  @param {!Array<{act:string, label:string, main:(boolean|undefined)}>} buttons */
  Renderer.prototype.syncMainButton = function (buttons) {
    var self = this, main = null;
    for (var i = 0; i < buttons.length; i++) if (buttons[i].main) main = buttons[i];
    if (!main) { NS.tg.mainButton.hide(); return; }
    var shown = NS.tg.mainButton.show(main.label, function () {
      if (self.onAction) self.onAction(main.act);
    });
    if (shown) {
      var el = this.overlay.querySelector('[data-act="' + main.act + '"]');
      if (el) el.classList.add('mirrored');
    }
  };

  Renderer.prototype.hideOverlay = function () {
    this.overlay.className = 'overlay';
    this.overlay.innerHTML = '';
    NS.tg.mainButton.hide();
  };

  /** @param {?{levelNum:number, lives:number}} save найденный сейв или null */
  Renderer.prototype.showMenu = function (save) {
    var btns = [];
    if (save) {
      btns.push({ act: 'continue', main: true, label: '► ПРОДОЛЖИТЬ · УР. ' + save.levelNum });
      btns.push({ act: 'new', label: '✦ НОВАЯ ИГРА' });
    } else {
      btns.push({ act: 'new', main: true, label: '► НАЧАТЬ ИГРУ' });
    }
    this.showOverlay('SOKOBAN',
      ['Дотолкай все ящики до зелёных меток на складе.',
       'Ходить можно сколько угодно, но <b>шаги с грузом</b> лимитированы.',
       'Толкнёшь ящик в безвыходное место — уровень провален сразу.',
       'Стрелки / WASD или свайп по полю · Z — отмена · R — заново.',
       'Пройден уровень — <b>+1 жизнь</b>, провален — <b>−1</b>. Старт: 3 жизни.',
       '100 уровней. Здесь надо думать.'],
      btns, 'info');
  };

  Renderer.prototype.showLevelWon = function () {
    var g = this.game;
    var lifeNote = g.lives >= NS.constants.MAX_LIVES
      ? 'Жизни уже на максимуме (' + NS.constants.MAX_LIVES + ').'
      : '+1 жизнь!';
    this.showOverlay('УРОВЕНЬ ПРОЙДЕН!',
      ['Шагов с грузом: ' + g.pushes + ' (оптимум: ' + g.level.optimalPushes + ')',
       'Пеших шагов: ' + g.steps + '.', lifeNote],
      [{ act: 'next', main: true, label: g.levelNum >= NS.constants.MAX_LEVEL ? '★ ФИНАЛ' : '► ДАЛЬШЕ' }], 'win');
  };

  Renderer.prototype.showLevelLost = function () {
    var g = this.game;
    this.showOverlay('УРОВЕНЬ ПРОВАЛЕН',
      [FAIL_TEXT[g.failReason] || 'Не вышло.', '−1 жизнь. Осталось: ' + g.lives + '.'],
      [{ act: 'retry', main: true, label: '↺ ЕЩЁ РАЗ' }], 'lose');
  };

  Renderer.prototype.showGameOver = function () {
    var g = this.game;
    this.showOverlay('GAME OVER',
      [FAIL_TEXT[g.failReason] || '', 'Жизни закончились.', 'Ты дошёл до уровня ' + g.levelNum + ' из ' + NS.constants.MAX_LEVEL + '.'],
      [{ act: 'new', main: true, label: '► НОВАЯ ИГРА' }], 'lose');
  };

  Renderer.prototype.showVictory = function () {
    this.showOverlay('ПОБЕДА!',
      ['Все ' + NS.constants.MAX_LEVEL + ' уровней пройдены!', 'Осталось жизней: ' + this.game.lives + '.', 'Ты — мастер склада.'],
      [{ act: 'new', main: true, label: '► ИГРАТЬ СНОВА' }], 'win');
  };

  Renderer.prototype.showRestartConfirm = function () {
    this.showOverlay('ПЕРЕЗАПУСК?',
      ['Перезапуск уровня стоит <b>−1 жизнь</b>.', 'Продолжить?'],
      [{ act: 'restart-no', label: '◄ ОТМЕНА' }, { act: 'restart-yes', label: '✕ ДА, −1 ЖИЗНЬ' }], 'info');
  };

  /** Мимолётная плашка («УРОВЕНЬ 42») — живёт 1.6 секунды. */
  Renderer.prototype.toast = function (text) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    this.root.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.remove(); }, 1600);
  };

  NS.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
