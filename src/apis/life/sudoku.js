import { randomInt } from 'node:crypto';
import { HttpError, param } from '../../lib/http.js';

const ALL = 0x1ff;
export const LEVELS = {
  easy: { clues: 42, name: '简单' },
  medium: { clues: 34, name: '中等' },
  hard: { clues: 28, name: '困难' },
  expert: { clues: 24, name: '专家' },
};
const NODE_BUDGET = 2_000_000;
const GEN_TIME_MS = 1500;
const boxOf = (i) => Math.floor(i / 27) * 3 + Math.floor((i % 9) / 3);
const bitCount = (n) => {
  let c = 0;
  for (; n; n &= n - 1) c++;
  return c;
};
function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// 回溯求解（每次选候选数最少的格子）。limit 为最多找几个解（判断唯一解传 2）；random 打乱尝试顺序（用于生成终盘）
export function solve(cells, limit = 2, random = false) {
  const grid = [...cells];
  const rows = new Array(9).fill(0);
  const cols = new Array(9).fill(0);
  const boxes = new Array(9).fill(0);
  for (let i = 0; i < 81; i++) {
    if (!grid[i]) continue;
    const bit = 1 << (grid[i] - 1);
    rows[Math.floor(i / 9)] |= bit;
    cols[i % 9] |= bit;
    boxes[boxOf(i)] |= bit;
  }
  const solutions = [];
  let nodes = 0;
  const search = () => {
    if (++nodes > NODE_BUDGET) throw new HttpError(422, '题目过于复杂，无法在限定的计算量内求解');
    let best = -1;
    let bestMask = 0;
    let bestCount = 10;
    for (let i = 0; i < 81; i++) {
      if (grid[i]) continue;
      const mask = ALL & ~(rows[Math.floor(i / 9)] | cols[i % 9] | boxes[boxOf(i)]);
      const c = bitCount(mask);
      if (c === 0) return false;
      if (c < bestCount) {
        best = i;
        bestMask = mask;
        bestCount = c;
        if (c === 1) break;
      }
    }
    if (best === -1) {
      solutions.push(grid.join(''));
      return solutions.length >= limit;
    }
    const digits = [];
    for (let d = 1; d <= 9; d++) if (bestMask & (1 << (d - 1))) digits.push(d);
    if (random) shuffle(digits);
    const r = Math.floor(best / 9);
    const c = best % 9;
    const b = boxOf(best);
    for (const d of digits) {
      const bit = 1 << (d - 1);
      grid[best] = d;
      rows[r] |= bit;
      cols[c] |= bit;
      boxes[b] |= bit;
      if (search()) return true;
      grid[best] = 0;
      rows[r] &= ~bit;
      cols[c] &= ~bit;
      boxes[b] &= ~bit;
    }
    return false;
  };
  search();
  return solutions;
}

// 解析题目：81 位，空格用 0 或 . 表示；允许夹杂空白、逗号、竖线
export function parsePuzzle(text) {
  const clean = String(text ?? '').replace(/[\s,|]/g, '').replace(/[.*_]/g, '0');
  if (!/^\d{81}$/.test(clean)) throw new HttpError(400, 'puzzle 应为 81 位数字（按行从左到右、从上到下，空格用 0 或 . 表示）');
  const cells = [...clean].map(Number);
  for (let i = 0; i < 81; i++) {
    if (!cells[i]) continue;
    for (let j = i + 1; j < 81; j++) {
      if (cells[j] === cells[i] && (Math.floor(i / 9) === Math.floor(j / 9) || i % 9 === j % 9 || boxOf(i) === boxOf(j))) {
        throw new HttpError(400, `题目有冲突：第 ${Math.floor(i / 9) + 1} 行第 ${(i % 9) + 1} 列与第 ${Math.floor(j / 9) + 1} 行第 ${(j % 9) + 1} 列都是 ${cells[i]}`);
      }
    }
  }
  return cells;
}

// 生成：先随机填满终盘，再随机挖空，每挖一格确认仍是唯一解；挖到目标提示数或超时为止
export function generate(level, timeMs = GEN_TIME_MS) {
  const solution = [...solve(new Array(81).fill(0), 1, true)[0]].map(Number);
  const puzzle = [...solution];
  let clues = 81;
  const deadline = Date.now() + timeMs;
  for (const i of shuffle([...Array(81).keys()])) {
    if (clues <= LEVELS[level].clues || Date.now() > deadline) break;
    const keep = puzzle[i];
    puzzle[i] = 0;
    if (solve(puzzle, 2).length === 1) clues--;
    else puzzle[i] = keep;
  }
  return { puzzle, solution, clues };
}

const rowsOf = (s) => Array.from({ length: 9 }, (_, r) => s.slice(r * 9, r * 9 + 9));

export default {
  name: 'sudoku',
  category: 'life',
  title: '数独',
  description: '生成指定难度且保证唯一解的数独题目（附答案），或求解提交的数独并判断是否唯一解',
  source: '本地计算（回溯求解）',
  routes: [
    {
      method: 'GET',
      path: '/api/sudoku',
      summary: '生成数独（附答案）或求解数独',
      params: [
        { name: 'difficulty', default: 'medium', desc: '生成难度：easy 简单（约 42 个提示数）、medium 中等（34）、hard 困难（28）、expert 专家（24）；传了 puzzle 时忽略', example: 'hard' },
        { name: 'puzzle', desc: '要求解的题目：81 位字符串，按行从左到右、从上到下，空格用 0 或 . 表示；传入即为求解模式', example: '530070000600195000098000060800060003400803001700020006060000280000419005000080079' },
      ],
      fields: [
        { name: 'mode', type: 'string', desc: '模式：generate（生成）或 solve（求解）' },
        { name: 'difficulty', type: 'string|null', desc: 'generate：难度代号 easy/medium/hard/expert；solve 为 null' },
        { name: 'difficultyName', type: 'string|null', desc: 'generate：难度中文名；solve 为 null' },
        { name: 'puzzle', type: 'string', desc: '题目，81 位字符串，0 表示空格' },
        { name: 'puzzleRows', type: 'array', desc: '题目按行拆分的 9 个字符串' },
        { name: 'clues', type: 'number', desc: '题目中已给出的数字个数（提示数）。生成时超时会提前停止挖空，可能比目标略多' },
        { name: 'solvable', type: 'boolean', desc: '是否有解（generate 恒为 true）' },
        { name: 'unique', type: 'boolean|null', desc: '是否只有唯一解（generate 恒为 true）；无解时为 null' },
        { name: 'solution', type: 'string|null', desc: '答案，81 位字符串；无解时为 null。有多解时给出其中一个' },
        { name: 'solutionRows', type: 'array|null', desc: '答案按行拆分的 9 个字符串；无解时为 null' },
      ],
      async handler({ query }) {
        const puzzleRaw = param(query, 'puzzle', { max: 200 });
        if (puzzleRaw != null) {
          const cells = parsePuzzle(puzzleRaw);
          const sols = solve(cells, 2);
          const puzzle = cells.join('');
          return {
            data: {
              mode: 'solve', difficulty: null, difficultyName: null, puzzle, puzzleRows: rowsOf(puzzle),
              clues: cells.filter(Boolean).length, solvable: sols.length > 0, unique: sols.length ? sols.length === 1 : null,
              solution: sols[0] ?? null, solutionRows: sols[0] ? rowsOf(sols[0]) : null,
            },
          };
        }
        const difficulty = param(query, 'difficulty', { default: 'medium', oneOf: Object.keys(LEVELS) });
        const g = generate(difficulty);
        const puzzle = g.puzzle.join('');
        const solution = g.solution.join('');
        return {
          data: {
            mode: 'generate', difficulty, difficultyName: LEVELS[difficulty].name, puzzle, puzzleRows: rowsOf(puzzle),
            clues: g.clues, solvable: true, unique: true, solution, solutionRows: rowsOf(solution),
          },
        };
      },
    },
  ],
};
