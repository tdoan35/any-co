// The studio's cast: which of Fabric's portraits each studio agent wears in the window.
// Applied when the registry arrives (lib/registry.ts) and only to agents the API sent without an
// `avatar`, so once the adapter returns avatars itself this table is ignored.
// Faces mean "named lead or checkpoint actor"; hands-on staff keep the initial circle in their
// department colour. Studio UI art only: never part of the game.
import type { Registry, SpriteAvatar, StudioProfile } from "@fabric/contracts";

const still = (persona: string): SpriteAvatar => ({ still: `/agents/${persona}-happy.webp` });

/** Dana is the only animated character: idle loop, and a working loop while a run is in flight. */
export const DANA: SpriteAvatar = {
  still: "/dana/happy-idle-still.webp",
  strip: "/dana/happy-idle-strip.webp",
  frames: 73,
  fps: 12,
  working: { strip: "/dana/working-strip.webp", frames: 73, fps: 12 },
};

/** Studio agent name (agents/<name>/spec.ts) -> portrait. Agents not listed keep the initial circle. */
export const CAST: Readonly<Record<string, SpriteAvatar>> = {
  "studio-head": DANA,
  // greenlight
  "market-analyst": still("lila"),
  "player-voice-analyst": still("megan"),
  "feasibility-critic": still("carlos"),
  "greenlight-chair": still("elliot"),
  // design: the Game Director wears one face in both modes
  "game-director": still("diego"),
  "game-director-design": still("diego"),
  // art / eng / qa
  "art-director": still("maya"),
  "tech-lead": still("jonah"),
  "build-release": still("bea"),
  "qa-lead": still("sana"),
  // marketing / ops
  "marketing-lead": still("nikhil"),
  "community-outreach": still("nadine"),
  "finance-compliance": still("rosa"),
  "studio-historian": still("yuki"),
};

/** Empty-chat greeting pose, shown instead of the idle loop before a thread starts. */
const GREETING: Readonly<Record<string, string>> = { "studio-head": "/dana/waving.png" };
export const greetingStill = (agentId: string): string | undefined => GREETING[agentId];

const dress = (profiles: StudioProfile[]) => profiles.map((p) => {
  const avatar = p.agent.avatar ?? CAST[p.agent.id];
  return avatar === p.agent.avatar ? p : { ...p, agent: { ...p.agent, avatar } };
});

/** The registry with cast portraits filled in where the API sent none. */
export function withCastAvatars(r: Registry): Registry {
  return { ...r, agents: dress(r.agents), communityAgents: dress(r.communityAgents) };
}
