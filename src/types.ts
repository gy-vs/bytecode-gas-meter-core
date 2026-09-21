import type { Block } from './cfg.js';

/** A decoded instruction. u64 GAS_CHARGE operands are represented as bigint. */
export interface Op {
  offset: number;
  opcode: number;
  operand?: number | bigint;
}

/** Half-open protected region [start, end) dispatching to `handler`. */
export interface ExRange {
  start: number;
  end: number;
  handler: number;
}

export interface DebugEntry {
  offset: number;
  line: number;
}

/**
 * A bytecode module. `table` holds legal targets for indirect jumps.
 */
export interface Program {
  code: Uint8Array;
  table: number[];
  ranges: ExRange[];
  debug: DebugEntry[];
}

export type CostTable = ReadonlyMap<number, bigint>;

export class MeterError extends Error {}

export interface MeterResult {
  program: Program;
  blocks: Block[];
  /** original block entry offset -> charge offset in the emitted code */
  chargeOffset: Map<number, number>;
  /** every original instruction offset -> its new body offset */
  offsetMap: Map<number, number>;
  /** offset of the unified gas-exhausted TRAP */
  trapOffset: number;
  /** injected charge count (zero for cost-free blocks) */
  chargeCount: number;
}
