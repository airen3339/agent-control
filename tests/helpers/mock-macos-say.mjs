#!/usr/bin/env node
import { writeFileSync } from "node:fs";

if (process.env.MOCK_SAY_FAIL === "1") {
  process.stderr.write("mock say failed intentionally\n");
  process.exit(1);
}

const args = process.argv.slice(2);
let outPath = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "-o" && args[i + 1]) {
    outPath = args[i + 1];
    break;
  }
}

if (!outPath) {
  process.stderr.write("missing -o output path\n");
  process.exit(2);
}

const sampleRate = 22050;
const sampleCount = 2205;
const dataSize = sampleCount * 2;
const buf = Buffer.alloc(44 + dataSize);
buf.write("RIFF", 0, "ascii");
buf.writeUInt32LE(36 + dataSize, 4);
buf.write("WAVE", 8, "ascii");
buf.write("fmt ", 12, "ascii");
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sampleRate, 24);
buf.writeUInt32LE(sampleRate * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36, "ascii");
buf.writeUInt32LE(dataSize, 40);
for (let i = 0; i < sampleCount; i += 1) {
  buf.writeInt16LE(Math.round(Math.sin(i / 8) * 320), 44 + i * 2);
}
writeFileSync(outPath, buf);
