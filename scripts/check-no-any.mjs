#!/usr/bin/env node
/**
 * Fails when TypeScript sources or tests use `any` as an escape hatch.
 * Complements `noImplicitAny`, which only catches implicit cases.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const roots = ['shared-plane', 'application-plane', 'control-plane', 'tests'];
const ignored = new Set(['node_modules', 'dist', 'coverage']);
const pattern = /(:\s*any\b|\bas\s+any\b|<any>|any\[\]|Array<any>|Record<[^>]*\bany\b)/;

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (ignored.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (path.endsWith('.ts')) yield path;
  }
}

const offences = [];
for (const root of roots) {
  let exists = true;
  try {
    statSync(root);
  } catch {
    exists = false;
  }
  if (!exists) continue;
  for (const file of files(root)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (pattern.test(line) && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*')) {
          offences.push(`${relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`);
        }
      });
  }
}

if (offences.length > 0) {
  console.error(`Explicit 'any' is not allowed:\n${offences.join('\n')}`);
  process.exit(1);
}
console.log('check:no-any — no explicit any found');
