# Pitch Writer eval (Greenlight pitches)

```
node --import tsx scripts/greenlight-handoff.ts runs/<ma-run> --voice runs/<pv-run>
npm run agent -- pitch-writer --task-file runs/<pv-run>/handoff-pitches.md
npm run eval:pitch-writer -- runs/<pw-run>
```
Mechanical: gap labels copied exactly from the task; each want is a finding id in the task (`W3`) or its whole
statement copied exactly (shortened copies fail); comparables are real; 2+ gaps covered.
Human review: is each hook concrete and GIF-able? Is the must list really minimal? Do the three differ?
