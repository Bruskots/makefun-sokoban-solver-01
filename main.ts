// Sokoban solver: push-based A* per independent room.
//
// The generator lays one hallway across the board with rooms opening off it
// through a single door each, and a box pushed into the hallway can never
// come back, so every box stays inside its own room. That makes each room an
// independent subproblem with 3 or 4 boxes, which a push-based A* solves
// optimally: the heuristic is the cheapest assignment of boxes to goals
// (shortest-path distances on the room floor), which never overestimates the
// pushes still needed, so the first solution A* returns is push-optimal.
// Dead squares (cells a box can never be pulled back from to reach a goal)
// and 2x2 blocks prune hopeless states. Rooms are stitched together with
// plain walks through the hallway. Everything is deterministic: fixed
// neighbour order, fixed tie-breaking, and work budgets counted in expanded
// nodes, never wall-clock time.

import * as fs from "node:fs";
import * as path from "node:path";

const DIRS = [
  { dx: 0, dy: -1, ch: "u" },
  { dx: 0, dy: 1, ch: "d" },
  { dx: -1, dy: 0, ch: "l" },
  { dx: 1, dy: 0, ch: "r" },
];

// Work budget per room, counted in expanded nodes. A room holds at most four
// boxes on a small floor, so ordinary rooms settle far below this; the cap
// only bounds pathological ones deterministically.
const NODE_BUDGET = 300_000;

type Grid = {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
};

function parseLevel(text: string): Grid {
  const rows = text.split("\n").filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const i = y * w + x;
      const ch = row[x];
      if (ch === "#") continue;
      wall[i] = 0;
      if (ch === "." || ch === "*" || ch === "+") goal[i] = 1;
      if (ch === "$" || ch === "*") boxes.push(i);
      if (ch === "@" || ch === "+") player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

// Breadth-first walk from `start` over floor cells, never stepping on a box
// cell. Returns the move string to `target`, or null when unreachable.
// Neighbours are tried in the fixed order u, d, l, r, so the result is
// deterministic.
function walkPath(
  grid: Grid,
  start: number,
  target: number,
  boxSet: Set<number>,
  allowed?: Uint8Array,
): string | null {
  if (start === target) return "";
  const prev = new Int32Array(grid.w * grid.h).fill(-2);
  const prevCh = new Array<string>(grid.w * grid.h).fill("");
  const queue: number[] = [start];
  prev[start] = -1;
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cx = cur % grid.w;
    const cy = (cur / grid.w) | 0;
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) continue;
      const ni = ny * grid.w + nx;
      if (prev[ni] !== -2) continue;
      if (grid.wall[ni]) continue;
      if (boxSet.has(ni)) continue;
      if (allowed && !allowed[ni]) continue;
      prev[ni] = cur;
      prevCh[ni] = d.ch;
      if (ni === target) {
        let out = "";
        let c = ni;
        while (c !== start) {
          out = prevCh[c] + out;
          c = prev[c];
        }
        return out;
      }
      queue.push(ni);
    }
  }
  return null;
}

// All cells the player can reach on foot from `start`, over floor cells that
// are not boxes. Returns a set of reachable cells.
function reachableCells(
  grid: Grid,
  start: number,
  boxSet: Set<number>,
  allowed?: Uint8Array,
): Set<number> {
  const seen = new Set<number>([start]);
  const queue: number[] = [start];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cx = cur % grid.w;
    const cy = (cur / grid.w) | 0;
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) continue;
      const ni = ny * grid.w + nx;
      if (seen.has(ni)) continue;
      if (grid.wall[ni]) continue;
      if (boxSet.has(ni)) continue;
      if (allowed && !allowed[ni]) continue;
      seen.add(ni);
      queue.push(ni);
    }
  }
  return seen;
}

// Shortest-path distances from one source over floor cells (boxes ignored).
function bfsDistances(grid: Grid, src: number, allowed?: Uint8Array): Int32Array {
  const dist = new Int32Array(grid.w * grid.h).fill(-1);
  dist[src] = 0;
  const queue: number[] = [src];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cx = cur % grid.w;
    const cy = (cur / grid.w) | 0;
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) continue;
      const ni = ny * grid.w + nx;
      if (dist[ni] !== -1) continue;
      if (grid.wall[ni]) continue;
      if (allowed && !allowed[ni]) continue;
      dist[ni] = dist[cur] + 1;
      queue.push(ni);
    }
  }
  return dist;
}

// All orderings of 0..n-1, used to try every box-to-goal assignment.
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

type Room = {
  cells: number[]; // floor cells of the room
  allowed: Uint8Array; // room floor cells plus the entry cell (player movement)
  roomCells: Uint8Array; // room floor cells only (where a box may sit)
  boxes: number[]; // starting boxes, sorted
  goals: number[]; // goals in the room
  door: number; // room cell next to the hallway (may hold a box at the start)
  entry: number; // hallway cell next to the door: the player's entry point
};

// Split the level into rooms: connected floor components outside the
// hallway row (the row the player starts on). Each component's door is the
// cell touching the hallway.
function findRooms(grid: Grid): Room[] {
  const hallRow = (grid.player / grid.w) | 0;
  const seen = new Uint8Array(grid.w * grid.h);
  const rooms: Room[] = [];
  for (let i = 0; i < grid.w * grid.h; i++) {
    if (grid.wall[i]) continue;
    if (((i / grid.w) | 0) === hallRow) continue;
    if (seen[i]) continue;
    const cells: number[] = [];
    const queue: number[] = [i];
    seen[i] = 1;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      cells.push(cur);
      const cx = cur % grid.w;
      const cy = (cur / grid.w) | 0;
      for (const d of DIRS) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) continue;
        const ni = ny * grid.w + nx;
        if (seen[ni]) continue;
        if (grid.wall[ni]) continue;
        if (((ni / grid.w) | 0) === hallRow) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
    const allowed = new Uint8Array(grid.w * grid.h);
    for (const c of cells) allowed[c] = 1;
    const boxes = grid.boxes.filter((b) => allowed[b]);
    const goals = cells.filter((c) => grid.goal[c]);
    // The door is the room cell touching the hallway. It may hold a box at
    // the start: the player then pushes that box inward from the hallway
    // before stepping in, so the door itself is not the entry point.
    let door = -1;
    let entry = -1;
    for (const c of cells) {
      const cx = c % grid.w;
      const cy = (c / grid.w) | 0;
      for (const d of DIRS) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) continue;
        const ni = ny * grid.w + nx;
        if (((ni / grid.w) | 0) === hallRow && !grid.wall[ni]) {
          door = c;
          entry = ni;
          break;
        }
      }
      if (door !== -1) break;
    }
    if (boxes.length > 0 && door !== -1) {
      const roomCells = new Uint8Array(grid.w * grid.h);
      for (const c of cells) roomCells[c] = 1;
      allowed[entry] = 1; // the player may stand on the entry cell
      rooms.push({ cells, allowed, roomCells, boxes, goals, door, entry });
    }
  }
  rooms.sort((a, b) => a.door - b.door);
  return rooms;
}

// Cells from which a box can still be pushed onto a goal, found by pulling
// boxes backwards out of the goals. A box on any other cell is dead: it can
// never reach a goal again, so states holding one are pruned.
function liveCells(grid: Grid, room: Room): Uint8Array {
  const live = new Uint8Array(grid.w * grid.h);
  const queue: number[] = [];
  for (const g of room.goals) {
    live[g] = 1;
    queue.push(g);
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cx = cur % grid.w;
    const cy = (cur / grid.w) | 0;
    for (const d of DIRS) {
      // Box pulled from prev = cur - d to cur; the player must have stood
      // at cur - 2d to pull it, so both cells must be room floor.
      const px = cx - d.dx;
      const py = cy - d.dy;
      const sx = cx - 2 * d.dx;
      const sy = cy - 2 * d.dy;
      if (px < 0 || py < 0 || px >= grid.w || py >= grid.h) continue;
      if (sx < 0 || sy < 0 || sx >= grid.w || sy >= grid.h) continue;
      const prev = py * grid.w + px;
      const stand = sy * grid.w + sx;
      if (!room.roomCells[prev] || !room.allowed[stand]) continue;
      if (live[prev]) continue;
      live[prev] = 1;
      queue.push(prev);
    }
  }
  return live;
}

// True when the 2x2 block with `cell` as one corner is a dead block: every
// square is a wall or a box, at least one is a box, and none is a goal.
function formsDeadBlock(
  grid: Grid,
  boxes: Set<number>,
  cell: number,
): boolean {
  const cx = cell % grid.w;
  const cy = (cell / grid.w) | 0;
  for (let ox = -1; ox <= 0; ox++) {
    for (let oy = -1; oy <= 0; oy++) {
      const x0 = cx + ox;
      const y0 = cy + oy;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= grid.w || y0 + 1 >= grid.h) continue;
      let boxCount = 0;
      let filled = true;
      let hasGoal = false;
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const ci = (y0 + dy) * grid.w + (x0 + dx);
          if (grid.goal[ci]) hasGoal = true;
          if (boxes.has(ci)) boxCount++;
          else if (!grid.wall[ci]) filled = false;
        }
      }
      if (filled && boxCount > 0 && !hasGoal) return true;
    }
  }
  return false;
}

// Minimal binary heap ordered by (f, h, insertion order).
class Heap {
  private items: number[] = [];
  private f: number[];
  private h: number[];
  private seq: number[];

  constructor(f: number[], h: number[], seq: number[]) {
    this.f = f;
    this.h = h;
    this.seq = seq;
  }

  get size(): number {
    return this.items.length;
  }

  private less(a: number, b: number): boolean {
    if (this.f[a] !== this.f[b]) return this.f[a] < this.f[b];
    if (this.h[a] !== this.h[b]) return this.h[a] < this.h[b];
    return this.seq[a] < this.seq[b];
  }

  push(idx: number): void {
    const items = this.items;
    items.push(idx);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(items[i], items[p])) break;
      [items[i], items[p]] = [items[p], items[i]];
      i = p;
    }
  }

  pop(): number {
    const items = this.items;
    const top = items[0];
    const last = items.pop() as number;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.less(items[l], items[m])) m = l;
        if (r < items.length && this.less(items[r], items[m])) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }
    return top;
  }
}

type RoomResult = { moves: string; endPlayer: number } | null;

// Push-based A* for one room. The player starts on the hallway cell next
// to the room's door (the entry), and may push a box that starts on the
// door inward before stepping in.
// `weight` scales the heuristic: 1 is exact A* (push-optimal); larger
// weights trade optimality for speed when the node budget runs out.
function solveRoom(
  grid: Grid,
  room: Room,
  weight: number,
): RoomResult {
  const n = room.boxes.length;
  if (n === 0) return { moves: "", endPlayer: room.entry };
  if (room.goals.length !== n) return null;
  const live = liveCells(grid, room);
  for (const b of room.boxes) if (!live[b]) return null;

  const distFromGoal = room.goals.map((g) => bfsDistances(grid, g, room.roomCells));
  const perms = permutations(n);
  const hCache = new Map<string, number>();
  const heuristic = (boxes: number[]): number => {
    const key = boxes.join(",");
    const hit = hCache.get(key);
    if (hit !== undefined) return hit;
    let best = Number.POSITIVE_INFINITY;
    for (const p of perms) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = distFromGoal[p[i]][boxes[i]];
        if (d < 0) {
          sum = Number.POSITIVE_INFINITY;
          break;
        }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    hCache.set(key, best);
    return best;
  };

  const startBoxes = [...room.boxes];
  const startH = heuristic(startBoxes);
  if (startH === Number.POSITIVE_INFINITY) return null;
  if (startH === 0) return { moves: "", endPlayer: room.entry };

  const nodeBoxes: number[][] = [startBoxes];
  const nodePlayer: number[] = [room.entry];
  const nodeG: number[] = [0];
  const nodeH: number[] = [startH];
  const nodeF: number[] = [startH * weight];
  const nodeSeq: number[] = [0];
  const nodeParent: number[] = [-1];
  const nodeMoves: string[] = [""];
  const bestG = new Map<string, number>();
  bestG.set(startBoxes.join(",") + "|" + room.entry, 0);

  const heap = new Heap(nodeF, nodeH, nodeSeq);
  heap.push(0);
  let seq = 1;
  let expanded = 0;

  while (heap.size > 0) {
    const idx = heap.pop();
    const boxes = nodeBoxes[idx];
    const player = nodePlayer[idx];
    const g = nodeG[idx];
    const key = boxes.join(",") + "|" + player;
    if ((bestG.get(key) ?? Number.POSITIVE_INFINITY) < g) continue;
    if (nodeH[idx] === 0) {
      // Rebuild the full move string from the parent chain.
      let out = "";
      const chain: string[] = [];
      let c = idx;
      while (c > 0) {
        chain.push(nodeMoves[c]);
        c = nodeParent[c];
      }
      chain.reverse();
      for (const s of chain) out += s;
      return { moves: out, endPlayer: player };
    }
    if (++expanded > NODE_BUDGET) return null;
    const boxSet = new Set<number>(boxes);
    const reach = reachableCells(grid, player, boxSet, room.allowed);
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi];
      const bx = b % grid.w;
      const by = (b / grid.w) | 0;
      for (const d of DIRS) {
        const destX = bx + d.dx;
        const destY = by + d.dy;
        const fromX = bx - d.dx;
        const fromY = by - d.dy;
        if (destX < 0 || destY < 0 || destX >= grid.w || destY >= grid.h) continue;
        if (fromX < 0 || fromY < 0 || fromX >= grid.w || fromY >= grid.h) continue;
        const dest = destY * grid.w + destX;
        const from = fromY * grid.w + fromX;
        // A box may only ever sit on a room cell: pushing one out through
        // the door into the hallway loses it for good. The player, though,
        // may stand on the entry cell to push a box inward.
        if (!room.roomCells[dest] || !room.allowed[from]) continue;
        if (boxSet.has(dest)) continue;
        if (!live[dest]) continue;
        if (!reach.has(from)) continue;
        const nextBoxes = [...boxes];
        nextBoxes[bi] = dest;
        nextBoxes.sort((a, b2) => a - b2);
        const nextSet = new Set<number>(nextBoxes);
        if (formsDeadBlock(grid, nextSet, dest)) continue;
        const h = heuristic(nextBoxes);
        if (h === Number.POSITIVE_INFINITY) continue;
        const ng = g + 1;
        const nkey = nextBoxes.join(",") + "|" + b;
        if ((bestG.get(nkey) ?? Number.POSITIVE_INFINITY) <= ng) continue;
        bestG.set(nkey, ng);
        const walk = walkPath(grid, player, from, boxSet, room.allowed);
        if (walk === null) continue; // cannot happen: from is reachable
        const ni = nodeBoxes.length;
        nodeBoxes.push(nextBoxes);
        nodePlayer.push(b);
        nodeG.push(ng);
        nodeH.push(h);
        nodeF.push(ng + weight * h);
        nodeSeq.push(seq++);
        nodeParent.push(idx);
        nodeMoves.push(walk + d.ch);
        heap.push(ni);
      }
    }
  }
  return null;
}

// Solve one level: solve its rooms one after another, walking between doors.
function solveLevel(grid: Grid): string {
  const rooms = findRooms(grid);
  const assigned = new Set<number>();
  for (const r of rooms) for (const b of r.boxes) assigned.add(b);
  const allAssigned =
    grid.boxes.every((b) => assigned.has(b)) && rooms.length > 0;

  let moves = "";
  let player = grid.player;
  const boxSet = new Set<number>(grid.boxes);

  if (allAssigned) {
    for (const room of rooms) {
      const walk = walkPath(grid, player, room.entry, boxSet);
      if (walk === null) return "";
      moves += walk;
      player = room.entry;
      let solved: RoomResult = solveRoom(grid, room, 1);
      if (solved === null) solved = solveRoom(grid, room, 4);
      if (solved === null) solved = solveRoom(grid, room, 40);
      if (solved === null) return "";
      moves += solved.moves;
      player = solved.endPlayer;
      for (const b of room.boxes) boxSet.delete(b);
      // Re-add the room's boxes at their solved spots (on goals): replay the
      // room moves to know exactly where they ended up.
      let p = room.entry;
      const live = new Set<number>(room.boxes);
      for (const ch of solved.moves) {
        const d = DIRS.find((dd) => dd.ch === ch) as (typeof DIRS)[number];
        const next = p + d.dy * grid.w + d.dx;
        if (live.has(next)) {
          live.delete(next);
          live.add(next + d.dy * grid.w + d.dx);
        }
        p = next;
      }
      for (const b of live) boxSet.add(b);
    }
    return moves;
  }

  // Fallback: the level does not split into rooms (unexpected for this
  // generator). Treat the whole board as one room from the start.
  const whole: Room = {
    cells: [],
    allowed: new Uint8Array(grid.w * grid.h).fill(1),
    roomCells: new Uint8Array(grid.w * grid.h).fill(1),
    boxes: [...grid.boxes],
    goals: [],
    door: grid.player,
    entry: grid.player,
  };
  for (let i = 0; i < grid.w * grid.h; i++) {
    if (!grid.wall[i]) {
      whole.cells.push(i);
      if (grid.goal[i]) whole.goals.push(i);
    }
  }
  const solved = solveRoom(grid, whole, 1) ?? solveRoom(grid, whole, 4);
  return solved === null ? "" : solved.moves;
}

function main(): void {
  // The grader mounts the instance set at /input and /output; the local
  // process driver instead hands the paths over as environment variables.
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const ids = fs
    .readdirSync(inputDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const id of ids) {
    const levelPath = path.join(inputDir, id, "level.txt");
    const text = fs.readFileSync(levelPath, "utf8");
    const grid = parseLevel(text);
    const solution = solveLevel(grid);
    const outDir = path.join(outputDir, id);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "solution.txt"), solution, "utf8");
  }
}

main();
