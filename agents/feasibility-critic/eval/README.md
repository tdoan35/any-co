# Feasibility Critic eval

```
node --import tsx scripts/greenlight-handoff.ts --pitches runs/<game-director-run>
npm run agent -- feasibility-critic --task-file runs/<game-director-run>/handoff-critic.md
npm run eval:feasibility-critic -- runs/<critic-run>
```
Mechanical: every pitch reviewed, every `must` item estimated, every attack targets a real field.
Verdicts come from `tools/greenlight/feasibility.ts`.

Human review: are the hour estimates believable for an agent team? Are blockers real blockers?
Is anything rubber-stamped (no majors at all) or reflexively vetoed? Is the strongest point fair?
