// The studio board (T4): one interface, local and Naïve backends, chosen by env.
export * from "./types.ts";
export { LocalBoard, DEFAULT_BOARD_FILE, healed } from "./local.ts";
export { NaiveBoard } from "./naive.ts";
import type { NaiveClient } from "../providers.ts";
import path from "node:path";
import type { Board } from "./types.ts";
import { LocalBoard } from "./local.ts";
import { NaiveBoard } from "./naive.ts";

/** STUDIO_BOARD=local|naive (default local). Naive needs NAIVE_API_KEY and STUDIO_BOARD_REF
 *  (the Studio Head agent's brd_ or agt_ id) — the board owned by that agent is the studio's.
 *  `runsDir` (optional) is where the local board file lives when STUDIO_BOARD_FILE is unset,
 *  so a server or test with its own runs/ stays off the repo's board. */
export function boardFromEnv(naive: NaiveClient | null, runsDir?: string): Board {
  const kind = process.env.STUDIO_BOARD ?? "local";
  if (kind === "naive") {
    const ref = process.env.STUDIO_BOARD_REF;
    if (!naive || !ref) throw new Error("STUDIO_BOARD=naive needs a Naïve client (NAIVE_API_KEY) and STUDIO_BOARD_REF (brd_ or agt_ id)");
    return new NaiveBoard(naive, ref);
  }
  if (kind !== "local") throw new Error(`STUDIO_BOARD must be "local" or "naive", got "${kind}"`);
  return new LocalBoard(process.env.STUDIO_BOARD_FILE ?? (runsDir !== undefined ? path.join(runsDir, "board.jsonl") : undefined));
}
