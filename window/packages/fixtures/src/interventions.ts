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
};
