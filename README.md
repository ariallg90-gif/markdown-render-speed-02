# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ariallg90-gif/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ariallg90-gif/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A from-scratch CommonMark 0.31.2 + GFM 0.29 parser (`parse.js`, Node stdlib only, no dependencies, deterministic, no network) that renders HTML byte-identical to `marked.parse` with default options on all 720 kit cases, and runs faster than the marked 18.1.3 baseline. `main.ts` is the driver: it reads `/input/cases.json`, renders each case alone with `parse()`, and writes `/output/html.json`.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=emzdd1kk&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
