import {
  ADD,
  DUP,
  EQ,
  EVENT,
  HALT,
  JMPI,
  JMP,
  JNZ,
  JZ,
  LT,
  MUL,
  NOP,
  PICK,
  POP,
  PUSH,
  RET,
  SUB,
  THROW,
} from '../src/opcodes.js';
import type { DebugEntry, ExRange, Program } from '../src/types.js';

/** Simple line-based assembler for tests. */

const OPCODES: Record<string, number> = {
  nop: NOP,
  push: PUSH,
  pop: POP,
  add: ADD,
  sub: SUB,
  mul: MUL,
  eq: EQ,
  lt: LT,
  jmp: JMP,
  jz: JZ,
  jnz: JNZ,
  jmpi: JMPI,
  event: EVENT,
  halt: HALT,
  throw: THROW,
  ret: RET,
  dup: DUP,
  pick: PICK,
};

const IMM8 = new Set(['push', 'event', 'throw', 'pick']);
const IMM_LABEL = new Set(['jmp', 'jz', 'jnz', 'ret']);
const WIDE: Record<string, number> = { jmp: 4, jz: 4, jnz: 4, ret: 4 };

export interface AsmResult {
  program: Program;
  labels: Record<string, number>;
}

export interface AsmOptions {
  table?: string[];
  ranges?: { from: string; to: string; handler: string }[];
  /** label -> source line */
  debug?: Record<string, number>;
}

interface Parsed {
  label: string | null;
  mnemonic: string | null;
  arg: string | null;
  index: number;
}

function parse(lines: string[]): Parsed[] {
  return lines.map((raw, index) => {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) return { label: null, mnemonic: null, arg: null, index };
    const labelMatch = /^([A-Za-z_][A-Za-z0-9_]*):$/.exec(line);
    if (labelMatch) {
      return { label: labelMatch[1], mnemonic: null, arg: null, index };
    }
    const m = /^([a-z]+)(?:\s+([^\s]+))?$/.exec(line);
    if (!m) throw new Error(`cannot assemble line ${index}: ${raw}`);
    return { label: null, mnemonic: m[1], arg: m[2] ?? null, index };
  });
}

export function asm(
  source: string | string[],
  options: AsmOptions = {},
): AsmResult {
  const lines = Array.isArray(source) ? source : source.split('\n');
  const parsed = parse(lines);

  // Pass 1: offsets and label positions.
  const labels: Record<string, number> = {};
  let at = 0;
  for (const p of parsed) {
    if (p.label) {
      if (labels[p.label] !== undefined) throw new Error(`dup label ${p.label}`);
      labels[p.label] = at;
      continue;
    }
    if (!p.mnemonic) continue;
    at += 1 + (WIDE[p.mnemonic] ?? (IMM8.has(p.mnemonic) ? 1 : 0));
  }
  const length = at;

  // Pass 2: encode.
  const code = new Uint8Array(length);
  at = 0;
  for (const p of parsed) {
    if (p.label || !p.mnemonic) continue;
    const op = OPCODES[p.mnemonic];
    if (op === undefined) throw new Error(`unknown mnemonic ${p.mnemonic}`);
    code[at++] = op;
    if (IMM8.has(p.mnemonic)) {
      const v = Number(p.arg);
      if (!Number.isInteger(v) || v < 0 || v > 255) {
        throw new Error(`bad imm8 ${p.arg}`);
      }
      code[at++] = v;
    } else if (IMM_LABEL.has(p.mnemonic)) {
      const target = labels[p.arg!];
      if (target === undefined) throw new Error(`unknown label ${p.arg}`);
      code[at++] = (target >>> 24) & 0xff;
      code[at++] = (target >>> 16) & 0xff;
      code[at++] = (target >>> 8) & 0xff;
      code[at++] = target & 0xff;
    } else if (p.arg !== null) {
      throw new Error(`unexpected operand for ${p.mnemonic}`);
    }
  }

  const table = (options.table ?? []).map((name) => {
    if (labels[name] === undefined) throw new Error(`unknown table label ${name}`);
    return labels[name];
  });
  const ranges: ExRange[] = (options.ranges ?? []).map((r) => ({
    start: labels[r.from],
    end: r.to === '$' ? length : labels[r.to],
    handler: labels[r.handler],
  }));
  const debug: DebugEntry[] = Object.entries(options.debug ?? {}).map(
    ([label, line]) => {
      if (labels[label] === undefined) throw new Error(`unknown debug label ${label}`);
      return { offset: labels[label], line };
    },
  );

  return { program: { code, table, ranges, debug }, labels };
}
