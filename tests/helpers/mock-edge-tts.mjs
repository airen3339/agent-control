#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
let outPath = "";
let text = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--write-media" && i + 1 < args.length) {
    outPath = args[i + 1];
    i += 1;
  } else if (args[i] === "--text" && i + 1 < args.length) {
    text = args[i + 1];
    i += 1;
  }
}

if (!outPath) {
  process.stderr.write("missing --write-media\n");
  process.exit(1);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, Buffer.concat([Buffer.from("ID3\x03\x00"), Buffer.from(`MOCK_MP3:${text}`)]));
