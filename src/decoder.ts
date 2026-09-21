import { KNOWN_OPS, OPERAND_WIDTH, VAR_LEN } from './opcodes.js';
import type { Op, Program } from './types.js';
import { MeterError } from './types.js';

/** Decode one unsigned LEB128 value, returning [value, bytes consumed]. */
export function readULEB(code: Uint8Array, at: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let p = at;
  for (;;) {
    if (p >= code.length) throw new MeterError('truncated LEB128 operand');
    const byte = code[p++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 256n * 7n) throw new MeterError('LEB128 operand too large');
  }
  return [result, p - at];
}

/**
 * Decode a bytecode stream.
 *
 * Backward compatible with the original contract: opcode 1 carries one
 * immediate byte. The full instruction table is applied on top.
 */
export function decode(code: Uint8Array): Op[] {
  const out: Op[] = [];
  for (let at = 0; at < code.length; ) {
    const start = at;
    const opcode = code[at++];
    if (opcode === undefined || !KNOWN_OPS.has(opcode)) {
      throw new MeterError(`unknown opcode at ${start}`);
    }
    const op: Op = { offset: start, opcode };
    if (VAR_LEN.has(opcode)) {
      const [value, consumed] = readULEB(code, at);
      op.operand = value;
      at += consumed;
      out.push(op);
      continue;
    }
    const width = OPERAND_WIDTH[opcode] ?? 0;
    if (at + width > code.length) {
      throw new MeterError(`truncated operand at ${start}`);
    }
    if (width === 1) {
      op.operand = code[at++];
    } else if (width === 2) {
      op.operand = code[at] | (code[at + 1] << 8);
      at += 2;
    } else if (width === 4) {
      op.operand =
        (code[at] << 24) |
        (code[at + 1] << 16) |
        (code[at + 2] << 8) |
        code[at + 3];
      at += 4;
    }
    out.push(op);
  }
  return out;
}

/** Offsets of every instruction boundary. */
export function boundaries(code: Uint8Array): Set<number> {
  return new Set(decode(code).map((op) => op.offset));
}

export function emptyProgram(code: Uint8Array): Program {
  return { code, table: [], ranges: [], debug: [] };
}

/* ---- encoders used by the injector ---- */

export function emitByte(out: number[], v: number): void {
  out.push(v & 0xff);
}

export function emitImm32(out: number[], v: number): void {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

export function emitULEB(out: number[], v: bigint): void {
  if (v < 0n) throw new MeterError('cannot encode negative LEB128');
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
}
