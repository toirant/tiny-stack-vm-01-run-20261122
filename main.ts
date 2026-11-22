// Tiny stack VM for make.fun's tiny-stack-vm-01 ISA. One run answers every
// instance: for each /input/<id> it runs program.bin on input.bin and writes
// /output/<id>/stdout.bin and /output/<id>/exit.txt. Node 22, no deps.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Per-opcode tables, indexed by opcode byte: [immediate bytes, pops, pushes].
// A byte with no row is an unknown opcode (trap 5).
const IMM = new Uint8Array(256), POPS = new Uint8Array(256);
const PUSHES = new Uint8Array(256), KNOWN = new Uint8Array(256);
for (const [o, i, p, q] of [
  [0x00,0,0,0],[0x01,1,0,1],[0x02,4,0,1],[0x03,0,1,0],
  [0x04,0,1,2],[0x05,0,2,2],[0x06,0,2,3],[0x07,0,3,3],
  [0x10,0,2,1],[0x11,0,2,1],[0x12,0,2,1],[0x13,0,2,1],
  [0x14,0,2,1],[0x15,0,2,1],[0x16,0,2,1],[0x17,0,1,1],
  [0x18,0,2,1],[0x19,0,2,1],[0x1a,0,2,1],[0x1b,0,1,1],
  [0x1c,0,2,1],[0x1d,0,2,1],[0x1e,0,2,1],[0x20,0,2,1],
  [0x21,0,2,1],[0x22,0,2,1],[0x30,2,0,0],[0x31,2,1,0],
  [0x32,2,1,0],[0x33,2,0,0],[0x34,0,0,0],[0x40,0,1,1],
  [0x41,0,2,0],[0x50,0,1,0],[0x51,0,1,0],[0x52,0,0,1],
  [0x53,0,1,0],
]) { IMM[o] = i; POPS[o] = p; PUSHES[o] = q; KNOWN[o] = 1; }

// Run one program on its input; returns [stdout, exit code].
function run(prog, input) {
  const n = prog.length;
  const st = new Int32Array(256); // data stack
  const cs = new Int32Array(64); // call stack of return addresses
  const mem = new Int32Array(256); // memory, all words start at 0
  const out = new Uint8Array(65536);
  let sp = 0, csp = 0, pc = 0, steps = 0, olen = 0, ipos = 0;
  const end = (exit) => [out.subarray(0, olen), exit];
  for (;;) {
    // Checks in ISA order: step limit, pc, opcode, immediate, then step and stack.
    if (steps === 1000000) return end(10);
    if (pc < 0 || pc >= n) return end(9);
    const op = prog[pc];
    if (!KNOWN[op]) return end(5);
    const imm = IMM[op];
    if (pc + imm >= n) return end(9);
    steps++;
    const next = pc + 1 + imm;
    if (sp < POPS[op]) return end(2);
    if (sp - POPS[op] + PUSHES[op] > 256) return end(3);
    pc = next;
    switch (op) {
      case 0x00: return end(0); // HALT
      case 0x01: st[sp++] = (prog[next - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 0x02: // PUSH32, little-endian, signed
        st[sp++] = prog[next - 4] | (prog[next - 3] << 8) | (prog[next - 2] << 16) | (prog[next - 1] << 24);
        break;
      case 0x03: sp--; break; // POP
      case 0x04: st[sp] = st[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; break; } // SWAP
      case 0x06: st[sp] = st[sp - 2]; sp++; break; // OVER
      case 0x07: { // ROT (a b c -- b c a)
        const a = st[sp - 3]; st[sp - 3] = st[sp - 2]; st[sp - 2] = st[sp - 1]; st[sp - 1] = a;
        break;
      }
      case 0x17: st[sp - 1] = -st[sp - 1] | 0; break; // NEG, wraps
      case 0x1b: st[sp - 1] = ~st[sp - 1]; break; // NOT
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15:
      case 0x16: case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d:
      case 0x1e: case 0x20: case 0x21: case 0x22: {
        const b = st[sp - 1], a = st[sp - 2];
        let r;
        if (op === 0x10) r = (a + b) | 0; // ADD, wraps
        else if (op === 0x11) r = (a - b) | 0; // SUB, wraps
        else if (op === 0x12) r = Math.imul(a, b); // MUL, low 32 bits
        else if (op === 0x13) { // DIV, signed, toward zero
          if (b === 0) return end(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 0x14) { // MOD, sign of a
          if (b === 0) return end(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 0x15) { // DIVU, unsigned
          if (b === 0) return end(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 0x16) { // MODU, unsigned
          if (b === 0) return end(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 0x18) r = a & b; // AND
        else if (op === 0x19) r = a | b; // OR
        else if (op === 0x1a) r = a ^ b; // XOR
        else if (op === 0x1c) r = a << (b & 31); // SHL, low 5 bits count
        else if (op === 0x1d) r = a >> (b & 31); // SHR, arithmetic
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0; // SHRU, logical
        else if (op === 0x20) r = a === b ? 1 : 0; // EQ
        else if (op === 0x21) r = a < b ? 1 : 0; // LT, signed
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU, unsigned
        sp -= 2; st[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ
        const rel = ((prog[next - 2] | (prog[next - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) { const v = st[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc = next + rel;
        break;
      }
      case 0x33: // CALL: push next address, jump to unsigned 16-bit target
        if (csp === 64) return end(7);
        cs[csp++] = next; pc = prog[next - 2] | (prog[next - 1] << 8);
        break;
      case 0x34: // RET
        if (csp === 0) return end(8);
        pc = cs[--csp];
        break;
      case 0x40: { // LOAD
        const addr = st[sp - 1];
        if (addr < 0 || addr >= 256) return end(6);
        st[sp - 1] = mem[addr];
        break;
      }
      case 0x41: { // STORE (v addr --), addr is the top
        const addr = st[sp - 1], v = st[sp - 2];
        if (addr < 0 || addr >= 256) return end(6);
        sp -= 2; mem[addr] = v;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII, no newline; over the limit traps 11
        const s = String(st[sp - 1]);
        if (olen + s.length > 65536) return end(11);
        sp--;
        for (let i = 0; i < s.length; i++) out[olen++] = s.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC: one byte, v AND 255
        if (olen + 1 > 65536) return end(11);
        out[olen++] = st[--sp] & 255;
        break;
      case 0x52: // IN: next input byte, -1 once the input is used up
        st[sp++] = ipos < input.length ? input[ipos++] : -1;
        break;
      case 0x53: return end(st[--sp] & 255); // EXIT: code is the low byte
    }
  }
}

for (const entry of readdirSync(IN_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const id = entry.name;
  const dir = join(IN_DIR, id);
  let input = new Uint8Array(0);
  try { input = readFileSync(join(dir, 'input.bin')); } catch { /* empty input */ }
  const prog = readFileSync(join(dir, 'program.bin'));
  const [stdout, exit] = run(prog, input);
  const outDir = join(OUT_DIR, id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'stdout.bin'), stdout);
  writeFileSync(join(outDir, 'exit.txt'), String(exit) + '\n');
}
