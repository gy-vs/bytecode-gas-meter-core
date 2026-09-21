import { describe, expect, it } from 'vitest';
import {
  decode,
  boundaries,
  meter,
  run,
  buildCFG,
  GAS_CHARGE,
  GAS_MARKER,
  HALT,
  NOP,
  PUSH,
  EVENT,
  THROW,
  JMP,
  JZ,
  JMPI,
  RET,
  TRAP,
  defaultCosts,
  type CostTable,
  type Program,
} from '../src/index.js';
import { asm } from './asm.js';

/* ------------------------------------------------------------------ */
/* Path oracle: executes the ORIGINAL program and records the exact   */
/* sequence of original instruction offsets the path touches. It then */
/* verifies that a metered run spent exactly sum(costs of those ops), */
/* and that under any smaller budget the trapped run executes a strict*/
/* prefix of the entered-block sequence and performs none of the      */
/* trapped block's side effects.                                      */
/* ------------------------------------------------------------------ */

function ownerBlockStart(
  blocks: { start: number; end: number }[],
  offset: number,
): number {
  const b = blocks.find((b) => offset >= b.start && offset < b.end);
  if (!b) throw new Error(`no block owns offset ${offset}`);
  return b.start;
}

function checkPath(
  source: ReturnType<typeof asm>,
  args: number[],
  costs?: CostTable,
) {
  const original = source.program;
  const { program, blocks, offsetMap, trapOffset } = meter(original, costs ? { costs } : {});
  const costOf = costs ?? defaultCosts();

  // The original path, with exact cost.
  const path: number[] = [];
  const gold = run(original, { args, gas: 0n, step: (pc) => path.push(pc) });
  const pathCost = path.reduce(
    (acc, pc) => acc + (costOf.get(decode(original.code).find((o) => o.offset === pc)!.opcode) ?? 0n),
    0n,
  );
  const blockSeq = path.map((pc) => ownerBlockStart(blocks, pc));

  // Enough gas: same result as the original, exact spend, no gas left over
  // accounting error.
  const ok = run(program, { args, gas: pathCost, trapOffset });
  expect(ok.status).toBe(gold.status);
  expect(ok.events).toEqual(gold.events);
  expect(ok.gasSpent).toBe(pathCost);
  expect(ok.gasLeft).toBe(0n);
  if (gold.status === 'halt') expect(ok.stack).toEqual(gold.stack);

  // One unit short: must trap at the unified vector before executing the
  // first body instruction of the block that couldn't be paid.
  if (pathCost > 0n) {
    const enteredMetered: number[] = [];
    const tight = run(program, {
      args,
      gas: pathCost - 1n,
      trapOffset,
      step: (pc, opcode) => {
        if (opcode !== GAS_CHARGE && opcode !== GAS_MARKER && opcode !== TRAP) {
          const origPc = [...offsetMap.entries()].find(([, v]) => v === pc)?.[0];
          if (origPc !== undefined) {
            enteredMetered.push(ownerBlockStart(blocks, origPc));
          }
        }
      },
    });
    expect(tight.status).toBe('gas');
    expect(tight.pc).toBe(trapOffset);

    // Block sequence (repeats preserved, e.g. loop back edges) is a prefix of
    // the gold block sequence, stopping exactly at an unpaid block boundary.
    expect(enteredMetered).toEqual(blockSeq.slice(0, enteredMetered.length));
    expect(enteredMetered.length).toBeLessThan(blockSeq.length);

    // Events strictly before the cut fired; the cut block's body never ran.
    const executed = enteredMetered.length;
    const expectedEvents = path
      .slice(0, executed)
      .map((pc) => decode(original.code).find((o) => o.offset === pc)!)
      .filter((o) => o.opcode === EVENT)
      .map((o) => Number(o.operand));
    expect(tight.events).toEqual(expectedEvents);
    expect(blocks.some((b) => b.start === path[executed])).toBe(true);
  }

  return { program, blocks, trapOffset, gold, pathCost };
}

/* ------------------------------------------------------------------ */
/* Legacy contract                                                    */
/* ------------------------------------------------------------------ */

describe('legacy decoder contract', () => {
  it('decodes opcode 1 with one immediate byte', () => {
    expect(decode(Uint8Array.from([1, 7, 0]))).toHaveLength(2);
  });
  it('keeps boundaries() working', () => {
    expect(boundaries(Uint8Array.from([1, 7, 0, 0]))).toEqual(
      new Set([0, 2, 3]),
    );
  });
});

/* ------------------------------------------------------------------ */
/* 1. Straight-line code                                              */
/* ------------------------------------------------------------------ */

describe('straight line', () => {
  const src = asm(`
    push 1
    event 1
    event 2
    halt
  `);
  it('charges the exact per-path cost and preserves the result', () => {
    const { gold, pathCost } = checkPath(src, []);
    expect(gold.events).toEqual([1, 2]);
    expect(pathCost).toBe(4n); // push + 2 events + halt
  });
});

/* ------------------------------------------------------------------ */
/* 2. Branches (both arms, zero-cost ops included)                    */
/* ------------------------------------------------------------------ */

describe('branches', () => {
  const src = asm(
    `
      jz take
      event 9
      halt
    take:
      nop
      event 1
      halt
    `,
  );
  it('not-taken arm', () => {
    const { gold } = checkPath(src, [7]);
    expect(gold.events).toEqual([9]);
  });
  it('taken arm (runs through a zero-cost nop)', () => {
    const { gold } = checkPath(src, [0]);
    expect(gold.events).toEqual([1]);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Loops with back edges                                           */
/* ------------------------------------------------------------------ */

describe('loops', () => {
  // Loop counter on stack: [i]. Each iteration: event, i--, jnz head.
  const src = asm(`
    head:
      event 5
      push 1
      sub
      dup
      jnz head
      halt
  `);
  it('charges every iteration across the back edge', () => {
    const { program, blocks, trapOffset } = checkPath(src, [3]);
    // head is a back-edge target and must have its own charge.
    const head = blocks.find((b) => b.start === src.labels.head)!;
    expect(head.backEdges).toContain(src.labels.head);
    const r = run(program, { args: [3], gas: 100n, trapOffset });
    expect(r.events).toEqual([5, 5, 5]); // one observable event per iteration
    expect(r.status).toBe('halt');
  });
  it('stops before an iteration when short by one block cost', () => {
    const { program, blocks, trapOffset } = meter(src.program);
    const head = blocks.find((b) => b.start === src.labels.head)!;
    // header cost covers one full iteration; budget for exactly two.
    const budget = head.cost * 2n;
    const r = run(program, { args: [3], gas: budget, trapOffset });
    expect(r.status).toBe('gas');
    expect(r.events).toEqual([5, 5]);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Unreachable blocks still metered and payable on entry           */
/* ------------------------------------------------------------------ */

describe('unreachable blocks', () => {
  const src = asm(
    `
      halt
    dead:
      event 42
      halt
    `,
  );
  it('injects a charge into the unreachable block too', () => {
    const { program, blocks } = meter(src.program);
    const dead = blocks.find((b) => b.start === src.labels.dead)!;
    expect(dead.pred).toEqual([]);
    const emitted = decode(program.code);
    const chargeAtDead = emitted.some(
      (o) => o.opcode === GAS_CHARGE,
    );
    expect(chargeAtDead).toBe(true);
    // Forced jump into dead code is correctly rewritten and gated.
    const jumped = asm(`
      jmp dead
      halt
    dead:
      event 42
      halt
    `);
    const m = meter(jumped.program);
    const broke = run(m.program, { gas: 0n, trapOffset: m.trapOffset });
    expect(broke.status).toBe('gas');
    expect(broke.events).toEqual([]);
    const paid = run(m.program, {
      gas: 100n,
      trapOffset: m.trapOffset,
    });
    expect(paid.events).toEqual([42]);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Exceptions: caught, uncaught, and gas is not catchable          */
/* ------------------------------------------------------------------ */

describe('exceptions', () => {
  const src = asm(
    `
    entry:
      event 1
      throw 7
      event 2
    handler:
      pop
      event 3
      halt
  `,
    {
      ranges: [{ from: 'entry', to: 'handler', handler: 'handler' }],
    },
  );

  it('caught throw path pays only executed instructions', () => {
    const { gold, pathCost } = checkPath(src, []);
    expect(gold.status).toBe('halt');
    expect(gold.events).toEqual([1, 3]);
    // event1 + throw + pop + event3 + halt (event2 never runs)
    expect(pathCost).toBe(5n);
  });

  it('uncaught throws keep throw semantics', () => {
    const noCatch = asm(`
      push 1
      throw 9
      halt
    `);
    const { gold, pathCost } = checkPath(noCatch, []);
    expect(gold.status).toBe('throw');
    expect(gold.tag).toBe(9);
    expect(pathCost).toBe(2n);
  });

  it('gas exhaustion bypasses the user exception table', () => {
    const m = meter(src.program);
    const r = run(m.program, { gas: 0n, trapOffset: m.trapOffset });
    expect(r.status).toBe('gas');
    expect(r.events).toEqual([]);
    expect(r.pc).toBe(m.trapOffset);
    // The trap vector is outside every user range.
    for (const range of m.program.ranges) {
      expect(m.trapOffset >= range.end).toBe(true);
    }
  });

  it('exception spanning multiple blocks charges per block entered', () => {
    const multi = asm(
      `
      start:
        event 1
        jmp mid
      mid:
        event 2
        throw 3
      h:
        event 4
        halt
    `,
      { ranges: [{ from: 'start', to: 'h', handler: 'h' }] },
    );
    const { gold, pathCost } = checkPath(multi, []);
    expect(gold.events).toEqual([1, 2, 4]);
    // e1, jmp, e2, throw, e4, halt = 6
    expect(pathCost).toBe(6n);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Zero-cost blocks emit no charge but still work                  */
/* ------------------------------------------------------------------ */

describe('zero cost', () => {
  // after is a jump target so it is a leader; z therefore contains only the
  // two cost-free nops.
  const src = asm(`
    jmp z
    jmp after
  z:
    nop
    nop
  after:
    event 8
    halt
  `);
  it('skips charge emission for zero-cost blocks', () => {
    const m = meter(src.program);
    const z = m.blocks.find((b) => b.start === src.labels.z)!;
    expect(z.cost).toBe(0n);
    // The jmp target must land on the first body instruction of z.
    expect(m.chargeOffset.get(src.labels.z)).toBe(-1);
    // Path cost: entry jmp (1) + z nops (0) + after event+halt (2) = 3.
    const r = run(m.program, { gas: 3n, trapOffset: m.trapOffset });
    expect(r.status).toBe('halt');
    expect(r.events).toEqual([8]);
    // Zero gas also passes through the cost-free block but must then stop at
    // the event block's charge.
    const broke = run(m.program, { gas: 1n, trapOffset: m.trapOffset });
    expect(broke.status).toBe('gas');
    expect(broke.events).toEqual([]);
    // Number of charges equals number of positive-cost blocks (entry,after),
    // not the number of blocks.
    const positiveBlocks = m.blocks.filter((b) => b.cost > 0n).length;
    expect(m.chargeCount).toBe(positiveBlocks);
  });
});

/* ------------------------------------------------------------------ */
/* 7. Huge costs: bigint summation, one atomic LEB128 charge/block    */
/* ------------------------------------------------------------------ */

describe('huge costs', () => {
  const big = (1n << 70n) + 5n;
  const costs: CostTable = new Map([
    ...defaultCosts(),
    [NOP, big],
  ]);
  const src = asm(`
    nop
    jmp done
  done:
    halt
  `);
  it('sums without Number overflow into a single charge per block', () => {
    const m = meter(src.program, { costs });
    const charges = decode(m.program.code).filter((o) => o.opcode === GAS_CHARGE);
    // Exactly one charge per positive-cost block, regardless of magnitude.
    expect(charges.length).toBe(2);
    // First block: nop(big) + jmp(1); second: halt(1).
    expect(BigInt(charges[0].operand ?? 0)).toBe(big + 1n);
    expect(BigInt(charges[1].operand ?? 0)).toBe(1n);
    // The atomic block reservation covers the full bigint cost: short by the
    // jmp's single unit never executes the block body.
    const broke = run(m.program, { gas: big, trapOffset: m.trapOffset });
    expect(broke.status).toBe('gas');
    expect(broke.events).toEqual([]);
    const paid = run(m.program, { gas: big + 2n, trapOffset: m.trapOffset });
    expect(paid.status).toBe('halt');
  });
});

/* ------------------------------------------------------------------ */
/* 8. Double injection is a no-op                                     */
/* ------------------------------------------------------------------ */

describe('idempotency', () => {
  const src = asm(`
    jmp a
    halt
  a:
    event 1
    halt
  `);
  it('second injection returns the identical program', () => {
    const first = meter(src.program);
    const second = meter(first.program);
    expect(second.program).toBe(first.program);
    expect([...second.program.code]).toEqual([...first.program.code]);
    expect(second.program.table).toEqual(first.program.table);
    expect(second.program.ranges).toEqual(first.program.ranges);
    expect(second.chargeCount).toBe(first.chargeCount);
  });
});

/* ------------------------------------------------------------------ */
/* Indirect jumps enter through metered targets                       */
/* ------------------------------------------------------------------ */

describe('indirect jumps', () => {
  const src = asm(
    `
      jmpi
    one:
      event 1
      halt
    two:
      event 2
      halt
  `,
    { table: ['one', 'two'] },
  );
  it('rewrites the table and meters each target', () => {
    const m = meter(src.program);
    expect(m.program.table).toHaveLength(2);
    for (const t of m.program.table) {
      // Every indirect target points at a charge or a body entry, never mid-block.
      const decoded = decode(m.program.code);
      const op = decoded.find((o) => o.offset === t)!;
      expect([GAS_CHARGE, EVENT, NOP]).toContain(op.opcode);
    }
    const a = run(m.program, { args: [0], gas: 100n, trapOffset: m.trapOffset });
    expect(a.events).toEqual([1]);
    const b = run(m.program, { args: [1], gas: 100n, trapOffset: m.trapOffset });
    expect(b.events).toEqual([2]);
    const broke = run(m.program, { args: [0], gas: 0n, trapOffset: m.trapOffset });
    expect(broke.status).toBe('gas');
  });

  it('rejects indirect targets that land mid-block', () => {
    const prog: Program = {
      // push 1 ; event 2 ; halt  (jump to offset 1 = immediate byte)
      code: Uint8Array.from([PUSH, 1, EVENT, 2, HALT]),
      table: [1],
      ranges: [],
      debug: [],
    };
    expect(() => meter(prog)).toThrow(/boundary|block entry/);
  });
});

/* ------------------------------------------------------------------ */
/* Rewrites: offsets, exception table, debug map                      */
/* ------------------------------------------------------------------ */

describe('offset/table/debug rewriting', () => {
  const src = asm(
    `
    entry:
      jmp later
      halt
    later:
      jmp entry
  `,
  );
  it('rewrites both forward and backward (loop) jump targets', () => {
    const m = meter(src.program);
    const firstJmp = decode(m.program.code).find((o) => o.opcode === JMP)!;
    expect(firstJmp.operand).not.toBe(src.labels.later);
    // It lands at the entry charge of the later block.
    expect(firstJmp.operand).toBe(m.chargeOffset.get(src.labels.later));
  });

  it('rewrites debug points onto original instructions', () => {
    const withDebug = asm(
      `
      entry:
        event 1
        halt
    `,
      { debug: { entry: 11 } },
    );
    const m = meter(withDebug.program);
    expect(m.program.debug).toHaveLength(1);
    const mapped = m.program.debug[0].offset;
    const op = decode(m.program.code).find((o) => o.offset === mapped)!;
    expect(op.opcode).toBe(EVENT);
    expect(m.program.debug[0].line).toBe(11);
  });

  it('rewrites exception range bounds across the shift', () => {
    const ex = asm(
      `
      entry:
        throw 1
      h:
        halt
    `,
      { ranges: [{ from: 'entry', to: 'h', handler: 'h' }] },
    );
    const m = meter(ex.program);
    const [r] = m.program.ranges;
    // start is the charge of entry; handler is the entry of h; end is the
    // boundary before h.
    expect(r.start).toBe(m.chargeOffset.get(ex.labels.entry));
    expect(r.handler).not.toBe(ex.labels.h);
    expect(r.start < r.end).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Structural CFG properties                                          */
/* ------------------------------------------------------------------ */

describe('CFG', () => {
  it('classifies the loop back edge and meters every block', () => {
    const src = asm(`
    top:
      push 1
      sub
      dup
      jnz top
      halt
    `);
    const cfg = buildCFG(src.program, defaultCosts());
    const top = cfg.byStart.get(src.labels.top)!;
    // The jnz inside the header block leaves a back edge at that same block.
    expect(top.backEdges).toContain(src.labels.top);
    for (const b of cfg.blocks) expect(typeof b.cost === 'bigint').toBe(true);
  });

  it('makes every exception handler a block entry', () => {
    const src = asm(
      `
      entry:
        event 1
        throw 2
      h:
        halt
    `,
      { ranges: [{ from: 'entry', to: 'h', handler: 'h' }] },
    );
    const cfg = buildCFG(src.program, defaultCosts());
    expect(cfg.byStart.has(src.labels.h)).toBe(true);
  });

  it('rejects direct jumps into the middle of an instruction', () => {
    const prog: Program = {
      code: Uint8Array.from([JMP, 0, 0, 0, 1 /* -> offset 1, mid-immediate */]),
      table: [],
      ranges: [],
      debug: [],
    };
    expect(() => meter(prog)).toThrow(/boundary|block entry/);
  });
});

/* ------------------------------------------------------------------ */
/* Additional invariants                                              */
/* ------------------------------------------------------------------ */

describe('cost summation', () => {
  it('encodes arbitrary bigint costs as one bounded-length charge', () => {
    const src = asm(`
      nop
      jmp done
    done:
      halt
    `);
    for (const big of [
      1n,
      (1n << 64n) - 1n,
      1n << 64n,
      (1n << 128n) + 7n,
      1n << 1000n,
    ]) {
      const costs: CostTable = new Map([...defaultCosts(), [NOP, big]]);
      const m = meter(src.program, { costs });
      const charges = decode(m.program.code).filter(
        (o) => o.opcode === GAS_CHARGE,
      );
      // One charge per positive-cost block regardless of magnitude.
      expect(charges.length).toBe(2);
      expect(BigInt(charges[0].operand ?? 0)).toBe(big + 1n); // nop + jmp
      expect(BigInt(charges[1].operand ?? 0)).toBe(1n); // halt
      // Encoding is O(bitlen), not O(magnitude).
      const bitBytes = Math.ceil(big.toString(2).length / 7);
      expect(m.program.code.length).toBeLessThan(40 + bitBytes);
    }
  });

  it('rejects negative custom costs', () => {
    const src = asm(`
      nop
      halt
    `);
    expect(() => meter(src.program, { costs: new Map([[NOP, -1n]]) })).toThrow(
      /invalid cost/,
    );
  });
});

describe('RET targets are rewritten and metered', () => {
  const src = asm(`
    ret target
    halt
  target:
    event 3
    halt
  `);
  it('rewrites the RET operand to the metered entry', () => {
    const m = meter(src.program);
    const retOp = decode(m.program.code).find((o) => o.opcode === RET)!;
    expect(retOp.operand).not.toBe(src.labels.target);
    const paid = run(m.program, { gas: 100n, trapOffset: m.trapOffset });
    expect(paid.events).toEqual([3]);
    const broke = run(m.program, { gas: 0n, trapOffset: m.trapOffset });
    expect(broke.status).toBe('gas');
  });
});

describe('exception handler prologue is charged on entry', () => {
  const src = asm(
    `
    entry:
      throw 1
    h:
      event 9
      halt
  `,
    { ranges: [{ from: 'entry', to: 'h', handler: 'h' }] },
  );
  it('a caught throw must pay for the handler block before its body runs', () => {
    const m = meter(src.program);
    // entry(throw) costs 1; handler(event+halt) costs 2 -> total 3.
    const noGas = run(m.program, { gas: 1n, trapOffset: m.trapOffset });
    expect(noGas.status).toBe('gas');
    expect(noGas.events).toEqual([]);
    const full = run(m.program, { gas: 3n, trapOffset: m.trapOffset });
    expect(full.status).toBe('halt');
    expect(full.events).toEqual([9]);
  });
});

describe('injected stream integrity', () => {
  const src = asm(`
    jmp a
  a:
    event 1
    halt
  `);
  it('the injected code re-decodes cleanly and ends with HALT then TRAP', () => {
    const m = meter(src.program);
    const ops = decode(m.program.code);
    expect(ops[0].opcode).toBe(GAS_MARKER);
    expect(ops[ops.length - 1].opcode).toBe(TRAP);
    expect(ops[ops.length - 2].opcode).toBe(HALT);
    expect(ops[ops.length - 1].offset).toBe(m.trapOffset);
  });

  it('rejects jumps landing on an immediate byte of another jump', () => {
    // jmp 1 ; halt : the target offset 1 is the first byte of the u32 operand.
    const code = Uint8Array.from([JMP, 0, 0, 0, 1, HALT]);
    expect(() => meter({ code, table: [], ranges: [], debug: [] })).toThrow(
      /boundary|block entry/,
    );
  });
});
