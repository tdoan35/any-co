import { Gamepad2 } from "lucide-react";
import { Face, agentOf } from "@/components/weave/parts";
import { useRegistry } from "@/lib/registry";
import { cn } from "@/lib/utils";
import { SectionHead } from "./studio-ui";

/** One handoff. Several ids started together. `you` is the operator. */
type Step = { ids: string[] };

/** Order of first runs on Nov 7, mapped onto the current spec names. */
const PICK: Step[] = [
  { ids: ["market-analyst", "player-voice-analyst"] },
  { ids: ["pitch-writer"] },
  { ids: ["feasibility-critic"] },
  { ids: ["greenlight-chair"] },
];

const BUILD: Step[] = [
  { ids: ["tech-lead"] },
  { ids: ["game-design-director"] },
  { ids: ["art-director"] },
  { ids: ["gameplay-engineer-a", "level-content-designer"] },
  { ids: ["sprite-artist", "env-ui-artist"] },
  { ids: ["you:art"] },
  { ids: ["studio-head"] },
  { ids: ["qa-lead", "playtester"] },
  { ids: ["gameplay-engineer-b"] },
];

const SHIP: Step[] = [
  { ids: ["marketing-lead"] },
  { ids: ["finance-compliance"] },
  { ids: ["community-outreach", "studio-historian"] },
  { ids: ["build-release"] },
  { ids: ["you:itch"] },
];

const FALLBACK: Record<string, string> = {
  "market-analyst": "Market Analyst",
  "player-voice-analyst": "Player Voice",
  "pitch-writer": "Pitch Writer",
  "feasibility-critic": "Feasibility Critic",
  "greenlight-chair": "Greenlight Chair",
  "tech-lead": "Tech Lead",
  "game-design-director": "Game Design Director",
  "art-director": "Art Director",
  "gameplay-engineer-a": "Gameplay Engineer A",
  "level-content-designer": "Level Designer",
  "sprite-artist": "Sprite Artist",
  "env-ui-artist": "Env & UI Artist",
  "studio-head": "Studio Head",
  "qa-lead": "QA Lead",
  "marketing-lead": "Marketing Lead",
  "playtester": "Playtester",
  "finance-compliance": "Compliance",
  "community-outreach": "Outreach",
  "studio-historian": "Historian",
  "gameplay-engineer-b": "Gameplay Engineer B",
  "build-release": "Build & Release",
  "you:itch": "Approve the itch upload",
  "you:art": "Sign off the art",
};

const JOB: Record<string, string> = {
  "market-analyst": "Scores gaps in the Steam catalog.",
  "player-voice-analyst": "Finds what players of similar games want.",
  "pitch-writer": "Writes three pitches the studio could build.",
  "feasibility-critic": "Attacks each pitch and can veto one.",
  "greenlight-chair": "Picks the game and logs the reason.",
  "tech-lead": "Builds the skeleton and merges every branch.",
  "game-design-director": "Writes the design doc and the must list.",
  "art-director": "Locks the look and judges every asset.",
  "gameplay-engineer-a": "Builds one feature track.",
  "level-content-designer": "Writes levels, enemies, and items as data.",
  "sprite-artist": "Draws characters and enemies.",
  "env-ui-artist": "Draws tiles, UI, and the store capsule.",
  "studio-head": "Assigns the next cards and cuts scope.",
  "qa-lead": "Runs the release gate on the build.",
  "marketing-lead": "Writes the hook, store page, and trailer plan.",
  "playtester": "Plays the build and reports what is confusing.",
  "finance-compliance": "Checks spend and the rules before anything goes out.",
  "community-outreach": "Drafts the devlog and the outreach posts.",
  "studio-historian": "Writes the decision log.",
  "gameplay-engineer-b": "Builds the other feature track.",
  "build-release": "Exports the build and pushes it to itch.",
  "you:itch": "A real itch upload waits for your yes.",
  "you:art": "Batch art waits until you accept the anchors.",
};

function faceId(id: string) {
  return id.startsWith("you") ? "you" : id;
}

function labelOf(id: string) {
  if (id.startsWith("you")) return FALLBACK[id];
  const known = agentOf(id);
  return known.role === "Unknown agent" ? (FALLBACK[id] ?? known.name) : known.name;
}

const chip = "flex h-20 w-72 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-zinc-950";

function Person({ id, onOpen }: { id: string; onOpen?: (id: string) => void }) {
  const you = id.startsWith("you");
  const name = labelOf(id);
  const job = JOB[id];
  const tone = you ? "bg-[#b8e5cf]" : "bg-white/70";
  const body = (
    <>
      {you ? (
        <span className="flex size-10 shrink-0 items-center justify-center self-center rounded-lg bg-foreground text-background" role="img" aria-label="any-co game studio">
          <Gamepad2 className="size-5" />
        </span>
      ) : (
        <Face id={faceId(id)} size="size-10" live className="self-center" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-tight">{name}</span>
        {job && <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-zinc-600">{job}</span>}
      </span>
    </>
  );
  if (you || !onOpen) return <div className={cn(chip, tone)}>{body}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      aria-label={name}
      className={cn(chip, tone, "outline-none hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-ring")}
    >
      {body}
    </button>
  );
}

const arrowStroke = { fill: "none" as const, stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function Handoff() {
  return (
    <svg viewBox="0 0 16 28" className="my-1 h-7 w-4 shrink-0 text-foreground/40" aria-hidden {...arrowStroke}>
      <path d="M8 1.5V17" />
      <path d="M4 13.5 8 21 12 13.5" />
    </svg>
  );
}

/** Two w-72 chips plus the gap between them. Each curve leaves a chip and arrives pointing down. */
const PAIR = 18 * 16 * 2 + 8;

function ForkArrows() {
  const mid = PAIR / 2;
  const left = (18 * 16) / 2;
  const right = PAIR - left;
  const tipY = 46;
  const lx = mid - 16;
  const rx = mid + 16;
  const curve = (from: number, to: number) => `M ${from} 1 Q ${to} 16 ${to} ${tipY - 8}`;
  const head = (x: number) => `M ${x - 5} ${tipY - 9} L ${x} ${tipY} L ${x + 5} ${tipY - 9}`;
  return (
    <svg viewBox={`0 0 ${PAIR} 52`} className="mt-1 h-12 shrink-0 text-foreground/40" style={{ width: PAIR }} aria-hidden {...arrowStroke}>
      <path d={curve(left, lx)} />
      <path d={head(lx)} />
      <path d={curve(right, rx)} />
      <path d={head(rx)} />
    </svg>
  );
}

function Chain({ steps, fork, onOpen }: { steps: Step[]; fork?: boolean; onOpen?: (id: string) => void }) {
  const [first, ...rest] = steps;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center">
      {fork && first && (
        <div className="flex flex-col items-center">
          <div className="flex flex-nowrap items-center justify-center gap-2">
            {first.ids.map((id) => <Person key={id} id={id} onOpen={onOpen} />)}
          </div>
          <ForkArrows />
        </div>
      )}
      {(fork ? rest : steps).map((step, i, list) => (
        <div key={step.ids.join("-")} className="flex w-full flex-col items-center">
          <div className="flex flex-wrap items-center justify-center gap-2">
            {step.ids.map((id) => <Person key={id} id={id} onOpen={onOpen} />)}
          </div>
          {i < list.length - 1 && <Handoff />}
        </div>
      ))}
    </div>
  );
}

/** The Nov 7 work order. Each chip is the person, then their name, then one line on the job. */
export function FlowView({ onOpenAgent }: { onOpenAgent?: (id: string) => void }) {
  useRegistry();
  return (
    <div className="flex flex-col gap-10">
      <section>
        <SectionHead title="Who picks the game" hint="Market Analyst and Player Voice each hand their research to the Pitch Writer. The chair logs the pick." />
        <Chain steps={PICK} fork onOpen={onOpenAgent} />
      </section>
      <section>
        <SectionHead title="Who builds" hint="Tech Lead starts the skeleton. People on the same line started in the same minute." />
        <Chain steps={BUILD} onOpen={onOpenAgent} />
      </section>
      <section>
        <SectionHead title="Who ships" hint="Store copy, outreach, and the itch upload. A real upload waits for your yes." />
        <Chain steps={SHIP} onOpen={onOpenAgent} />
      </section>
    </div>
  );
}
