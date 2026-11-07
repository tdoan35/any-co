# Market Analyst eval

Test runs are throwaway: they live in gitignored `runs/` and are wiped before Sat 1 PM, so
nothing from them becomes game content.

```
npm run agent -- market-analyst --task-file agents/market-analyst/eval/task.md [--model id]
npm run eval:market-analyst -- runs/<run_id>      # writes runs/<run_id>/eval.json
```

## Mechanical checks (scripts/eval-market-analyst.ts)
| Check | Pass bar |
|---|---|
| Evidence matches a fresh `niche` query, field by field | 100% (any mismatch = made-up or misquoted) |
| Comparables exist, carry every gap tag, review counts match | ≥ 95% |
| Momentum sources appear in this run's search/fetch results | 100% |
| Distinct segments (no same tag set; Jaccard < 0.67) | all pairs |
| Momentum checked (direction ≠ unknown) | ≥ half of gaps |
| Map-sourced gaps (`map.region_id` opened with `gapmap_region` in the run) | ≥ 2 |
| Map probes match a re-probe (novelty ±0.02, same region) | all |
| Spend / turns | under budget; note for model comparison |

Final ranking = `tools/greenlight/score.ts` on recomputed percentiles × the agent's judgments.

## Human review (read output.json and skim transcript.jsonl)
1. **Real gaps?** Would someone who follows Steam agree demand exceeds supply here, or is it a
   small-sample fluke or a hit-driven market?
2. **Fits the studio?** Are the feasibility scores honest about animation load and content type?
3. **Momentum real?** Do the cited pages actually say what the summary claims?
4. **Useful to the next agent?** Could the pitch writer and Feasibility Critic work from this alone?
5. **Process:** sensible exploration, or did it grab the top rows and stop? Any wasted calls?

Record verdicts and prompt changes in the run's notes. Compare models on the same task.
