# JevTrace video

A 30-second vertical explainer (1080×1920, 30 fps) of how JevTrace works, in four steps, with music and sound effects, made with [Remotion](https://www.remotion.dev), and the landing page GitHub Pages serves it on (`.github/workflows/video-page.yml`).

Nothing on screen is typed by hand: `src/data/demo.json` is a recorded JevTrace run (the task, the leads Jev chose, the matches it passed over, the compiler edges around the top lead) and `src/data/metrics.json` holds the numbers it shows: how much less context the same coding agent reads with JevTrace and how many repository searches it makes ([agent benchmark](../docs/agent-benchmark.md), medians) and how much of each task's needed code JevTrace finds ([retrieval benchmark](../docs/benchmark-vs-jevgrep.md)). Re-capture them (`npm run capture -- --metrics-only` for the numbers alone), commit, and the workflow renders and publishes the new video.

Music and sound effects are synthesized by `scripts/generate-music.mjs` (no samples, no licence) on the same timeline as the animation (`src/timeline.json`). It is deterministic and runs before every render, so the file is not committed. There is no narration: most viewers watch muted, so each step explains itself on screen.

```bash
npm install
npm run studio     # preview and scrub in the browser
npm run render     # out/jevtrace.mp4 (regenerates the music first)
npm run still      # out/poster.png
npm run build:page # site/ for GitHub Pages
npm run capture    # re-record src/data from a JevTrace run on ../../hono (needs `npm run build` in the root and a provider in ../.env)
```

Remotion is free for individuals and companies of up to three people; larger companies need a [company license](https://www.remotion.dev/license).
