import {
  ADD,
  DUP,
  EQ,
  GAS_CHARGE,
  GAS_MARKER,
  HALT,
  JMPI,
  JMP,
  JNZ,
  JZ,
  LT,
  MUL,
  NOP,
  OPERAND_WIDTH,
  PICK,
  POP,
  PUSH,
  RET,
  SUB,
  THROW,
  EVENT,
  TRAP,
} from './opcodes.js';
import type { Program } from './types.js';
import { decode, readULEB } from './decoder.js';

export type RunStatus =
  | 'halt' // clean termination
  | 'gas' // gas exhausted -> unified trap
  | 'throw' // uncaught THROW
  | 'invalid'; // malformed control flow / stack

export interface RunResult {
  status: RunStatus;
  /** offset of the THROW that propagated, when status === 'throw' */
  throwOffset?: number;
  tag?: number;
  events: number[];
  gasLeft: bigint;
  gasSpent: bigint;
  pc: number;
  stack: number[];
}

export interface RunOptions {
  gas?: bigint;
  args?: number[];
  step?: (pc: number, opcode: number) => void;
  /** trap vector for metered programs */
  trapOffset?: number;
  maxSteps?: number;
}

function finish(
  status: RunStatus,
  fields: {
    prog: Program;
    events: number[];
    gas: bigint;
    startGas: bigint;
    pc: number;
    stack: number[];
    tag?: number;
    throwOffset?: number;
  },
): RunResult {
  return {
    status,
    events: fields.events,
    gasLeft: fields.gas,
    gasSpent: fields.startGas - fields.gas,
    pc: fields.pc,
    stack: fields.stack,
    tag: fields.tag,
    throwOffset: fields.throwOffset,
  };
}

export function run(prog: Program, options: RunOptions = {}): RunResult {
  const ops = decode(prog.code);
  const byOffset = new Map(ops.map((o) => [o.offset, o]));
  const stack: number[] = options.args ? [...options.args] : [];
  const events: number[] = [];
  const startGas = options.gas ?? 0n;
  let gas = startGas;
  let pc = ops[0]?.offset ?? 0;
  const trap = options.trapOffset ?? prog.code.length;
  const maxSteps = options.maxSteps ?? 1_000_000;
  let steps = 0;
  let tag: number | undefined;
  let throwOffset: number | undefined;

  const bail = (status: RunStatus, at: number): RunResult =>
    finish(status, { prog, events, gas, startGas, pc: at, stack, tag, throwOffset });

  for (;;) {
    const op = byOffset.get(pc);
    if (!op) {
      // Only the trap slot is legal to land on; running off the real code end
      // is a clean stop.
      if (pc === trap) return bail('gas', pc);
      return bail('halt', pc);
    }
    if (++steps > maxSteps) return bail('invalid', pc);
    options.step?.(pc, op.opcode);

    let next: number;
    if (op.opcode === GAS_CHARGE) {
      const [, lebBytes] = readULEB(prog.code, op.offset + 1);
      next = op.offset + 1 + lebBytes;
    } else {
      next = pc + 1 + (OPERAND_WIDTH[op.opcode] ?? 0);
    }

    switch (op.opcode) {
      case NOP:
      case GAS_MARKER:
        pc = next;
        break;

      case GAS_CHARGE: {
        const cost = BigInt(op.operand ?? 0);
        if (gas < cost) {
          pc = trap; // unified vector; user exception tables are bypassed
        } else {
          gas -= cost;
          pc = next;
        }
        break;
      }
      case TRAP:
        return bail('gas', pc);

      case PUSH:
        stack.push(Number(op.operand));
        pc = next;
        break;
      case POP:
        if (stack.pop() === undefined) return bail('invalid', pc);
        pc = next;
        break;
      case DUP:
        if (stack.length < 1) return bail('invalid', pc);
        stack.push(stack[stack.length - 1]);
        pc = next;
        break;
      case PICK: {
        const depth = Number(op.operand);
        const idx = stack.length - 1 - depth;
        if (idx < 0) return bail('invalid', pc);
        stack.push(stack[idx]);
        pc = next;
        break;
      }
      case ADD:
      case SUB:
      case MUL:
      case EQ:
      case LT: {
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined) return bail('invalid', pc);
        stack.push(
          op.opcode === ADD
            ? a + b
            : op.opcode === SUB
              ? a - b
              : op.opcode === MUL
                ? a * b
                : op.opcode === EQ
                  ? a === b
                    ? 1
                    : 0
                  : a < b
                    ? 1
                    : 0,
        );
        pc = next;
        break;
      }
      case EVENT:
        events.push(Number(op.operand));
        pc = next;
        break;

      case JMP:
      case RET:
        pc = Number(op.operand);
        break;
      case JZ:
      case JNZ: {
        const v = stack.pop();
        if (v === undefined) return bail('invalid', pc);
        const taken = op.opcode === JZ ? v === 0 : v !== 0;
        pc = taken ? Number(op.operand) : next;
        break;
      }
      case JMPI: {
        const idx = stack.pop();
        if (idx === undefined || idx < 0 || idx >= prog.table.length) {
          return bail('invalid', pc);
        }
        pc = prog.table[idx];
        break;
      }
      case HALT:
        return bail('halt', pc);
      case THROW: {
        tag = Number(op.operand);
        throwOffset = pc;
        const handler = findHandler(prog, pc);
        if (handler === null) return bail('throw', pc);
        stack.push(tag);
        pc = handler;
        break;
      }
      default:
        return bail('invalid', pc);
    }
  }
}

/** First registered range covering the faulting offset. */
function findHandler(prog: Program, pc: number): number | null {
  for (const r of prog.ranges) {
    if (pc >= r.start && pc < r.end) return r.handler;
  }
  return null;
}
