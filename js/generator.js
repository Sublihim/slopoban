/* ============================================================================
 * Sokoban :: generator.js (v4) — процедурный генератор уровней.
 *
 * ОБЩАЯ СХЕМА РАБОТЫ (одна попытка; при неудаче — новая попытка):
 *
 *   1. ПАРАМЕТРЫ.  Для номера уровня n случайно выбираются: класс размера
 *      поля (малый/средний/большой), число ящиков (3–6), схема раскладки
 *      целей и требуемая сложность (нижняя граница толчков).
 *
 *   2. ПЛАНИРОВКА.  На «холсте» вырезаются комнаты, соединяются
 *      Г-образными коридорами, добавляются колонны. Клетки, не граничащие
 *      с полом, помечаются как «пустота» (void) — рендер их не рисует,
 *      получается силуэт лабиринта на чёрном фоне, как в DOS-играх.
 *
 *   3. ЦЕЛИ.  Одна из четырёх схем: кластер в комнате, две группы в разных
 *      комнатах, линия вдоль комнаты или разброс по всему полю.
 *
 *   4. ОБРАТНЫЙ ХОД (скрэмбл).  Ящики ставятся НА цели (решённая позиция)
 *      и «вытягиваются» протяжками: генератор ведёт игрока к ящику и тянет
 *      его на 1–3 клетки. Выбирается протяжка с максимальным приростом
 *      расстояния до целей — так позиция быстро «запутывается».
 *      Любая достигнутая так позиция гарантированно решаема (протяжки
 *      обратимы толчками).
 *
 *   5. ФИЛЬТРЫ БЕЗ РЕШАТЕЛЯ.  Σdg — сумма минимальных push-дистанций
 *      каждого ящика до ближайшей цели — является НИЖНЕЙ ГРАНИЦЕЙ оптимума:
 *        Σdg < minPushes  → позиция слишком простая, отбрасываем;
 *        Σdg > maxPushes  → оптимум заведомо больше лимита, отбрасываем.
 *      Плюс требования: ни один ящик не на цели и не в мёртвой клетке.
 *
 *   6. РЕШАТЕЛЬ.  A* по толчкам (solver.js) подтверждает решаемость и
 *      точный оптимум в диапазоне minPushes..maxPushes (=20).
 *
 * Экспорт: generate(n, seed) → уровень
 *   { w, h, walls, goals, dead, voidMask, boxes, player,
 *     optimalPushes, solSteps, levelNum }
 * ========================================================================== */
(function (global) {
  'use strict';
  var NS = global.Sokoban = global.Sokoban || {};
  var solver = NS.solver || (typeof require !== 'undefined' ? require('./solver.js') : null);

  var MAX_DIM = 40;                       // жёсткий потолок по ТЗ
  var DX = [0, 0, -1, 1], DY = [-1, 1, 0, 0]; // вверх, вниз, влево, вправо

  /* ------------------------------------------------------------------ *
   *  Случайность: детерминированный PRNG (mulberry32).                  *
   *  Один seed → одна и та же последовательность уровней, что удобно    *
   *  для отладки и воспроизведения багов.                               *
   * ------------------------------------------------------------------ */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** Целое в диапазоне [lo..hi] включительно. */
  function pickInt(rand, lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); }
  /** Случайный элемент массива. */
  function pickOne(rand, arr) { return arr[pickInt(rand, 0, arr.length - 1)]; }
  /** Выбор индекса по весам (веса — положительные числа). */
  function pickWeighted(rand, weights) {
    var sum = 0, i;
    for (i = 0; i < weights.length; i++) sum += weights[i];
    var r = rand() * sum;
    for (i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
    return weights.length - 1;
  }

  /* ------------------------------------------------------------------ *
   *  Параметры уровня. Вместо жёсткой прогрессии — случайный выбор      *
   *  с весами, зависящими от номера уровня: рано чаще малые поля и      *
   *  3-4 ящика, поздно — крупные поля и 5-6 ящиков, но разнообразие     *
   *  сохраняется на всём протяжении игры.                               *
   * ------------------------------------------------------------------ */
  function paramsForLevel(n, rand) {
    var t = Math.min(1, (n - 1) / 60); // 0..1 — «зрелость» прогрессии

    // Класс размера поля: [малый, средний, большой].
    // Ранние уровни: 55/35/10, поздние: 15/40/45.
    var sizeClass = pickWeighted(rand, [55 - t * 40, 35 + t * 5, 10 + t * 35]);
    var w, h;
    if (sizeClass === 0)      { w = pickInt(rand, 13, 16); h = pickInt(rand, 9, 11); }
    else if (sizeClass === 1) { w = pickInt(rand, 17, 21); h = pickInt(rand, 11, 14); }
    else                      { w = pickInt(rand, 22, 27); h = pickInt(rand, 14, 17); }

    // Число ящиков 3..6. Вес растёт к 5-6 с прогрессией, но на малом поле
    // больше 4 ящиков не ставим — станет тесно и решатель будет тонуть.
    var boxes = 3 + pickWeighted(rand, [30, 30, 20 + t * 20, 10 + t * 25]);
    if (sizeClass === 0) boxes = Math.min(boxes, 4);

    // Число комнат пропорционально площади холста.
    var rooms = Math.max(3, Math.min(7, Math.round((w * h) / 55)));

    // Нижняя граница сложности: 9..17 толчков (немного растёт с уровнем).
    var minPushes = 9 + Math.floor(t * 5) + pickInt(rand, 0, 2);

    return {
      w: Math.min(MAX_DIM, w),
      h: Math.min(MAX_DIM, h),
      rooms: rooms,
      boxes: boxes,
      minPushes: Math.min(17, minPushes),
      maxPushes: 20,                          // требование ТЗ: оптимум ≤ 20
      pillarShare: 0.03 + rand() * 0.04       // доля колонн от площади пола
    };
  }

  /* ==================================================================== *
   *                            ПЛАНИРОВКА                                *
   * ==================================================================== */

  /** Проверка 4-связности пола: все клетки пола достижимы друг из друга.
   *  Используется после вырезания комнат и после каждой пробной колонны. */
  function connected(w, h, floor) {
    var start = -1, total = 0;
    for (var i = 0; i < w * h; i++) if (floor[i]) { total++; if (start < 0) start = i; }
    if (start < 0) return false;
    var seenA = new Uint8Array(w * h), st = [start], cnt = 1;
    seenA[start] = 1;
    while (st.length) {
      var c = st.pop(), x = c % w, y = (c / w) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var ni = ny * w + nx;
        if (floor[ni] && !seenA[ni]) { seenA[ni] = 1; cnt++; st.push(ni); }
      }
    }
    return cnt === total;
  }

  /** Вырезать прямоугольник пола. */
  function carveRect(floor, w, x0, y0, rw, rh) {
    for (var y = y0; y < y0 + rh; y++)
      for (var x = x0; x < x0 + rw; x++)
        floor[y * w + x] = 1;
  }

  /** Г-образный коридор шириной cw: горизонталь от a, затем вертикаль к b. */
  function carveCorridor(floor, w, ax, ay, bx, by, cw) {
    var x, y, k;
    for (x = Math.min(ax, bx); x <= Math.max(ax, bx); x++)
      for (k = 0; k < cw; k++) floor[(ay + k) * w + x] = 1;
    for (y = Math.min(ay, by); y <= Math.max(ay, by); y++)
      for (k = 0; k < cw; k++) floor[y * w + (bx + k)] = 1;
  }

  /**
   * Планировка: комнаты + коридоры + петля + колонны.
   * Возвращает { floor, rooms } или null, если пол распался на части.
   */
  function buildLayout(rand, W, H, roomCount, pillarShare) {
    var floor = new Uint8Array(W * H);
    var rooms = [];

    // Комнаты кладём случайно; пересечения допустимы — дают «неправильные»
    // формы, склеенные из прямоугольников (как в образце из DOS-игры).
    for (var r = 0; r < roomCount; r++) {
      var rw = pickInt(rand, 4, 7), rh = pickInt(rand, 3, 5);
      var x0 = pickInt(rand, 1, W - rw - 2), y0 = pickInt(rand, 1, H - rh - 2);
      carveRect(floor, W, x0, y0, rw, rh);
      rooms.push({ x: x0, y: y0, w: rw, h: rh, cx: x0 + (rw >> 1), cy: y0 + (rh >> 1) });
    }

    // Цепочка коридоров соединяет комнаты по порядку размещения.
    for (var i = 1; i < rooms.length; i++) {
      carveCorridor(floor, W, rooms[i - 1].cx, rooms[i - 1].cy,
                    rooms[i].cx, rooms[i].cy, rand() < 0.35 ? 2 : 1);
    }
    // Иногда замыкаем первую и последнюю комнаты в кольцо: появляются
    // альтернативные маршруты обхода — важное свойство интересных уровней.
    if (rooms.length > 3 && rand() < 0.7) {
      carveCorridor(floor, W, rooms[0].cx, rooms[0].cy,
                    rooms[rooms.length - 1].cx, rooms[rooms.length - 1].cy, 1);
    }

    // Кайма холста всегда стена/пустота — пол не должен касаться границы.
    for (var yy = 0; yy < H; yy++)
      for (var xx = 0; xx < W; xx++)
        if (xx === 0 || yy === 0 || xx === W - 1 || yy === H - 1) floor[yy * W + xx] = 0;
    if (!connected(W, H, floor)) return null;

    // Колонны: пробуем замуровать случайные клетки пола; если пол
    // распадается — откатываем. Колонны ломают «открытые залы» и заставляют
    // планировать манёвры вокруг препятствий.
    var cells = [];
    for (var f = 0; f < W * H; f++) if (floor[f]) cells.push(f);
    var pillars = Math.round(cells.length * pillarShare);
    for (var p = 0; p < pillars; p++) {
      var cand = pickOne(rand, cells);
      floor[cand] = 0;
      if (!connected(W, H, floor)) floor[cand] = 1;
    }
    return { floor: floor, rooms: rooms };
  }

  /**
   * Маски для решателя и рендера:
   *   walls    — всё, что не пол (решателю не важно, стена это или пустота);
   *   voidMask — клетки без пола в 8-окрестности: рендер рисует их как
   *              чёрную пустоту, а не как кирпич. Так у лабиринта появляется
   *              «силуэт» вместо сплошной кирпичной плиты.
   */
  function buildMasks(W, H, floor) {
    var walls = new Uint8Array(W * H);
    var voidMask = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) {
      if (floor[i]) continue;
      walls[i] = 1;
      var x = i % W, y = (i / W) | 0, near = false;
      for (var dy = -1; dy <= 1 && !near; dy++)
        for (var dx = -1; dx <= 1 && !near; dx++) {
          var nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && floor[ny * W + nx]) near = true;
        }
      if (!near) voidMask[i] = 1;
    }
    return { walls: walls, voidMask: voidMask };
  }

  /* ==================================================================== *
   *                          РАЗМЕЩЕНИЕ ЦЕЛЕЙ                            *
   *                                                                      *
   *  Четыре схемы; выбор случайный с весами. Каждая возвращает массив    *
   *  индексов клеток либо null (не поместилось — генератор попробует     *
   *  другую попытку).                                                    *
   * ==================================================================== */

  /** «Кластер»: компактное пятно BFS-обходом внутри одной комнаты
   *  (классический сокобановский «склад»). */
  function goalsCluster(rand, W, floor, rooms, count) {
    var room = pickOne(rand, rooms);
    var sx = pickInt(rand, room.x, room.x + room.w - 1);
    var sy = pickInt(rand, room.y, room.y + room.h - 1);
    var start = sy * W + sx;
    if (!floor[start]) return null;
    var got = new Set([start]);
    var order = [start], head = 0;
    while (head < order.length && order.length < count) {
      var c = order[head++], x = c % W, y = (c / W) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = x + DX[d], ny = y + DY[d];
        // не выходим за пределы комнаты — пятно остаётся компактным
        if (nx < room.x || ny < room.y || nx >= room.x + room.w || ny >= room.y + room.h) continue;
        var ni = ny * W + nx;
        if (!floor[ni] || got.has(ni)) continue;
        got.add(ni); order.push(ni);
        if (order.length >= count) break;
      }
    }
    return order.length >= count ? order.slice(0, count) : null;
  }

  /** «Две группы»: цели делятся между двумя разными комнатами —
   *  придётся возить ящики на два разных склада. */
  function goalsTwoGroups(rand, W, floor, rooms, count) {
    if (rooms.length < 2) return null;
    var i1 = pickInt(rand, 0, rooms.length - 1), i2 = pickInt(rand, 0, rooms.length - 1);
    if (i1 === i2) i2 = (i2 + 1) % rooms.length;
    var half = Math.ceil(count / 2);
    var a = goalsCluster(rand, W, floor, [rooms[i1]], half);
    var b = goalsCluster(rand, W, floor, [rooms[i2]], count - half);
    if (!a || !b) return null;
    // группы могли пересечься, если комнаты наложены друг на друга
    var all = new Set(a.concat(b));
    return all.size === count ? Array.from(all) : null;
  }

  /** «Линия»: цели в ряд по горизонтали или вертикали внутри комнаты
   *  (полка склада). */
  function goalsLine(rand, W, floor, rooms, count) {
    // ищем комнату, куда линия влезает
    for (var tries = 0; tries < 6; tries++) {
      var room = pickOne(rand, rooms);
      var horiz = rand() < 0.5;
      var len = horiz ? room.w : room.h;
      if (len < count) { horiz = !horiz; len = horiz ? room.w : room.h; }
      if (len < count) continue;
      var off = pickInt(rand, 0, len - count);
      var line = [];
      for (var k = 0; k < count; k++) {
        var x = horiz ? room.x + off + k : room.x + pickInt(rand, 0, 0) + ((room.w / 2) | 0);
        var y = horiz ? room.y + ((room.h / 2) | 0) : room.y + off + k;
        var c = y * W + x;
        if (!floor[c]) { line = null; break; }
        line.push(c);
      }
      if (line) return line;
    }
    return null;
  }

  /** «Разброс»: цели в случайных клетках по всему полю с минимальной
   *  попарной дистанцией — каждая цель живёт своей жизнью. */
  function goalsScatter(rand, W, H, floor, count) {
    var cells = [];
    for (var i = 0; i < W * H; i++) if (floor[i]) cells.push(i);
    var chosen = [];
    for (var tries = 0; tries < 200 && chosen.length < count; tries++) {
      var c = pickOne(rand, cells);
      var cx = c % W, cy = (c / W) | 0, okDist = true;
      for (var j = 0; j < chosen.length; j++) {
        var ox = chosen[j] % W, oy = (chosen[j] / W) | 0;
        // манхэттенская дистанция ≥ 3, чтобы цели не слипались случайно
        if (Math.abs(cx - ox) + Math.abs(cy - oy) < 3) { okDist = false; break; }
      }
      if (okDist) chosen.push(c);
    }
    return chosen.length === count ? chosen : null;
  }

  /** Выбор схемы раскладки целей по весам. */
  function placeGoals(rand, W, H, floor, rooms, count) {
    // кластер / две группы / линия / разброс
    var mode = pickWeighted(rand, [30, 25, 20, 25]);
    switch (mode) {
      case 0: return goalsCluster(rand, W, floor, rooms, count);
      case 1: return goalsTwoGroups(rand, W, floor, rooms, count);
      case 2: return goalsLine(rand, W, floor, rooms, count);
      default: return goalsScatter(rand, W, H, floor, count);
    }
  }

  /* ==================================================================== *
   *                    ОБРАТНЫЙ ХОД (направленный скрэмбл)               *
   * ==================================================================== */

  /** BFS игрока с ящиками-препятствиями: дистанции от from до всех клеток.
   *  -1 = недостижимо. Используется, чтобы проверять, может ли игрок
   *  встать «за ящик» для протяжки. */
  function playerBfs(W, H, walls, boxSet, from) {
    var dist = new Int16Array(W * H).fill(-1);
    var q = [from]; dist[from] = 0; var head = 0;
    while (head < q.length) {
      var c = q[head++], x = c % W, y = (c / W) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var ni = ny * W + nx;
        if (walls[ni] || boxSet.has(ni) || dist[ni] !== -1) continue;
        dist[ni] = dist[c] + 1;
        q.push(ni);
      }
    }
    return dist;
  }

  /**
   * Одна «протяжка» (обратный толчок). Протяжка ящика b в направлении d:
   * игрок стоит в клетке b+d и отступает в b+2d, ящик переезжает в b+d.
   *
   * Перебираем все допустимые пары (ящик, направление), для каждой
   * симулируем протяжку на 1–maxPull клеток и оцениваем ПРИРОСТ dg
   * (push-дистанции ящика до ближайшей цели). Исполняем лучшую протяжку;
   * с вероятностью 25% — случайную допустимую, чтобы позиции не были
   * однотипно «жадными».
   *
   * Возвращает true, если протяжка состоялась.
   */
  function pullSession(rand, W, H, walls, dg, state, maxPull) {
    var boxSet = state.boxSet;
    var dist = playerBfs(W, H, walls, boxSet, state.player);
    var candidates = [];

    for (var bi = 0; bi < state.boxes.length; bi++) {
      var b = state.boxes[bi];
      var bx = b % W, by = (b / W) | 0;
      for (var d = 0; d < 4; d++) {
        // p1 — куда встаёт игрок (и куда приедет ящик), p2 — куда он отступит
        var p1x = bx + DX[d], p1y = by + DY[d];
        var p2x = bx + 2 * DX[d], p2y = by + 2 * DY[d];
        if (p2x < 0 || p2y < 0 || p2x >= W || p2y >= H) continue;
        var p1 = p1y * W + p1x, p2 = p2y * W + p2x;
        if (walls[p1] || boxSet.has(p1) || walls[p2] || boxSet.has(p2)) continue;
        if (dist[p1] === -1) continue; // игроку не дойти за ящик

        // Симуляция протяжки на pulls клеток (без изменения состояния).
        var pulls = pickInt(rand, 1, maxPull);
        var player = p1, box = b, moved = 0;
        for (var k = 0; k < pulls; k++) {
          var nx = player + (player - box); // клетка за спиной игрока
          // защита от «перескока» через край строки при линейной адресации
          var dxr = Math.abs((nx % W) - (player % W)) + Math.abs(((nx / W) | 0) - ((player / W) | 0));
          if (dxr !== 1) break;
          if (nx < 0 || nx >= W * H || walls[nx] || boxSet.has(nx)) break;
          box = player; player = nx; moved++;
        }
        if (!moved) continue;
        candidates.push({
          bi: bi, endBox: box, endPlayer: player,
          // прирост дистанции; мёртвая клетка получает штраф, чтобы туда не тянуло
          gain: (dg[box] >= solver.INF ? -99 : dg[box]) - dg[b]
        });
      }
    }
    if (!candidates.length) return false;

    // Эксплуатация против исследования: 75% — лучший прирост, 25% — случайно.
    var pick;
    if (rand() < 0.25) pick = pickOne(rand, candidates);
    else {
      pick = candidates[0];
      for (var c = 1; c < candidates.length; c++)
        if (candidates[c].gain > pick.gain) pick = candidates[c];
    }
    if (dg[pick.endBox] >= solver.INF) return false; // в мёртвую клетку не тянем

    // Применяем выбранную протяжку к состоянию.
    var old = state.boxes[pick.bi];
    boxSet.delete(old);
    boxSet.add(pick.endBox);
    state.boxes[pick.bi] = pick.endBox;
    state.player = pick.endPlayer;
    return true;
  }

  /**
   * Скрэмбл: тянем ящики, пока Σdg не достигнет targetLB (нижняя граница
   * сложности) или пока протяжки не иссякнут. maxSessions страхует от
   * бесконечного цикла на неудачных планировках.
   */
  function scramble(rand, W, H, walls, dg, goalCells, targetLB, maxSessions, playerStart) {
    var state = {
      boxes: goalCells.slice(),     // старт: ящики стоят на целях
      boxSet: new Set(goalCells),
      player: playerStart
    };
    function sumDg() {
      var s = 0;
      for (var i = 0; i < state.boxes.length; i++) s += dg[state.boxes[i]];
      return s;
    }
    for (var s = 0; s < maxSessions; s++) {
      if (!pullSession(rand, W, H, walls, dg, state, 3)) break;
      if (sumDg() >= targetLB) break;
    }
    return { player: state.player, boxes: state.boxes.slice(), sumDg: sumDg() };
  }

  /* ==================================================================== *
   *                          СБОРКА УРОВНЯ                               *
   * ==================================================================== */

  function generate(n, seed) {
    var rand = rng((seed >>> 0) ^ Math.imul(n, 2654435761));
    var attempt = 0;

    while (true) {
      attempt++;
      // Параметры перевыбираются каждую попытку — если конкретная
      // комбинация (размер × ящики × схема целей) плохо генерируется,
      // следующая попытка возьмёт другую.
      var base = paramsForLevel(n, rand);

      // Аварийное смягчение: после многих неудач снижаем планку сложности
      // (до 6 толчков) и число ящиков — уровень обязан появиться.
      var relax = Math.floor(attempt / 120);
      var minPushes = Math.max(6, base.minPushes - relax * 2);
      var boxCount = Math.max(3, base.boxes - (attempt > 400 ? 1 : 0));

      /* --- шаг 2: планировка --- */
      var layout = buildLayout(rand, base.w, base.h, base.rooms, base.pillarShare);
      if (!layout) continue;
      var masks = buildMasks(base.w, base.h, layout.floor);
      var walls = masks.walls;

      /* --- шаг 3: цели --- */
      var goalCells = placeGoals(rand, base.w, base.h, layout.floor, layout.rooms, boxCount);
      if (!goalCells) continue;
      var goals = new Uint8Array(base.w * base.h);
      goalCells.forEach(function (g) { goals[g] = 1; });

      // dg: минимальные push-дистанции до целей; INF = мёртвая клетка.
      var dg = solver.computeGoalDist(base.w, base.h, walls, goals);
      var dead = new Uint8Array(base.w * base.h);
      for (var di = 0; di < dead.length; di++)
        dead[di] = (!walls[di] && dg[di] >= solver.INF) ? 1 : 0;

      // Свободные клетки для старта игрока (пол, не цель).
      var free = [];
      for (var i = 0; i < base.w * base.h; i++)
        if (layout.floor[i] && !goals[i]) free.push(i);
      if (free.length < boxCount + 6) continue; // слишком тесно — не мучаемся

      /* --- шаги 4-6: скрэмбл → фильтры → решатель ---
       * Планировка дорогая, скрэмбл дешёвый: на одну планировку до 8
       * попыток скрэмбла с разными стартами игрока. */
      for (var trial = 0; trial < 8; trial++) {
        var playerStart = pickOne(rand, free);
        var st = scramble(rand, base.w, base.h, walls, dg, goalCells,
                          minPushes, 60, playerStart);

        // Требования пользователя: ящик НИКОГДА не стартует на цели;
        // ящик не в мёртвой клетке (иначе уровень нерешаем).
        var ok = st.boxes.every(function (b) { return !goals[b] && dg[b] < solver.INF; });
        if (!ok) continue;

        // Пре-фильтры по нижней границе оптимума (Σdg ≤ optimal), см. шапку.
        if (st.sumDg < minPushes || st.sumDg > base.maxPushes) continue;

        var lvl = {
          w: base.w, h: base.h,
          walls: walls, goals: goals, dead: dead, voidMask: masks.voidMask,
          boxes: st.boxes, player: st.player
        };
        var res = solver.solve(lvl, { maxNodes: 40000 });
        if (!res.solvable) continue;                                   // тупик или лимит узлов
        if (res.pushes < minPushes || res.pushes > base.maxPushes) continue; // вне вилки сложности

        lvl.optimalPushes = res.pushes; // точный оптимум толчков (A* допустим)
        lvl.solSteps = res.steps;       // пешие шаги найденного решения
        lvl.levelNum = n;
        return lvl;
      }
    }
  }

  NS.generator = { generate: generate, paramsForLevel: paramsForLevel, MAX_DIM: MAX_DIM };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.generator;
})(typeof window !== 'undefined' ? window : globalThis);
