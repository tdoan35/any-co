# tools/catalog

Steam catalog as a typed SQLite database plus fixed queries for the Greenlight agents.
Stdlib Python 3.9+, no installs.

```
python3 tools/catalog/prep.py         # CSV -> data/catalog.sqlite (~6 s, ~340 MB)
python3 tools/catalog/smoke_test.py   # fixture-based test, no dataset needed
python3 tools/catalog/query.py --help # commands and metric definitions
```

## Commands (all print JSON)
| Command | Use |
|---|---|
| `meta` | Snapshot date, tag coverage end, analysis window, baseline stats |
| `find-tags --q TEXT` | Exact tag spellings (tags are case-sensitive) |
| `tags [--min N]` | Every tag ranked by opportunity |
| `pairs [--base TAG] [--min N]` | Tag pairs ranked by opportunity; broad tags (>25% of games) skipped unless `--keep-broad` |
| `niche --tags A,B` | Profile of games with all tags: window stats, yearly trend, top games |
| `games --tags A,B [--since DATE]` | Comparable games with tags and a short description |
| `game --appid N \| --name TEXT` | One game (exact name wins over substring) |

## Metrics
Computed in code, so agents interpret numbers instead of inventing them. Full definitions
are in `query.py`'s docstring.
- **window:** the 24 months of releases ending at `tag_coverage_end` (currently 2023-06 → 2025-05).
- **supply:** releases in the window. **traction:** share with ≥50 reviews. **hit_rate:** share with ≥500.
- **demand:** traction shrunk toward the baseline (K=20), so tiny niches don't top the list on luck.
- **opportunity** = demand percentile × (1 − supply percentile), ranked within the result set.
  Feasibility and marketability aren't included; agents score those.

## Known limits
- Tags and reviews are missing for most releases after 2025-05 (upstream gap, in the JSON too).
  Anything after that needs live Steam data.
- At the `--min` supply floor, the supply percentile is ~0, so opportunity favors small niches.
  Raise `--min` to see established ones.
- Review count is a proxy for sales. Owner ranges are too coarse to rank by.
