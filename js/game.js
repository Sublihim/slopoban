/* ============================================================================
 * Sokoban :: game.js — состояние партии и правила игры.
 *
 * Класс Game хранит ВСЁ изменяемое состояние: номер уровня, жизни,
 * позиции игрока/ящиков, счётчики шагов и историю ходов. Никакого DOM —
 * за отображение отвечает render.js, за ввод — main.js.
 *
 * Жизненный цикл: newGame() → startLevel() → move()* → (won|lost) →
 * nextLevel()/retryLevel() → ... → gameOver | victory.
 * ========================================================================== */
(function (global) {
  'use strict';
  var NS = global.Sokoban = global.Sokoban || {};

  var MAX_LEVEL = 100;   // всего уровней в кампании (по ТЗ)
  var START_LIVES = 3;    // жизни на старте
  var MAX_LIVES = 9;      // потолок жизней (+1 за каждый пройденный уровень)
  var PUSH_SLACK = 10;    // лимит шагов с грузом = оптимум уровня + этот запас

  var DIRS = {
    up: { dx: 0, dy: -1 },
    down: { dx: 0, dy: 1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 }
  };

  class Game {
    constructor() {
      // seed кампании: генератор детерминирован, поэтому каждая партия
      // получает свой seed, а перезапуск раскладки использует тот же seed
      this.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
      this.reset();
    }
    reset() {
      this.lives = START_LIVES;
      this.levelNum = 1;
      this.status = 'menu'; // menu | play | levelWon | levelLost | gameOver | victory
      this.level = null;
      this.failReason = '';
    }
    /** Детерминированный seed уровня: партия задаётся одним числом,
       *  раскладка любого уровня из неё восстанавливается точно.
       *  @param {number} n
       *  @return {number} */
    levelSeed(n) {
      return (this.seed + n * 101) >>> 0;
    }
    /** Подготовка уровня к игре.
       *  level — готовая раскладка (генерацию выполняет levelsource.js
       *  в фоновом потоке); null/undefined — переиграть ТУ ЖЕ раскладку
       *  после провала. */
    beginLevel(level) {
      if (level) { this.level = level; this.levelNum = level.levelNum; }
      var l = this.level;
      this.boxes = l.boxes.slice();
      this.player = l.player;
      this.facing = 'down';
      this.steps = 0; // пешие шаги (без лимита)
      this.pushes = 0; // шаги с грузом (лимитируются)
      this.pushLimit = l.optimalPushes + PUSH_SLACK;
      this.history = [];
      this.status = 'play';
      this.failReason = '';
    }
    /** Уровень решён, когда каждый ящик стоит на какой-нибудь цели. */
    isSolved() {
      var g = this.level.goals;
      return this.boxes.every(function (b) { return !!g[b]; });
    }
    /**
       * Попытка хода в направлении dirName ('up'|'down'|'left'|'right').
       *
       * Возвращает null, если ход невозможен (стена, ящик упёрся, не наш статус),
       * иначе объект { moved, pushed, won, lost }:
       *   pushed — ход был толчком ящика (увеличил счётчик «с грузом»);
       *   won    — этим ходом уровень решён (+1 жизнь уже начислена);
       *   lost   — этим ходом уровень провален (тупик или лимит толчков).
       *
       * Порядок проверок в конце важен: победа проверяется РАНЬШЕ тупика —
       * финальный толчок, запирающий последний ящик на цели, это победа.
       */
    move(dirName) {
      if (this.status !== 'play') return null;
      var d = DIRS[dirName];
      if (!d) return null;
      this.facing = dirName;

      var l = this.level, w = l.w;
      var px = this.player % w, py = (this.player / w) | 0;
      var nx = px + d.dx, ny = py + d.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= l.h) return null;
      var np = ny * w + nx;
      if (l.walls[np]) return null;

      // Есть ли ящик в клетке, куда шагаем? indexOf по массиву из 3-6
      // элементов быстрее и проще любых индексов.
      var bi = this.boxes.indexOf(np);
      var pushedTo = -1;

      if (bi !== -1) {
        // Ящик есть — проверяем клетку ЗА ним: стена/второй ящик = хода нет.
        var bx = nx + d.dx, by = ny + d.dy;
        if (bx < 0 || by < 0 || bx >= w || by >= l.h) return null;
        var bp = by * w + bx;
        if (l.walls[bp] || this.boxes.indexOf(bp) !== -1) return null;
        pushedTo = bp;
      }

      // Снимок состояния ДО хода — для отмены (Z). Храним копию массива
      // ящиков и счётчик толчков; счётчик пеших шагов восстанавливается
      // простым декрементом в undo().
      this.history.push({
        player: this.player, boxes: this.boxes.slice(),
        facing: this.facing, pushes: this.pushes
      });

      if (bi !== -1) { this.boxes[bi] = pushedTo; this.pushes++; }
      this.player = np;
      this.steps++;

      var result = { moved: true, pushed: bi !== -1, won: false, lost: false };

      if (this.isSolved()) {
        result.won = true;
        this.status = 'levelWon';
        if (this.lives < MAX_LIVES) this.lives++;
        return result;
      }

      // тупик: мёртвая клетка или замороженный 2x2-блок — уровень провален
      if (bi !== -1 && NS.solver.isDeadlocked(l, this.boxes, pushedTo)) {
        result.lost = true;
        this.failLevel('deadlock');
        return result;
      }

      // исчерпан лимит шагов с грузом
      if (bi !== -1 && this.pushes >= this.pushLimit) {
        result.lost = true;
        this.failLevel('pushes');
        return result;
      }

      return result;
    }
    /** Отмена последнего хода (клавиша Z). Возвращает false, если
       *  отменять нечего. Отмена бесплатна и не ограничена — этика игры:
       *  наказываем за необдуманный толчок, а не за опечатку. */
    undo() {
      if (this.status !== 'play' || !this.history.length) return false;
      var s = this.history.pop();
      this.player = s.player;
      this.boxes = s.boxes;
      this.facing = s.facing;
      this.pushes = s.pushes;
      this.steps--;
      return true;
    }
    /** Ручной перезапуск уровня — считается провалом (−1 жизнь). */
    restartLevel() {
      if (this.status !== 'play') return;
      this.failLevel('restart');
    }
    /** Общий сток всех провалов. reason ('deadlock'|'pushes'|'restart')
       *  попадает в render.js для текста сообщения. */
    failLevel(reason) {
      this.failReason = reason;
      this.lives--;
      this.status = this.lives <= 0 ? 'gameOver' : 'levelLost';
    }
    /** После levelWon — сдвинуть счётчик уровня. Саму раскладку
       *  подаст levelsource.js через beginLevel(). */
    advance() {
      if (this.levelNum >= MAX_LEVEL) { this.status = 'victory'; return false; }
      this.levelNum++;
      this.level = null;
      return true;
    }
    /** После levelLost — та же раскладка заново. */
    retryLevel() {
      this.beginLevel(null);
    }
    /** Новая партия: новый seed кампании → совершенно новые раскладки.
       *  Уровень не создаётся — его запросит main.js. */
    newCampaign() {
      this.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
      this.reset();
    }
    /** Снимок прогресса для CloudStorage. Раскладка не сохраняется:
       *  генератор детерминирован, seed + номер уровня её воспроизводят.
       *  @return {{v:number, seed:number, levelNum:number, lives:number}} */
    toSave() {
      return { v: 1, seed: this.seed, levelNum: this.levelNum, lives: this.lives };
    }
    /** Восстановление партии из сейва. Уровень начинается сначала —
       *  позиция внутри уровня намеренно не сохраняется.
       *  @param {?Object} s
       *  @return {boolean} удалось ли восстановить */
    restore(s) {
      if (!s || s.v !== 1) return false;
      var n = s.levelNum | 0, lives = s.lives | 0;
      if (!(n >= 1 && n <= MAX_LEVEL) || !(lives >= 1 && lives <= MAX_LIVES)) return false;
      this.seed = s.seed >>> 0;
      this.levelNum = n;
      this.lives = lives;
      this.level = null;
      this.status = 'menu';
      this.failReason = '';
      return true;
    }
  }

  NS.Game = Game;
  NS.constants = { MAX_LEVEL: MAX_LEVEL, START_LIVES: START_LIVES, MAX_LIVES: MAX_LIVES, PUSH_SLACK: PUSH_SLACK };
  if (typeof module !== 'undefined' && module.exports) module.exports = { Game: Game };
})(typeof window !== 'undefined' ? window : globalThis);
