# markdown-render-speed-02 entry

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/bebek22-jpg/markdown-render-speed-02-entry-v2/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/bebek22-jpg/markdown-render-speed-02-entry-v2/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A faster drop-in replacement for the `marked` 18.1.3 Markdown renderer,
producing byte-for-byte identical HTML with marked's default options
(GFM on). Dependency-free, a single module (`parse.js`, `parse(markdown)`).

## Result

- **Correctness: 720/720** on the kit's practice corpus (680 CommonMark
  0.31.2 + GFM 0.29 spec examples, 40 generated READMEs, 2.86 MB total).
- **Speed: ~1.60x faster than stock marked** on the same corpus
  (trimmed mean over 9 rounds: ~1,239 ms vs ~1,987 ms for marked
  18.1.3, Node 24, this VM).

## Approach

A hand-written renderer built to replicate marked's exact output —
including its quirks — rather than the CommonMark spec:

- **Block layer:** a line-based container stack (blockquote / list /
  item) with marked's block order (indented code, fences, heading, hr,
  blockquote, list, HTML, def, table, setext, paragraph). Container
  stripping expands tabs column-aware; code-content stripping preserves
  them. Fence indent compensation slices by character count, as marked
  does.
- **Inline layer:** a single left-to-right scanner that collects text
  runs, code spans, links, autolinks, and delimiter markers in one pass,
  then resolves emphasis with marked's own opener-driven algorithm
  (leftmost opener first, `%3` rule, RDelim classification, one-char
  peeling on failed matches, `bUse` vs `use` closer leftovers).
- **Faithful quirks:** the `ze()` masking gate (marked scans the
  *masked* source, so over-matched code spans hide delimiters), the
  reflink-label recursion in the mask, GFM autolink backpedalling
  (repeated forward regex), the `[ \t]+\n` paragraph-continuation
  exclusion (a trailing whitespace line joins a blockquote paragraph),
  lazy fence/list rules, and marked's exact table/HTML-block/list
  rendering shapes.
- **Speed wins:** no per-token regex engine (hand parsers for links,
  autolinks, emails, HTML tags); the emphasis mask is computed lazily
  and cached per paragraph; delimiter-list scans are replaced by an
  incrementally maintained flag; minimal allocation in the hot scan loop
  (charCodeAt-based, string slices only on flush).

## Files

- `parse.js` — the renderer (own authored code; marked's source was
  read for behavior reference only).
- `main.ts` — harness driver: reads `cases.json`, writes `html.json`.
- `package.json` — `{ "type": "module" }`.
- `LICENSE` — MIT.

## Verifying

Run the kit's practice corpus through `parse()` and compare against
`practice/reference/expected.json` (the kit's `grade-local` harness does
exactly this, running the entry through `main.ts` and the sealed
scorer): all 720 cases must match byte-for-byte before speed counts.
