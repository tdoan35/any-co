# Greenlight Chair eval

```
node --import tsx scripts/greenlight-handoff.ts --pick runs/greenlight-<stamp>
npm run agent -- greenlight-chair --task-file runs/greenlight-<stamp>/handoff-pick.md
npm run eval:greenlight-chair -- runs/<greenlight-chair-run>
```
Mechanical: the pick survived the Critic; the adopted must list copies the Critic's estimates and
fits 10h of engineering (no art/QA items in it; those go in `art_and_qa`); every other pitch has a rejection reason; a `greenlight.pick` decision is in the ledger.
Human review: is the rationale grounded in the evidence (not just the Critic's score)? Are the
deferrals the right ones? Would you defend this pick to a judge?
