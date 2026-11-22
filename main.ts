// Tiny stack VM — entry for make.fun tiny-stack-vm-01-run-20261122.
// Runs every program.bin in the input dir on the tiny stack ISA (kit ISA.md),
// writing stdout.bin + exit.txt per instance.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Per opcode: [immediate bytes, values popped, values pushed]; absent = trap 5.
const SPEC: Record<number, [number, number, number]> = {
  0: [0, 0, 0], 1: [1, 0, 1], 2: [4, 0, 1], 3: [0, 1, 0], 4: [0, 1, 2],
  5: [0, 2, 2], 6: [0, 2, 3], 7: [0, 3, 3], 16: [0, 2, 1], 17: [0, 2, 1],
  18: [0, 2, 1], 19: [0, 2, 1], 20: [0, 2, 1], 21: [0, 2, 1], 22: [0, 2, 1],
  23: [0, 1, 1], 24: [0, 2, 1], 25: [0, 2, 1], 26: [0, 2, 1], 27: [0, 1, 1],
  28: [0, 2, 1], 29: [0, 2, 1], 30: [0, 2, 1], 32: [0, 2, 1], 33: [0, 2, 1],
  34: [0, 2, 1], 48: [2, 0, 0], 49: [2, 1, 0], 50: [2, 1, 0], 51: [2, 0, 0],
  52: [0, 0, 0], 64: [0, 1, 1], 65: [0, 2, 0], 80: [0, 1, 0], 81: [0, 1, 0],
  82: [0, 0, 1], 83: [0, 1, 0],
};

const STEP_CAP = 1000000, OUT_CAP = 65536;

// Runs one program to its end: the bytes it wrote and its exit code
// (a trap's code included; output written before a trap is kept).
function runVM(prog: Buffer, input: Buffer): { bytes: Uint8Array; len: number; exit: number } {
  const stack = new Int32Array(256), calls = new Int32Array(64), mem = new Int32Array(256);
  const out = new Uint8Array(OUT_CAP), scratch = new Uint8Array(12);
  let sp = 0, cp = 0, ip = 0, pc = 0, steps = 0, olen = 0;
  const finish = (exit: number) => ({ bytes: out, len: olen, exit });

  for (;;) {
    if (steps === STEP_CAP) return finish(10);
    if (pc < 0 || pc >= prog.length) return finish(9);
    const op = prog[pc], spec = SPEC[op];
    if (spec === undefined) return finish(5);
    const [imm, pops, pushes] = spec;
    if (pc + imm >= prog.length) return finish(9);
    steps++;
    const next = pc + 1 + imm;
    if (sp < pops) return finish(2);
    if (sp - pops + pushes > 256) return finish(3);
    pc = next;
    switch (op) {
      case 0: return finish(0);
      case 1: stack[sp++] = (prog[next - 1] << 24) >> 24; break; // PUSH8 sign-extended
      case 2: stack[sp++] = prog[next - 4] | (prog[next - 3] << 8) | (prog[next - 2] << 16) | (prog[next - 1] << 24); break; // PUSH32 LE
      case 3: sp--; break;
      case 4: stack[sp] = stack[sp - 1]; sp++; break;
      case 5: { const t = stack[sp - 1]; stack[sp - 1] = stack[sp - 2]; stack[sp - 2] = t; break; }
      case 6: stack[sp] = stack[sp - 2]; sp++; break;
      case 7: { const t = stack[sp - 3]; stack[sp - 3] = stack[sp - 2]; stack[sp - 2] = stack[sp - 1]; stack[sp - 1] = t; break; }
      case 23: stack[sp - 1] = (-stack[sp - 1]) | 0; break; // NEG wraps at INT_MIN
      case 27: stack[sp - 1] = ~stack[sp - 1]; break;
      case 48: case 49: case 50: {
        const rel = ((prog[next - 2] | (prog[next - 1] << 8)) << 16) >> 16;
        let take = op === 48;
        if (op !== 48) { const v = stack[--sp]; take = op === 49 ? v === 0 : v !== 0; }
        if (take) pc = next + rel;
        break;
      }
      case 51:
        if (cp === 64) return finish(7);
        calls[cp++] = next;
        pc = prog[next - 2] | (prog[next - 1] << 8);
        break;
      case 52:
        if (cp === 0) return finish(8);
        pc = calls[--cp];
        break;
      case 64: {
        const addr = stack[sp - 1];
        if (addr < 0 || addr > 255) return finish(6);
        stack[sp - 1] = mem[addr];
        break;
      }
      case 65: {
        const addr = stack[sp - 1], v = stack[sp - 2];
        if (addr < 0 || addr > 255) return finish(6);
        sp -= 2;
        mem[addr] = v;
        break;
      }
      case 80: { // PRINT: decimal ASCII, '-' when negative, no newline
        const v = stack[sp - 1];
        let k = 0, u = v < 0 ? -v : v;
        do { scratch[k++] = 48 + (u % 10); u = (u / 10) | 0; } while (u > 0);
        if (v < 0) scratch[k++] = 45;
        if (olen + k > OUT_CAP) return finish(11);
        sp--;
        for (let i = k - 1; i >= 0; i--) out[olen++] = scratch[i];
        break;
      }
      case 81:
        if (olen + 1 > OUT_CAP) return finish(11);
        out[olen++] = stack[--sp] & 255;
        break;
      case 82: stack[sp++] = ip < input.length ? input[ip++] : -1; break;
      case 83: return finish(stack[--sp] & 255);
      default: { // two-operand arithmetic, logic and comparison
        const b = stack[sp - 1], a = stack[sp - 2];
        let r = 0;
        if (op === 16) r = (a + b) | 0;
        else if (op === 17) r = (a - b) | 0;
        else if (op === 18) r = Math.imul(a, b);
        else if (op === 19) { if (b === 0) return finish(4); r = a === -2147483648 && b === -1 ? a : (a / b) | 0; }
        else if (op === 20) { if (b === 0) return finish(4); r = b === -1 ? 0 : (a % b) | 0; }
        else if (op === 21) { if (b === 0) return finish(4); r = ((a >>> 0) / (b >>> 0)) | 0; }
        else if (op === 22) { if (b === 0) return finish(4); r = ((a >>> 0) % (b >>> 0)) | 0; }
        else if (op === 24) r = a & b;
        else if (op === 25) r = a | b;
        else if (op === 26) r = a ^ b;
        else if (op === 28) r = a << (b & 31);
        else if (op === 29) r = a >> (b & 31);
        else if (op === 30) r = (a >>> (b & 31)) | 0;
        else if (op === 32) r = a === b ? 1 : 0;
        else if (op === 33) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        sp -= 2;
        stack[sp++] = r;
        break;
      }
    }
  }
}

function read0(path: string): Buffer {
  try { return readFileSync(path); } catch { return Buffer.alloc(0); }
}

for (const e of readdirSync(IN_DIR, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
  if (!e.isDirectory()) continue;
  const res = runVM(read0(join(IN_DIR, e.name, 'program.bin')), read0(join(IN_DIR, e.name, 'input.bin')));
  mkdirSync(join(OUT_DIR, e.name), { recursive: true });
  writeFileSync(join(OUT_DIR, e.name, 'stdout.bin'), res.bytes.subarray(0, res.len));
  writeFileSync(join(OUT_DIR, e.name, 'exit.txt'), String(res.exit) + '\n');
}
