import {
  GAS_CHARGE,
  GAS_MARKER,
  GAS_VERSION,
  HALT,
  JMPI,
  JMP,
  JNZ,
  JZ,
  OPERAND_WIDTH,
  RET,
  TRAP,
  defaultCosts,
  unsignedLebSize,
} from './opcodes.js';
import type {
  CostTable,
  ExRange,
  MeterResult,
  Program,
} from './types.js';
import { MeterError } from './types.js';
import { decode, emitByte, emitImm32, emitULEB } from './decoder.js';
import { buildCFG, type Block } from './cfg.js';

/**
 * A program is already metered when it carries a GAS_MARKER. Decoding is
 * required (rather than a byte scan) because marker bytes can occur inside
 * wide operands.
 */
export function isMetered(prog: Program): boolean {
  return decode(prog.code).some((op) => op.opcode === GAS_MARKER);
}

function countCharges(code: Uint8Array): number {
  return decode(code).filter((op) => op.opcode === GAS_CHARGE).length;
}

function findTrap(code: Uint8Array): number {
  const ops = decode(code);
  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i].opcode === TRAP) return ops[i].offset;
  }
  throw new MeterError('metered program has no trap vector');
}

export interface MeterOptions {
  /** Override/extend the default per-opcode cost schedule. */
  costs?: CostTable;
}

interface Patch {
  at: number;
  value: number;
}

export function meter(prog: Program, options: MeterOptions = {}): MeterResult {
  if (!(prog.code instanceof Uint8Array) || prog.code.length === 0) {
    throw new MeterError('program code must be a non-empty Uint8Array');
  }

  const costs = defaultCosts();
  if (options.costs) {
    for (const [op, c] of options.costs) {
      if (typeof c !== 'bigint' || c < 0n) {
        throw new MeterError(`invalid cost for opcode ${op}`);
      }
      costs.set(op, c);
    }
  }

  // Idempotency: a previously metered program is returned byte-identical.
  if (isMetered(prog)) {
    const ops = decode(prog.code).filter(
      (op) =>
        op.opcode !== GAS_MARKER &&
        op.opcode !== GAS_CHARGE &&
        op.opcode !== TRAP &&
        op.opcode !== HALT,
    );
    return {
      program: prog,
      blocks: [],
      chargeOffset: new Map(),
      offsetMap: new Map(ops.map((o) => [o.offset, o.offset])),
      trapOffset: findTrap(prog.code),
      chargeCount: countCharges(prog.code),
    };
  }

  const cfg = buildCFG(prog, costs);
  const { ops, blocks } = cfg;

  // Block cost is a single GAS_CHARGE with a variable-length (LEB128) operand,
  // so any bigint cost is one atomic reservation with O(bitlen) encoding.
  const chargeBytes = (b: Block): number => 1 + unsignedLebSize(b.cost);

  // ---- Pass 1: emitted layout, resolves forward and backward refs. ----
  const chargeOffset = new Map<number, number>(); // -1 for zero-cost blocks
  const entryOffset = new Map<number, number>();
  const boundaryOffset = new Map<number, number>();
  const offsetMap = new Map<number, number>();

  let at = 0;
  let marker = false;
  for (const b of blocks) {
    boundaryOffset.set(b.start, at);
    if (!marker) at += 3; // GAS_MARKER + u16 version
    marker = true;

    if (b.cost > 0n) {
      chargeOffset.set(b.start, at);
      entryOffset.set(b.start, at);
      at += chargeBytes(b);
    } else {
      chargeOffset.set(b.start, -1);
    }

    let needBodyEntry = b.cost === 0n;
    for (const op of ops) {
      if (op.offset < b.start || op.offset >= b.end) continue;
      if (needBodyEntry) {
        entryOffset.set(b.start, at);
        needBodyEntry = false;
      }
      offsetMap.set(op.offset, at);
      at += 1 + (OPERAND_WIDTH[op.opcode] ?? 0);
    }
  }
  const haltOffset = at; // synthetic clean HALT
  const trapOffset = at + 1; // unified trap vector
  at += 2;

  // ---- Pass 2: emit bytes with u32 patches for control-flow operands. ----
  const out: number[] = [];
  const patches: Patch[] = [];
  marker = false;
  for (const b of blocks) {
    if (!marker) {
      emitByte(out, GAS_MARKER);
      emitByte(out, GAS_VERSION & 0xff);
      emitByte(out, (GAS_VERSION >>> 8) & 0xff);
      marker = true;
    }
    if (b.cost > 0n) {
      emitByte(out, GAS_CHARGE);
      emitULEB(out, b.cost);
    }
    for (const op of ops) {
      if (op.offset < b.start || op.offset >= b.end) continue;
      emitByte(out, op.opcode);
      const width = OPERAND_WIDTH[op.opcode] ?? 0;
      if (
        op.opcode === JMP ||
        op.opcode === RET ||
        op.opcode === JZ ||
        op.opcode === JNZ
      ) {
        patches.push({
          at: out.length,
          value: entry(Number(op.operand), blocks, entryOffset),
        });
        emitImm32(out, 0);
      } else if (op.opcode === JMPI) {
        // no immediate; indirect table rewritten below
      } else if (width > 0) {
        let v = Number(op.operand) >>> 0;
        for (let i = 0; i < width; i++) {
          emitByte(out, v & 0xff);
          v >>>= 8;
        }
      }
    }
  }
  emitByte(out, HALT);
  emitByte(out, TRAP);
  if (out.length !== at) throw new MeterError('internal: emission length mismatch');

  for (const p of patches) {
    out[p.at] = (p.value >>> 24) & 0xff;
    out[p.at + 1] = (p.value >>> 16) & 0xff;
    out[p.at + 2] = (p.value >>> 8) & 0xff;
    out[p.at + 3] = p.value & 0xff;
  }

  const code = Uint8Array.from(out);

  // Indirect jumps may enter blocks only through their metered prologue.
  const table = prog.table.map((t) => entry(t, blocks, entryOffset));

  // Exception table: start/handler anchor at runtime entries; the exclusive
  // end anchors just before the following block (synthetic HALT at code end).
  const ranges: ExRange[] = prog.ranges.map((r) => {
    const end =
      r.end === prog.code.length
        ? haltOffset
        : boundaryOffset.get(r.end) ??
          (() => {
            throw new MeterError(`range end ${r.end} is not a block boundary`);
          })();
    return {
      start: entry(r.start, blocks, entryOffset),
      end,
      handler: entry(r.handler, blocks, entryOffset),
    };
  });

  // Debug points stay on real instructions, never injected pseudo-ops.
  const debug = prog.debug.map((d) => {
    const to = offsetMap.get(d.offset);
    if (to === undefined) {
      throw new MeterError(`debug point ${d.offset} is not an instruction`);
    }
    return { offset: to, line: d.line };
  });

  return {
    program: { code, table, ranges, debug },
    blocks,
    chargeOffset,
    offsetMap,
    trapOffset,
    chargeCount: blocks.filter((b) => b.cost > 0n).length,
  };
}

function entry(
  target: number,
  blocks: Block[],
  entryOffset: Map<number, number>,
): number {
  if (!blocks.some((b) => b.start === target)) {
    throw new MeterError(
      `target ${target} is not a basic-block entry; control may only enter ` +
        'a block at its metered prologue',
    );
  }
  const e = entryOffset.get(target);
  if (e === undefined) throw new MeterError(`unresolved entry for block ${target}`);
  return e;
}

export { buildCFG };
