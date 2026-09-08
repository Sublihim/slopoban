/* ============================================================================
 * Sokoban :: solver.js — точный решатель и вспомогательная аналитика поля.
 *
 * ТРИ ЗАДАЧИ ФАЙЛА:
 *
 * 1. computeGoalDist(w,h,walls,goals) → Int16Array
 *    Для каждой клетки — МИНИМАЛЬНОЕ число толчков, за которое одиночный
 *    ящик доехал бы из неё до ближайшей цели (multi-source BFS «обратным
 *    ходом» от целей: клетка b получает dist от c=b+d, если игрок мог бы
 *    встать в b-d). INF означает «мёртвая клетка»: ящик там — гарантированный
 *    проигрыш. Другие ящики игнорируются, поэтому оценка нижняя (допустимая).
 *
 * 2. solve(level) — A* по ТОЛЧКАМ.
 *    Состояние = (нормализованная позиция игрока, отсортированные ящики).
 *    «Нормализация»: игрок в любой клетке одной 4-связной области — одно и
 *    то же состояние; представитель — минимальный индекс области (BFS).
 *    Эвристика h = Σ goalDist(ящик) допустима (не переоценивает), значит
 *    A* возвращает точный минимум толчков. Пешие шаги решения считаются
 *    попутно (dist из той же BFS-заливки) — они нужны игре только как
 *    справка, оптимальность по шагам не гарантируется.
 *    Оптимизации: typed arrays; маска ящиков вместо Set; «штампы» вместо
 *    очистки массивов заливки; бинарная куча с tie-break'ом в пользу
 *    большего g (быстрее добирается до листьев).
 *
 * 3. isDeadlocked(level, boxes, justPushed) — мгновенная проверка для игры
 *    после толчка: ящик в мёртвой клетке ИЛИ образовался «замороженный»
 *    2x2-блок (все четыре клетки — стены/ящики и хоть один ящик не на цели).
 *    Обе проверки sound: срабатывание = позиция точно проиграна.
 * ========================================================================== */
(function (global) {
  'use strict';
  var NS = global.Sokoban = global.Sokoban || {};

  var DIRS = [
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 }
  ];

  var INF = 0x3fff;

  /** Мин. число толчков от клетки до ближайшей цели для одиночного ящика
   *  (multi-source BFS обратным ходом от целей). INF = мёртвая клетка. */
  function computeGoalDist(w, h, walls, goals) {
    var n = w * h;
    var dg = new Int16Array(n).fill(INF);
    var q = [], head = 0;
    for (var i = 0; i < n; i++) if (goals[i] && !walls[i]) { dg[i] = 0; q.push(i); }
    while (head < q.length) {
      var c = q[head++], x = c % w, y = (c / w) | 0;
      // ящик в позиции b может быть толкнут В c из b, если игрок встанет в b-d
      for (var d = 0; d < 4; d++) {
        var bx = x - DIRS[d].dx, by = y - DIRS[d].dy;       // откуда толкали
        var px = bx - DIRS[d].dx, py = by - DIRS[d].dy;     // где стоял игрок
        if (bx < 0 || by < 0 || bx >= w || by >= h) continue;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        var b = by * w + bx;
        if (walls[b] || walls[py * w + px] || dg[b] !== INF) continue;
        dg[b] = dg[c] + 1;
        q.push(b);
      }
    }
    return dg;
  }

  /** Мёртвые клетки: ящик оттуда недотолкать ни до одной цели (sound-оценка). */
  function computeDead(w, h, walls, goals) {
    var dg = computeGoalDist(w, h, walls, goals);
    var dead = new Uint8Array(w * h);
    for (var j = 0; j < w * h; j++) dead[j] = (!walls[j] && dg[j] === INF) ? 1 : 0;
    return dead;
  }

  /**
   * A* по толчкам с допустимой эвристикой h = Σ pushDist(ящик → ближайшая цель).
   * level: { w,h,walls,goals,boxes,player, dead? }
   * → { solvable, pushes, steps, aborted }
   *   pushes — МИНИМУМ толчков (A* с допустимой эвристикой оптимален);
   *   steps — пешие шаги найденного решения (для лимита, не оптимум).
   */
  function solve(level, opts) {
    opts = opts || {};
    var maxNodes = opts.maxNodes || 20000;
    var w = level.w, h = level.h, n = w * h;
    var walls = level.walls, goals = level.goals;
    var dg = computeGoalDist(w, h, walls, goals);

    var dist = new Int32Array(n);
    var seen = new Int32Array(n);
    var qbuf = new Int32Array(n);
    var boxMask = new Uint8Array(n);
    var stampNo = 0;

    var DX = [0, 0, -1, 1], DY = [-1, 1, 0, 0];

    function reach(start) {
      stampNo++;
      var head = 0, tail = 0, minIdx = start;
      qbuf[tail++] = start; seen[start] = stampNo; dist[start] = 0;
      while (head < tail) {
        var c = qbuf[head++];
        if (c < minIdx) minIdx = c;
        var x = c % w, y = (c / w) | 0;
        for (var d = 0; d < 4; d++) {
          var nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var ni = ny * w + nx;
          if (walls[ni] || boxMask[ni] || seen[ni] === stampNo) continue;
          seen[ni] = stampNo;
          dist[ni] = dist[c] + 1;
          qbuf[tail++] = ni;
        }
      }
      return minIdx;
    }

    function heur(boxes) {
      var s = 0;
      for (var i = 0; i < boxes.length; i++) {
        var v = dg[boxes[i]];
        if (v >= INF) return INF;
        s += v;
      }
      return s;
    }

    /* бинарная куча: приоритет f = pushes + h, при равенстве — больший g */
    var heap = [];
    function heapPush(node) {
      heap.push(node);
      var i = heap.length - 1;
      while (i > 0) {
        var p = (i - 1) >> 1;
        if (heap[p].f < node.f || (heap[p].f === node.f && heap[p].g >= node.g)) break;
        heap[i] = heap[p]; i = p;
      }
      heap[i] = node;
    }
    function heapPop() {
      var top = heap[0], last = heap.pop();
      if (!heap.length) return top;
      var i = 0, len = heap.length;
      while (true) {
        var l = 2 * i + 1, r = l + 1, best = i;
        var cand = last;
        if (l < len && (heap[l].f < cand.f || (heap[l].f === cand.f && heap[l].g > cand.g))) { best = l; cand = heap[l]; }
        if (r < len && (heap[r].f < cand.f || (heap[r].f === cand.f && heap[r].g > cand.g))) { best = r; }
        if (best === i) break;
        heap[i] = heap[best]; i = best;
      }
      heap[i] = last;
      return top;
    }

    var startBoxes = level.boxes.slice().sort(function (a, b) { return a - b; });
    var h0 = heur(startBoxes);
    if (h0 === 0) return { solvable: true, pushes: 0, steps: 0, aborted: false };
    if (h0 >= INF) return { solvable: false, pushes: -1, steps: -1, aborted: false };

    var visited = new Set();
    heapPush({ p: level.player, b: startBoxes, g: 0, f: h0, steps: 0 });
    var nodes = 0;

    while (heap.length) {
      var cur = heapPop();
      if (++nodes > maxNodes) return { solvable: false, pushes: -1, steps: -1, aborted: true };

      var b = cur.b, len = b.length, i, k;
      for (i = 0; i < len; i++) boxMask[b[i]] = 1;

      var norm = reach(cur.p);
      var nkey = norm + '|' + b.join(',');
      if (visited.has(nkey)) {
        for (i = 0; i < len; i++) boxMask[b[i]] = 0;
        continue;
      }
      visited.add(nkey);

      for (i = 0; i < len; i++) {
        var bx = b[i] % w, by = (b[i] / w) | 0;
        for (var d = 0; d < 4; d++) {
          var fx = bx - DX[d], fy = by - DY[d];
          var tx = bx + DX[d], ty = by + DY[d];
          if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue;
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
          var f = fy * w + fx, t = ty * w + tx;
          if (walls[t] || boxMask[t] || dg[t] >= INF) continue;   // стена/ящик/мёртвая
          if (walls[f] || boxMask[f] || seen[f] !== stampNo) continue;

          var nb = b.slice();
          nb[i] = t;
          nb.sort(function (a, c2) { return a - c2; });
          var nh = heur(nb);
          var nSteps = cur.steps + dist[f] + 1;

          if (nh === 0) {
            for (k = 0; k < len; k++) boxMask[b[k]] = 0;
            return { solvable: true, pushes: cur.g + 1, steps: nSteps, aborted: false };
          }
          heapPush({ p: b[i], b: nb, g: cur.g + 1, f: cur.g + 1 + nh, steps: nSteps });
        }
      }
      for (i = 0; i < len; i++) boxMask[b[i]] = 0;
    }
    return { solvable: false, pushes: -1, steps: -1, aborted: false };
  }

  /** После толчка ящика в justPushed: мёртвая клетка или замороженный 2x2-блок. */
  function isDeadlocked(level, boxes, justPushed) {
    var w = level.w, h = level.h, walls = level.walls, goals = level.goals;
    if (level.dead && level.dead[justPushed] && !goals[justPushed]) return true;

    var bs = new Set(boxes);
    var x = justPushed % w, y = (justPushed / w) | 0;
    for (var qx = x - 1; qx <= x; qx++) {
      for (var qy = y - 1; qy <= y; qy++) {
        if (qx < 0 || qy < 0 || qx + 1 >= w || qy + 1 >= h) continue;
        var cells = [qy * w + qx, qy * w + qx + 1, (qy + 1) * w + qx, (qy + 1) * w + qx + 1];
        var solid = true, badBox = false;
        for (var k = 0; k < 4; k++) {
          var c = cells[k];
          if (walls[c]) continue;
          if (bs.has(c)) { if (!goals[c]) badBox = true; continue; }
          solid = false; break;
        }
        if (solid && badBox) return true;
      }
    }
    return false;
  }

  NS.solver = { solve: solve, computeDead: computeDead, computeGoalDist: computeGoalDist,
                isDeadlocked: isDeadlocked, INF: INF, DIRS: DIRS };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.solver;
})(typeof window !== 'undefined' ? window : globalThis);
