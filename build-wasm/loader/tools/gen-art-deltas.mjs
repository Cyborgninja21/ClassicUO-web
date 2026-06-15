#!/usr/bin/env node
// gen-art-deltas.mjs — server-side delta-generation tool for the art-patching
// pipeline (workstream D2). For each file present in BOTH a base dir and a
// target dir whose bytes DIFFER, encode a binary delta (art-delta-codec.js) and
// write <out>/<name>.uodelta, plus a patch-manifest.json the client consumes.
//
//   node gen-art-deltas.mjs --base <baseDir> --target <targetDir> --out <outDir>
//
// Rules:
//   - file in both, bytes differ -> encode delta. But only KEEP/list it as a
//     patch when delta_size < result_size (a full fetch is otherwise cheaper).
//   - identical files -> skipped (no delta).
//   - file only in target (new) -> no delta; client full-fetches it.
//   - file only in base -> ignored (removed; nothing to patch).
//   - zero-byte / unreadable files -> handled gracefully, never crash the run.
//
// Node-only (fs/crypto/path) lives HERE and in the tests — the codec module
// itself stays browser-safe.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { encodeDelta, applyDelta } from '../wwwroot/art-delta-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { base: null, target: null, out: null, verify: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--no-verify') out.verify = false;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

function usage() {
  console.log('Usage: node gen-art-deltas.mjs --base <baseDir> --target <targetDir> --out <outDir> [--no-verify]');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// List regular files (one level — art payloads are flat dirs). Returns Map
// name -> absolute path. Robust against a missing/empty dir.
function listFiles(dir) {
  const map = new Map();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return map; // missing dir -> empty set (caller decides if fatal)
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    map.set(ent.name, join(dir, ent.name));
  }
  return map;
}

function readBytes(path) {
  return new Uint8Array(readFileSync(path));
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.base || !args.target || !args.out) {
    usage();
    process.exit(args.help ? 0 : 2);
  }

  const baseFiles = listFiles(args.base);
  const targetFiles = listFiles(args.target);

  if (targetFiles.size === 0) {
    console.error(`No files found in target dir: ${args.target}`);
    process.exit(1);
  }

  mkdirSync(args.out, { recursive: true });

  const manifest = {
    version: 1,
    generated: new Date().toISOString(),
    base: {},
    patches: [],
  };

  let nPatched = 0;
  let nIdentical = 0;
  let nNew = 0;
  let nNotPatchable = 0;
  let nErrors = 0;
  let totalDeltaBytes = 0;
  let totalPatchedTargetBytes = 0;

  // Sort for deterministic output ordering.
  const names = [...targetFiles.keys()].sort();

  for (const name of names) {
    const targetPath = targetFiles.get(name);
    const basePath = baseFiles.get(name);

    if (!basePath) {
      nNew++; // only in target -> client full-fetches
      continue;
    }

    let baseBytes;
    let targetBytes;
    try {
      baseBytes = readBytes(basePath);
      targetBytes = readBytes(targetPath);
    } catch (e) {
      console.error(`  ERROR reading ${name}: ${e.message}`);
      nErrors++;
      continue;
    }

    const baseHash = sha256(baseBytes);
    manifest.base[name] = baseHash;

    const resultHash = sha256(targetBytes);

    // Identical bytes -> nothing to do.
    if (baseHash === resultHash && baseBytes.length === targetBytes.length) {
      nIdentical++;
      continue;
    }

    let delta;
    try {
      delta = encodeDelta(baseBytes, targetBytes);
      if (args.verify) {
        const rt = applyDelta(baseBytes, delta);
        if (rt.length !== targetBytes.length || sha256(rt) !== resultHash) {
          throw new Error('round-trip verification FAILED — refusing to emit a bad delta');
        }
      }
    } catch (e) {
      console.error(`  ERROR encoding ${name}: ${e.message}`);
      nErrors++;
      continue;
    }

    const deltaSize = delta.length;
    const resultSize = targetBytes.length;

    // Only emit/list a patch when it's actually cheaper than a full fetch.
    if (deltaSize < resultSize) {
      const deltaName = `${name}.uodelta`;
      writeFileSync(join(args.out, deltaName), delta);
      const deltaHash = sha256(delta);
      manifest.patches.push({
        name,
        base_sha256: baseHash,
        result_sha256: resultHash,
        result_size: resultSize,
        delta_size: deltaSize,
        delta_sha256: deltaHash,
      });
      nPatched++;
      totalDeltaBytes += deltaSize;
      totalPatchedTargetBytes += resultSize;
    } else {
      // Changed, but a delta isn't smaller — client full-fetches.
      nNotPatchable++;
    }
  }

  writeFileSync(join(args.out, 'patch-manifest.json'), JSON.stringify(manifest, null, 2));

  const pct = totalPatchedTargetBytes > 0
    ? (100 * (1 - totalDeltaBytes / totalPatchedTargetBytes)).toFixed(1)
    : '0.0';

  console.log('');
  console.log('gen-art-deltas summary');
  console.log('──────────────────────');
  console.log(`  base dir      : ${args.base}`);
  console.log(`  target dir    : ${args.target}`);
  console.log(`  out dir       : ${args.out}`);
  console.log(`  patched       : ${nPatched}`);
  console.log(`  identical     : ${nIdentical} (skipped)`);
  console.log(`  new-in-target : ${nNew} (client full-fetch)`);
  console.log(`  changed-but-not-patchable : ${nNotPatchable} (delta >= full)`);
  if (nErrors) console.log(`  errors        : ${nErrors}`);
  console.log(`  delta bytes   : ${fmtBytes(totalDeltaBytes)} vs target ${fmtBytes(totalPatchedTargetBytes)} -> ${pct}% saved`);
  console.log('');

  process.exit(nErrors ? 1 : 0);
}

main();
