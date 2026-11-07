# Autonomous Game Studio — Hackathon Plan

_Naïve Autonomous Company Hackathon · YC SF · Sat Nov 7 – Sun Nov 8, 2026_
_Last updated: Fri Nov 6, 2026_

## 1. The pitch
A game studio run by agents. Given only a budget and the Steam catalog, the studio picks a game the market is missing, designs it, makes the art and code, tests it, markets it, and ships it, all in one weekend. A human handles only identity and payment setup, and each time he steps in, it's logged.

## 2. What "shipped" means by Sunday 11 AM
Steam can't release a new game this weekend. The store page review takes days, the Coming Soon page must be public for 2+ weeks, and there's a wait after paying the app fee. So the deliverables are:

| Target | Outcome by freeze | Why it matters to judges |
|---|---|---|
| **Studio site** (Naïve App, deployed by agents) | Playable web build, landing page, devlog | Real players, real link |
| **itch.io** | Live, downloadable, priced or pay-what-you-want | Real downloads or revenue |
| **Steam** | Store page complete and **submitted for review**; Windows build uploaded; release date set | Proves the game is Steam-ready, and the studio keeps going after the event |
| **Audience** | Devlog posts, social posts, streamer and curator outreach sent | The marketing team produced something measurable |

**Target: first public build by Sat midnight**, so overnight traffic produces real numbers to show on Sunday.

## 3. Ground rules
- **Everything about the game comes from agents during the window:** concept, design doc, style bible, art, code, store copy, and posts. Ty doesn't pre-write any of it.
- **Pre-built infrastructure only, and only if organizers allow it:** runner and harness, agent specs, Steam catalog dataset, studio window.
- **Every human action is logged** in the intervention ledger, with a reason.
- **Scope is 2D pixel art**, a small systemic genre, and no AI running inside the shipped game.

## 4. Runtime architecture
- **Hybrid runner for speed.** Hot worker agents run in Ty's own loop during the hackathon. The Eng team uses superfast non-Naïve inference providers; the event requires building with the Naïve SDK, not using it exclusively. Naïve-hosted agents are the production path, and each agent can be cut over individually.
- **The agent spec is the source of truth.** Each agent is defined in Naïve's shape: prompt, model, tools, skills, budget. Each spec has a runner flag, `local` or `naive`.
- **Hand-offs go through Naïve by default.** The board handles hand-offs and Files holds shared artifacts, for both local and hosted agents. That allows one-at-a-time cutover and keeps the logs real Naïve data. Local-only state is fine for tool data, caches, and run logs that no other agent depends on.
- **Naïve teams are flat**, one level deep, with at most 20 on a roster. Leads are leads by convention: card routing and `blocked_by` dependencies give the ordering. Engineering can be one Naïve node with a nested local loop inside it.
- **The local loop must supply its own:** human approval gates (send or spend), crash recovery, and spend tracking.
- **Cutover order:**
  1. The Studio Head moves to Naïve on Sat afternoon. It's low volume and gets cron and traces.
  2. Workers stay local overnight.
  3. On Sun morning, flip each worker that's stable. Eng may stay local on fast inference.
- **Reuse one sandbox (computer) per worker** instead of creating one per task.
- **Ledger as tools.** The studio site exposes MCP tools (`studio.log_decision`, `studio.record_intervention`), so the agents write their own decision log.

## 5. Org chart (flat Naïve roster, ~18 of 20 slots)

| Dept | Agent | Job | Model tier |
|---|---|---|---|
| — | **Studio Head** (coordinator) | Schedule, budget, scope cuts, milestone calls; logs every decision | Strong |
| Greenlight | **Market Analyst** | Embeds the Steam catalog, scores gaps, checks trend momentum | Mid |
| Greenlight | **Player Voice Analyst** | Mines reviews of comparable games for unmet wants | Fast |
| Greenlight | **Feasibility Critic** | Scores buildability and argues against each pitch; **has veto** | Strong |
| Design | **Game Director** | Design doc with must/should/could tiers; data schemas; balance | Strong |
| Design | **Level/Content Designer** | Levels, enemies, and items as data files | Fast |
| Art | **Art Director** | Style bible, anchor sheets, **approves or rejects every asset** | Strong |
| Art | **Sprite Artist** | Characters and enemies, cutout parts, animation | Mid |
| Art | **Environment & UI Artist** | Tilesets, UI, capsule art | Mid |
| Audio | **Audio** | Procedural sound effects, music | Fast |
| Eng | **Tech Lead** | Skeleton plus test hooks in hour one; **only one who merges** | Strong |
| Eng | **Gameplay Engineer ×2** | Feature tickets that don't touch the same scenes | Mid / fast |
| Eng | **Build & Release** | Web and Windows exports, itch upload via butler, Steam upload via steamcmd | Fast |
| QA | **QA Lead** | Triage, severity, release gate | Mid |
| QA | **Playtester** | Autoplay runs, visual checks, exploratory play | Mid + vision |
| Marketing | **Marketing Lead** | Hook, store pages, trailer, Steam tags | Mid |
| Marketing | **Community & Outreach** | Devlog, posts, streamer and curator emails | Fast |
| Ops | **Finance & Compliance** | Spend vs. budget; AI disclosure, asset licenses, platform rules | Fast |
| Ops | **Studio Historian** | Decision log, intervention ledger, build timeline, demo narrative | Fast |

After the pick, the Greenlight agents become **Market Intel** for Marketing: comparable games, tags, and the communities where those players gather.

## 6. Pipelines and gates
Each gate produces logged accept, reject, or cut events, which is demo material.

### Greenlight (Sat 1:00–2:30, hard timebox)
1. Market Analyst produces a ranked list of gaps. Score: demand × (1 − saturation) × feasibility × marketability.
2. Feasibility includes **animation load**, so games needing large move sets score low, plus genre fit. Systemic genres where content is data are preferred, such as survivors-likes and deckbuilders.
3. The lead synthesizes 3 pitches. The Feasibility Critic attacks each one. The Studio Head picks and logs why.

### Art
- **The style bible is locked before any generation:** sprite grid size, fixed palette, outline rule, light direction.
- **Deterministic post-processing in code:** snap to grid, lock to palette, add outline.
- **Animation fallback ladder:**
  1. Model-generated animation from the anchor sprite.
  2. Cutout animation: parts generated once, animated in the engine.
  3. Design around it: bob, flash, squash-and-stretch, particles.
- **Review gate:**
  - Programmatic checks: palette share, size, frame-to-frame drift.
  - A vision model reviews a **contact sheet** of all frames next to the anchor.
  - Regenerate up to a cost cap, then step down the fallback ladder.
- Tools to test: PixelLab and Retro Diffusion APIs.

### Engineering
- **Hour-one test hooks:** state dump as JSON, seed control, time scale, autoplay mode, screenshot command.
- Only the Tech Lead merges. Tickets are scoped so two engineers never edit the same scene.

### QA (release gate)
1. **Engine tests:** headless; load every scene; validate every data file against its schema.
2. **Autoplay bot** at 10x with fixed seeds. Invariants: no errors, run completes, no softlock, entity counts bounded, no negative resources, frame rate holds.
3. **Visual checks at key events:**
   - Diff against the previous build.
   - Programmatic: missing textures, blank frames, offscreen sprites, text overflow.
   - Vision model compares screenshots against the expected scene-tree state.
4. **Exploratory LLM playtester**, time-boxed: menus, onboarding, "is this confusing?"
5. **Fun gets a human signal.** Other teams playtest on Sun morning, logged as a human input. Telemetry covers run length, death causes, and pick rates.

### Publishing
- Compliance signs off on every external post and page: Steam AI disclosure, asset licenses, subreddit self-promotion and AI rules.
- Anything that sends messages or spends money goes through an approval gate, and every approval is logged.

## 7. Timeline

| Time | Milestone | Owner |
|---|---|---|
| Sat 1:00 | Studio boots; Ty presses start (logged) | Studio Head |
| 1:00–2:30 | Greenlight → **game picked** | Greenlight |
| 2:30–3:30 | Design doc and schemas; style bible and anchor sprites; skeleton with test hooks; positioning draft | Design, Art, Eng, Mktg |
| ~3:30 | Studio Head moves to Naïve-hosted | Ty (logged) |
| 3:30–7:00 | Core loop; art pipeline running; QA layers 1–2 online | All |
| **7:00** | **Playable vertical slice** | Tech Lead |
| 7:00–12:00 | Content breadth; studio site live; itch page draft; Steam assets draft | All |
| **12:00 AM** | **First public build** (site + itch) | Build & Release |
| Overnight | Content, balance, and QA loops; Studio Head cron every 2h for triage and cuts | Studio Head |
| Sun 7:00 | Feature freeze; polish and bug-fix only | Studio Head |
| 7:00–9:30 | Trailer from autoplay captures; Steam page submitted; Windows build uploaded; marketing push | Mktg, Release |
| 9:30–10:30 | Release candidate passes QA gate; final itch and site build | QA, Release |
| **11:00** | **Freeze** | — |
| 1:00 PM | Present | Ty |

## 8. Demo (about 5 min)
1. **Trailer** (30s), made by the studio.
2. **Play it:** a QR code to the studio site, plus itch stats (views, downloads, $).
3. **Greenlight decision:** the gap map, the 3 pitches, the critique, the pick.
4. **The studio at work:** build timeline, art gallery with rejects, QA findings with screenshots, Studio Head's cuts ("cut co-op; 3 crash bugs open at hour 14").
5. **Human-intervention ledger and spend:** the count, each entry, and why.
6. **It keeps running:** Steam page in review, release date set, weekly patch cycle scheduled, the studio packaged as a Naïve blueprint.

Fallback: a recorded run in case live wifi or builds fail.

## 9. Success metrics
- Human interventions during the window (target: under 10, all logged)
- Time to first public build
- Players and downloads, $ revenue, outreach replies
- Builds shipped; bugs found by QA vs. fixed
- Total spend; spend per build

## 10. Risks

| Risk | Mitigation |
|---|---|
| Godot can't render in the sandbox (QA screenshots, trailer) | Spike tonight; fallback is local rendering or a web export in a headless browser |
| Art inconsistency | Locked style bible, palette lock in code, fallback ladder, contact-sheet gate |
| Greenlight picks something unbuildable | Feasibility veto plus a hard 2:30 timebox |
| Scope blowout overnight | Must/should/could tiers; Studio Head cuts on each cron cycle; 7 AM freeze |
| Local runner crashes overnight | Crash recovery, state on the Naïve board, runbook, phone alerts |
| Merge conflicts in scene files | Single merger; tickets scoped by scene |
| Zero traffic | Public build by midnight; communities from Market Intel; other teams playtest |
| Posts removed under subreddit AI rules | Compliance check; prefer devlog and owned channels |
| Spend runaway | Per-agent Naïve budgets plus tracked local spend; kill switch |

## 11. Open decisions
- [ ] **Engine:** Godot 4 by default (text scenes, CLI export, desktop + web builds). Fallback is Phaser plus a desktop wrapper. Decide after the rendering spike.
- [ ] Organizer ruling on pre-built harness, dataset, and studio window
- [ ] Solo, or recruit at kickoff (art or marketing help would be logged as human input)
- [ ] Weekend budget (inference + art APIs + Naïve)
- [ ] Which fast inference provider and models per tier

## 12. Tonight / Sat morning checklist
- [ ] RSVP confirmed
- [ ] Steamworks onboarding: identity, tax, bank, $100 fee (starts the clocks)
- [ ] itch.io account with payouts enabled; butler installed
- [ ] Naïve API key; studio company created; **rehearse one local → Naïve flip**
- [ ] Spike: engine renders screenshots in a Naïve computer
- [ ] Spike: art pipeline acceptance rate on 3 test characters
- [ ] Inference provider and art API keys, each with spend caps
- [ ] Steam catalog dataset downloaded (if allowed)
- [ ] Agent specs written; runner tested end to end on a toy task
- [ ] Studio window skeleton (if allowed)
- [ ] Laptop, charger, phone alerts set up

## Sources
- Steamworks: Release Process — https://partner.steamgames.com/doc/store/releasing
- Steamworks: Coming Soon — https://partner.steamgames.com/doc/store/coming_soon
- Steam Direct — https://partner.steamgames.com/steamdirect
- Naïve docs: Coordinator — https://vetta.sh/docs/team/coordinator.md
- Naïve docs: Apps — https://vetta.sh/docs/api/apps.md
