# Player Voice Analyst eval

Input is a real hand-off from a Market Analyst run (test runs only, in gitignored `runs/`):
```
node --import tsx scripts/greenlight-handoff.ts runs/<market-analyst-run> --top 3
npm run agent -- player-voice-analyst --task-file runs/<market-analyst-run>/handoff-player-voice.md
npm run eval:player-voice -- runs/<player-voice-run>
```

## Mechanical checks (scripts/eval-player-voice.ts)
| Check | Pass bar |
|---|---|
| Every quote is verbatim in the cited review (cached text) | 100% |
| Every `sized_by` was actually run and matches a recount | 100% |
| Games read are comparables from the task | 100% |

## Human review
1. **Real wants?** Would a fan of these games recognize them, and are they unmet (not already in a hit)?
2. **Sized honestly?** Do the terms capture the theme, or cherry-pick a word that inflates or hides it?
3. **Actionable?** Could a small 2D game act on the wants, or are they about scale and polish?
4. **Useful hand-off?** Could the pitch writer use this together with the Market Analyst's gaps?
