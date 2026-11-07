# Game Director eval (Greenlight pitch mode)

```
node --import tsx scripts/greenlight-handoff.ts runs/<ma-run> --voice runs/<pv-run>
npm run agent -- game-director --task-file runs/<pv-run>/handoff-pitches.md
npm run eval:game-director -- runs/<gd-run>
```
Mechanical: gap labels and wants copied exactly from the task, comparables are real, 2+ gaps covered.
Human review: is each hook concrete and GIF-able? Is the must list really minimal? Do the three differ?
