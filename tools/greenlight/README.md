# tools/greenlight

Deterministic scoring for the Greenlight pipeline (agents judge; this code computes).
- `score.ts`: gap score = demand_pct × (1 − supply_pct) × feasibility × marketability.
- `feasibility.ts`: the Critic's sub-scores → weighted feasibility; verdict rules (veto / pass with
  cuts / pass) from blocker and major attacks, must-list hours vs. a 10h budget, and the pitch's
  declared animation frames (> 160 needs cuts, > 320 is a veto).
