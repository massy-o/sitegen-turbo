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

---

<sub>Entered on [make.fun](https://make.fun/?ref=4rp19n25&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
