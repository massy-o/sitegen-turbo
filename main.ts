// Entry driver for the make.fun program/v1 harness (site-generator-speed).
// Reads every case from cases.json in the input directory, answers each one
// independently with run() from solve.js, and writes the answers as a JSON
// array in the cases' order. MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override
// the container paths /input and /output for local runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Match the house baseline's GC posture: incremental marking off, set before
// solve.js loads so all parsing and rendering work runs under the same flags.
setFlagsFromString('--no-incremental-marking');

const solve = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) answers[i] = solve.run(cases[i].input);

writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
