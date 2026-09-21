# Bytecode gas-metering core

TypeScript library for module decoding, CFG construction, gas metering
injection, and a reference interpreter.

Run `npm install`, then `npm test` and `npm run build`.

## Pipeline

1. **`decode(code)` / `boundaries(code)`** — decode a bytecode module.
   Opcode `1` (`PUSH imm8`) keeps its historical one-byte-operand encoding.
2. **`buildCFG(program, costs)`** — recovers basic blocks over leaders:
   module entry, direct/indirect jump targets, post-terminator instructions,
   every `THROW` and its successor (so an exception path pays only for
   executed instructions), and all exception-table points. Successors include
   conservative exceptional edges to handlers; back edges (loop headers,
   including unreachable components) are classified by tri-color DFS.
3. **`meter(program, { costs })`** — rewrites a program into a metered one:
   - inserts a `GAS_MARKER` (idempotency tag) and one `GAS_CHARGE` per
     positive-cost basic block, holding the block cost as a variable-length
     unsigned LEB128 immediate;
   - charges are emitted at block entries, so loop back edges, indirect jump
     targets, and exception handlers are re-charged on every entry; zero-cost
     blocks emit no charge;
   - block costs are summed as `bigint` (no overflow), encoded in
     `O(bitlength)` bytes per charge;
   - direct jumps, `RET`, and the indirect jump table are rewritten to the
     metered entries; exception ranges and debug maps are remapped;
   - appends a clean `HALT` and a unified `TRAP` vector: an unaffordable
     charge jumps straight there, bypassing user exception tables;
   - already-metered programs are returned byte-identical (no double
     injection).

## Semantics

`run(program, { gas, args })` interprets a module. A metered run with budget
equal to the exact original path cost terminates with the same status, value
stack, and observable events as the original; a budget one unit short traps at
the unified vector before executing any instruction (and therefore before any
side effect) of the block that could not be paid.

The reference interpreter and the per-path cost/side-effect oracle are
exercised by `test/gas.test.ts`; `test/fuzz.ts` (run with
`npx tsx test/fuzz.ts`) checks equivalence, exact-cost accounting, and
boundary-only trapping over 500 randomized programs.
