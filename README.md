# sitegen-turbo

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/massy-o/sitegen-turbo/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/massy-o/sitegen-turbo/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A byte-exact, high-speed drop-in reimplementation of make.fun's makefun-site 1.0.0 static site generator. For each case input ({ site, templates, files }) it returns the exact output tree makefun-site's build returns — every page's index.html, the index and tag pages, build-report.txt and each static file, byte for byte — while spending far less CPU time: single-pass Markdown rendering, compiled templates, and no wasted parsing.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` reads `cases.json` from the input directory, answers each case with `run()` from `solve.js`, and writes `answers.json` to the output directory.

## Design

`solve.js` is a from-scratch reimplementation, not a patch of the vendor
code: a line-classifying Markdown lexer over parallel arrays, a
single-pass inline renderer working on index ranges with char-code
dispatch and run slicing, an indexOf-walking front-matter parser,
NFKD-free ASCII fast paths for slugs, templates compiled once per case
into direct render functions via `new Function` (tree-walk fallback),
monomorphic record factories, and parts-array assembly with a single
join per page. No state carries between cases.

## Measured locally

Against the kit's baseline on the same machine (shared VM, so ratios
wobble; absolute times are the stable signal):

- Practice set (3 cases, 1,091 sources): byte-identical output, ~160 ms
  per set vs the baseline's ~450–500 ms — about **3× faster**.
- Three extra sets minted with the kit's own generator from other seeds:
  byte-identical output on all of them.
- ~1,700 mutation-fuzzed inputs (mutated Markdown, front matter,
  templates, paths, pagination) compared directly against the baseline's
  `run()`: zero mismatches. (One mutation class — a template that
  includes itself inside loops — makes the baseline itself die with
  "Invalid string length"; the generator never produces such templates.)
- External-AI critique (Sakura GLM-5.3-Flash, DeepSeek-V4.1-Flash) was
  consulted on the architecture and on the post-profile optimization
  pass; its main suggestions (char-code dispatch with run slicing,
  compiled templates, uniform factory shapes, single-join assembly) are
  the design above. One suggested trick — a WeakMap lookup cache for
  template paths — was tried, measured slower, and removed.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4rp19n25&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
