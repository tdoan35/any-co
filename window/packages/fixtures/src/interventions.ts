// Intervention fixtures (goal 3): demo data for the autonomy counter — mock mode and
// stories. Live counts come from the adapter's ledger (`GET /api/interventions`), one
// entry per human decision since the event start. The shape mirrors the client schema in
// src/lib/api/http.ts (fixtures cannot import app code).
export interface InterventionEntry {
  ts: string;
  who: string;
  action: string;
  reason: string;
  category?: string;
}
export interface InterventionsFixture {
  eventStart: string;
  count: number;
  by_category?: Record<string, number>;
  entries: InterventionEntry[];
  /** Calls the agents made on their own, from the same ledger. */
  decisions?: {
    count: number;
    by_agent: Record<string, number>;
    entries: Array<{ ts: string; agent: string; topic: string; decision: string; rationale: string }>;
  };
}

export const interventionsFixture: InterventionsFixture = {
  eventStart: "2026-11-07T21:00:00.000Z",
  count: 23,
  by_category: { harness: 12, steering: 8, account: 2, approval: 1 },
  entries: [
    {
      ts: "2026-11-08T03:41:00.000Z", who: "operator", category: "steering",
      action: "Picked option 2 for the capsule brief: hero forward, no text",
      reason: "Ty's call via EA; art director unblocked",
    },
    {
      ts: "2026-11-08T02:55:00.000Z", who: "operator", category: "harness",
      action: "Merged pr-2 (adapter fixes) and restarted the studio window",
      reason: "Keeps the demo build current",
    },
    {
      ts: "2026-11-08T01:20:00.000Z", who: "operator", category: "account",
      action: "Rotated the art provider key after a billing warning",
      reason: "Spend cap safety",
    },
    {
      ts: "2026-11-08T00:05:00.000Z", who: "operator", category: "approval",
      action: "Approved itch_push for the vertical slice",
      reason: "Build passed the release gate",
    },
    {
      ts: "2026-11-07T23:30:00.000Z", who: "operator", category: "steering",
      action: "Told the Studio Head to drop the roguelike pitch",
      reason: "Scope too large for the freeze",
    },
  ],
  decisions: {
    count: 41,
    by_agent: { "studio-head": 17, "tech-lead": 14, "qa-lead": 10 },
    entries: [
      {
        ts: "2026-11-08T03:50:00.000Z", agent: "studio-head", topic: "studio.cycle",
        decision: "Split the blocked release check into two smaller cards",
        rationale: "The first run hit its budget with no verdict; the smaller cards fit inside it",
      },
      {
        ts: "2026-11-08T02:10:00.000Z", agent: "tech-lead", topic: "scope.cut",
        decision: "Deferred the settings menu to after the freeze",
        rationale: "Two engineer-hours left; the core loop matters more",
      },
      {
        ts: "2026-11-08T01:00:00.000Z", agent: "qa-lead", topic: "qa.verdict",
        decision: "Held the build: determinism check failed on seed 7",
        rationale: "A release candidate needs a recorded green gate",
      },
    ],
  },
};
