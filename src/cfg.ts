import { GAS_OPS, HALT, JMPI, JMP, JNZ, JZ, RET, TERMINATORS, THROW } from './opcodes.js';
import type { CostTable, Op, Program } from './types.js';
import { MeterError } from './types.js';
import { decode } from './decoder.js';

export interface Block {
  /** offset of the first original instruction */
  start: number;
  /** exclusive end */
  end: number;
  /** leaders of successor blocks (normal and exceptional edges) */
  succ: number[];
  pred: number[];
  /** sum of original-instruction costs in the block (bigint) */
  cost: bigint;
  /** targets of back edges leaving this block (loop headers) */
  backEdges: number[];
  /** true when an exceptional edge was added from this block */
  exceptional: boolean;
}

export interface Cfg {
  ops: Op[];
  blocks: Block[];
  byStart: Map<number, Block>;
}

/**
 * Compute basic-block leaders.
 *
 * Leaders: the entry; every direct/indirect jump target; the instruction after
 * any terminator; every THROW and the instruction following it (splitting at a
 * throw makes the exception path pay exactly for executed instructions); and
 * all exception-table points.
 */
export function computeLeaders(ops: Op[], prog: Program): Set<number> {
  const at = new Map<number, Op>();
  for (const op of ops) at.set(op.offset, op);
  const leaders = new Set<number>();
  leaders.add(ops[0].offset);

  const requireBoundary = (o: number, what: string): void => {
    if (o < 0 || o > prog.code.length) {
      throw new MeterError(`${what} ${o} out of range`);
    }
    if (o !== prog.code.length && !at.has(o)) {
      throw new MeterError(`${what} ${o} is not an instruction boundary`);
    }
  };
  const mark = (o: number, what: string): void => {
    requireBoundary(o, what);
    if (o !== prog.code.length) leaders.add(o);
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (GAS_OPS.has(op.opcode)) {
      throw new MeterError(
        `gas pseudo-op ${op.opcode} at ${op.offset} present in source code`,
      );
    }
    if (op.opcode === JMP || op.opcode === RET || op.opcode === JZ || op.opcode === JNZ) {
      mark(Number(op.operand), 'jump target');
    }
    if (TERMINATORS.has(op.opcode) || op.opcode === THROW) {
      const next = ops[i + 1];
      if (next) leaders.add(next.offset);
    }
    if (op.opcode === THROW) leaders.add(op.offset);
  }

  for (const t of prog.table) mark(t, 'indirect target');
  for (const r of prog.ranges) {
    mark(r.start, 'exception range start');
    mark(r.end, 'exception range end');
    mark(r.handler, 'exception handler');
  }

  return leaders;
}

function terminatorSucc(op: Op, fallthrough: number | null): number[] {
  switch (op.opcode) {
    case JMP:
    case RET:
      return [Number(op.operand)];
    case JZ:
    case JNZ: {
      const out = [Number(op.operand)];
      if (fallthrough !== null) out.push(fallthrough);
      return out;
    }
    case JMPI:
    case HALT:
    case THROW:
      return [];
    default:
      return fallthrough !== null ? [fallthrough] : [];
  }
}

export function buildCFG(prog: Program, costs: CostTable): Cfg {
  const ops = decode(prog.code);
  if (ops.length === 0) throw new MeterError('empty program');
  const at = new Map<number, Op>();
  for (const op of ops) at.set(op.offset, op);

  const leaders = [...computeLeaders(ops, prog)].sort((a, b) => a - b);
  const blocks: Block[] = leaders.map((start, i) => ({
    start,
    end: i + 1 < leaders.length ? leaders[i + 1] : prog.code.length,
    succ: [],
    pred: [],
    cost: 0n,
    backEdges: [],
    exceptional: false,
  }));
  const byStart = new Map<number, Block>();
  for (const b of blocks) byStart.set(b.start, b);

  for (const b of blocks) {
    let cost = 0n;
    let last: Op | null = null;
    for (const op of ops) {
      if (op.offset < b.start || op.offset >= b.end) continue;
      const w = costs.get(op.opcode);
      if (w === undefined) throw new MeterError(`no cost for opcode ${op.opcode}`);
      if (w < 0n) throw new MeterError('negative instruction cost');
      cost += w;
      last = op;
    }
    b.cost = cost;

    const fallthrough = byStart.has(b.end) ? b.end : null;
    if (last === null) throw new MeterError(`empty block at ${b.start}`);
    b.succ = terminatorSucc(last, fallthrough);
    if (last.opcode === JMPI) {
      for (const t of prog.table) {
        if (!byStart.has(t)) {
          throw new MeterError(`indirect target ${t} is not a block entry`);
        }
        b.succ.push(t);
      }
    }
    for (const s of b.succ) {
      if (!byStart.has(s)) {
        throw new MeterError(`edge target ${s} is not a block entry`);
      }
    }
  }

  // Conservative exceptional edges: a block overlapping [start,end) may raise.
  for (const b of blocks) {
    for (const r of prog.ranges) {
      if (b.start < r.end && b.end > r.start) {
        b.succ.push(r.handler);
        b.exceptional = true;
      }
    }
  }

  for (const b of blocks) {
    b.succ = [...new Set(b.succ)].sort((a, z) => a - z);
  }
  for (const b of blocks) {
    for (const s of b.succ) byStart.get(s)!.pred.push(b.start);
  }

  // Back edges via tri-color DFS; all components visited, so unreachable loops
  // are classified too.
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<number, number>(blocks.map((b) => [b.start, WHITE]));
  const visit = (s: number): void => {
    color.set(s, GRAY);
    for (const t of byStart.get(s)!.succ) {
      const tc = color.get(t);
      if (tc === GRAY) byStart.get(s)!.backEdges.push(t);
      else if (tc === WHITE) visit(t);
    }
    color.set(s, BLACK);
  };
  for (const b of blocks) {
    if (color.get(b.start) === WHITE) visit(b.start);
  }

  return { ops, blocks, byStart };
}
