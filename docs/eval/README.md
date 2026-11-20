# Correction evaluations

Saved results of `npm run eval` (strategy A, one call, vs B, one call + a check, scored on the same first call).
The dataset is `shared/eval/corrections-v1.json`; the method, results and caveats are in `docs/LEARNING.md`.

| File | Prompt | Notes |
|---|---|---|
| `2026-11-20-run1-balanced.json` | tutor-v1 | 28 of 148 turns failed (rate limits, labels outside the list) |
| `2026-11-20-run2-balanced.json` | tutor-v2 | Not valid for comparison: the check's examples came from the dataset |
| `2026-11-20-run3-balanced.json` | tutor-v3 | **The result to use** |

All three were re-scored with the final scorer (`npm run eval -- --rescore <file>`).
