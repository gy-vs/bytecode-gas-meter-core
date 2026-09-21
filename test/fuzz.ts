/**
 * Property test (run manually): random straight-line/branch/loop programs must
 * produce identical observable results before and after metering when gas is
 * ample, and gas spend must equal the exact original instruction costs.
 */
import {
  ADD,
  DUP,
  EQ,
  EVENT,
  HALT,
  JMP,
  JNZ,
  JZ,
  LT,
  MUL,
  NOP,
  POP,
  PUSH,
  SUB,
  decode,
  defaultCosts,
  meter,
  run,
} from '../src/index.js';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function generate(seed: number) {
  const r = rng(seed);
  const lines: string[] = [];
  const labels = ['l0', 'l1', 'l2', 'l3'];
  lines.push('l0:');
  lines.push('push 3');
  for (let i = 1; i < labels.length; i++) {
    lines.push(`${labels[i]}:`);
    const choice = Math.floor(r() * 6);
    if (choice === 0) lines.push('push ' + Math.floor(r() * 5));
    else if (choice === 1) lines.push('add');
    else if (choice === 2) lines.push('sub');
    else if (choice === 3) lines.push('event ' + i);
    else if (choice === 4 && i > 1) lines.push('jmp ' + labels[Math.floor(r() * i)]);
    else lines.push('dup');
  }
  lines.push('pop');
  lines.push('jz l2');
  lines.push('event 9');
  lines.push('jmp l1');
  lines.push('end:');
  lines.push('halt');
  return lines;
}

// Assemble directly to keep this fuzzer self-contained.
const IMM8 = new Set([PUSH, EVENT]);
const JUMPS = new Set([JMP, JZ, JNZ]);

function assemble(lines: string[]) {
  const labels: Record<string, number> = {};
  const parsed: { label?: string; op?: number; arg?: string }[] = [];
  let at = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.endsWith(':')) {
      labels[line.slice(0, -1)] = at;
      continue;
    }
    const [m, arg] = line.split(' ');
    const op = mnemonic(m);
    parsed.push({ op, arg });
    at += 1 + (JUMPS.has(op) ? 4 : IMM8.has(op) ? 1 : 0);
  }
  const code = new Uint8Array(at);
  let p = 0;
  for (const ins of parsed) {
    code[p++] = ins.op!;
    if (JUMPS.has(ins.op!)) {
      const t = labels[ins.arg!];
      code[p++] = (t >>> 24) & 0xff;
      code[p++] = (t >>> 16) & 0xff;
      code[p++] = (t >>> 8) & 0xff;
      code[p++] = t & 0xff;
    } else if (IMM8.has(ins.op!)) {
      code[p++] = Number(ins.arg);
    }
  }
  return code;
}

function mnemonic(m: string): number {
  return (
    {
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
      nop: NOP,
      dup: DUP,
      event: EVENT,
      halt: HALT,
    } as Record<string, number>
  )[m]!;
}

let failures = 0;
for (let seed = 1; seed <= 500; seed++) {
  const code = assemble(generate(seed));
  const original = { code, table: [], ranges: [], debug: [] };
  const args = [seed % 4];
  const path: number[] = [];
  const gold = run(original, { args, gas: 0n, maxSteps: 1000, step: (pc) => path.push(pc) });
  if (gold.status === 'invalid') continue;
  const costs = defaultCosts();
  const byOff = new Map(decode(code).map((o) => [o.offset, o]));
  const exactCost = path.reduce(
    (a, pc) => a + (costs.get(byOff.get(pc)!.opcode) ?? 0n),
    0n,
  );

  const m = meter(original);
  const paid = run(m.program, {
    args,
    gas: 10n ** 9n,
    trapOffset: m.trapOffset,
    maxSteps: 1000,
  });

  if (
    paid.status !== gold.status ||
    JSON.stringify(paid.events) !== JSON.stringify(gold.events) ||
    (gold.status === 'halt' && JSON.stringify(paid.stack) !== JSON.stringify(gold.stack))
  ) {
    console.log('MISMATCH seed', seed, gold.status, paid.status, gold.events, paid.events);
    failures++;
  }

  // Exact-budget run spends precisely the path cost and succeeds identically.
  const exact = run(m.program, {
    args,
    gas: exactCost,
    trapOffset: m.trapOffset,
    maxSteps: 1000,
  });
  if (exact.status !== gold.status || exact.gasSpent !== exactCost) {
    console.log('COST seed', seed, exact.status, exact.gasSpent.toString(), exactCost.toString());
    failures++;
  }

  // One unit short always traps at the unified vector, never inside a body.
  if (exactCost > 0n) {
    const tight = run(m.program, {
      args,
      gas: exactCost - 1n,
      trapOffset: m.trapOffset,
      maxSteps: 1000,
    });
    if (tight.status !== 'gas' || tight.pc !== m.trapOffset) {
      console.log('TRAP seed', seed, tight.status, tight.pc, m.trapOffset);
      failures++;
    }
  }
}
if (failures > 0) {
  console.error(failures, 'mismatches');
  process.exit(1);
}
console.log('fuzz: 500 programs equivalent, exact-cost and boundary-trap verified');
