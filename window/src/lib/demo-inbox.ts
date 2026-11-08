// Demo-only inbox item (Ty's call for the Nov 8 demo): Greenlight asks to start a third game.
// Hardcoded in the window, never in the approvals queue or the ledger. Approving or declining only
// changes the window's own state (weave.resolve is local), so it can't start anything real.
// The pitch is not invented here: every field is copied from "Gravelight", the runner-up the studio's
// own agents wrote and scored in Studio 2's Greenlight (game director run 20261107-210956, chair run
// 20261107-211312: tied with Soul Shift at 0.673). Turn it off with VITE_DEMO_INBOX=0.
import type { InboxItem } from "@fabric/contracts";

export const DEMO_INBOX = import.meta.env.VITE_DEMO_INBOX !== "0";
export const DEMO_NEW_GAME_ID = "demo-greenlight-gravelight";

/** Fixed once per page load, so the item keeps its place and age across weave refreshes. */
const askedAt = new Date(Date.now() - 4 * 60_000).toISOString();

export function demoNewGameItem(): InboxItem {
  return {
    id: DEMO_NEW_GAME_ID,
    kind: "approval",
    agentId: "greenlight-chair",
    project: "Studio",
    run: { label: "Greenlight · Studio 2", href: "/runs/20261107-211312-greenlight-chair" },
    title: "Greenlight wants to start a third game: Gravelight",
    brief: "Greenlight's new game",
    at: askedAt,
    unread: true,
    blocking: { step: "Greenlight", agentId: "greenlight-chair", since: askedAt },
    why: "Starting a new game commits the studio's build budget and a full team, so Greenlight waits for your yes before handing it to Design.",
    tool: "greenlight_pick",
    policy: "approval",
    policyNote: "A new game always asks first",
    gated: "Starting a new game commits studio budget",
    preview: [
      { label: "Pitch", value: "A plague-doctor bullet heaven in a Diablo-1-dark valley: 12-minute hunts, upgrades that visibly reshape your kit, and named vampire lords whose deaths push the story at the graveyard hub." },
      { label: "Market gap", value: "Gothic bullet-heaven survivors-like" },
      { label: "Greenlight score", value: "0.673, tied with Soul Shift in Studio 2's pick" },
      { label: "Comparables", value: "Halls of Torment · Nunholy · Renfield: Bring Your Own Blood" },
      { label: "Session", value: "About 15 minutes" },
    ],
    excerpt: "A pixel plague-doctor wades through 300 bats as a leech-flask bursts into a spiraling acid fog, then Countess Vellum flashes red, winds up a blood-moon slash, and the screen dims to her name card.",
    actions: [
      {
        id: "approve", label: "Greenlight it", variant: "primary",
        effect: { outcome: "Greenlit: Gravelight", event: "You greenlit Gravelight. The Game Design Director starts the design doc." },
      },
      {
        id: "deny", label: "Not now", variant: "outline",
        effect: { outcome: "Not now", event: "You passed on Gravelight for now; it stays on Greenlight's shortlist." },
      },
    ],
  };
}
