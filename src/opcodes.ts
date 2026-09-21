/**
 * Instruction set.
 *
 * Layout note: opcode 1 keeps its historical meaning (1-byte operand) so the
 * legacy `decode` contract stays intact.
 */
export const NOP = 0;
export const PUSH = 1; // imm8
export const POP = 2;
export const ADD = 3;
export const SUB = 4;
export const MUL = 5;
export const EQ = 6;
export const LT = 7;
export const JMP = 8; // imm32 absolute offset
export const JZ = 9; // imm32, pop, jump if zero
export const JNZ = 10; // imm32, pop, jump if nonzero
export const JMPI = 11; // pop index, jump through program.table
export const EVENT = 12; // imm8, observable side effect
export const HALT = 13;
export const THROW = 14; // imm8 tag
export const RET = 15;
export const DUP = 16;
export const PICK = 17; // imm8 depth, copy stack[top-depth]

/** Pseudo ops emitted only by the metering pass. */
export const GAS_MARKER = 20; // imm16 version
export const GAS_CHARGE = 21; // unsigned LEB128 block cost
export const TRAP = 22; // unified gas-exhausted vector

export const GAS_VERSION = 1;

/**
 * Fixed operand width in bytes. Opcodes absent from the table have no fixed
 * operand (GAS_CHARGE is variable-length LEB128 and decoded specially).
 */
export const OPERAND_WIDTH: Readonly<Record<number, number>> = {
  [PUSH]: 1,
  [JMP]: 4,
  [JZ]: 4,
  [JNZ]: 4,
  [RET]: 4,
  [EVENT]: 1,
  [THROW]: 1,
  [PICK]: 1,
  [GAS_MARKER]: 2,
};

export const VAR_LEN = new Set<number>([GAS_CHARGE]);

export const TERMINATORS: ReadonlySet<number> = new Set([
  JMP,
  JZ,
  JNZ,
  JMPI,
  HALT,
  THROW,
  RET,
  TRAP,
]);

/** Opcodes introduced by the injector; they must never appear in source code. */
export const GAS_OPS: ReadonlySet<number> = new Set([GAS_MARKER, GAS_CHARGE, TRAP]);

export const KNOWN_OPS: ReadonlySet<number> = new Set([
  NOP,
  PUSH,
  POP,
  ADD,
  SUB,
  MUL,
  EQ,
  LT,
  JMP,
  JZ,
  JNZ,
  JMPI,
  EVENT,
  HALT,
  THROW,
  RET,
  DUP,
  PICK,
  GAS_MARKER,
  GAS_CHARGE,
  TRAP,
]);

/** Default instruction cost schedule. Gas pseudo ops are free. */
export function defaultCosts(): Map<number, bigint> {
  const m = new Map<number, bigint>();
  m.set(NOP, 0n);
  m.set(GAS_MARKER, 0n);
  m.set(GAS_CHARGE, 0n);
  m.set(TRAP, 0n);
  for (const op of KNOWN_OPS) {
    if (!m.has(op)) m.set(op, 1n);
  }
  return m;
}

/** Unsigned LEB128 helpers for the variable-length GAS_CHARGE operand. */
export function unsignedLebSize(v: bigint): number {
  let n = 1n;
  while (v >= 128n) {
    v >>= 7n;
    n++;
  }
  return Number(n);
}
