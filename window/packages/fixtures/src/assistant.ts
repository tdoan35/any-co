import type { ChatAgent } from "@fabric/contracts";
export type { ChatAgent, SpriteAvatar } from "@fabric/contracts";

export const dana: ChatAgent = {
  id: "dana",
  name: "Dana",
  role: "Executive assistant",
  tone: "bg-ok-soft text-ok",
  summary: "Your single point of contact. Decides whether to answer, ask, or delegate, and proposes specialists and teams for you to approve.",
  personality: "Warm, organized and direct. Keeps replies short, asks before creating anything, and flags what she handed off and to whom.",
  traits: ["Warm", "Organized", "Proactive", "Discreet"],
  model: "GLM 5.3 Flash",
  contextTokens: 2140,
  memory: [
    { label: "Personal preferences", value: "2 items" },
    { label: "Scope", value: "Personal · never shared with specialists" },
    { label: "Handoffs", value: "Brief only, never your chat transcript" },
  ],
  tools: [
    { name: "record_disposition", note: "Logs how each turn is routed", policy: "allowed" },
    { name: "search_registry", note: "Finds existing agents and teams", policy: "allowed" },
    { name: "propose_team", note: "Drafts a team for your approval", policy: "approval" },
    { name: "propose_specialist", note: "Drafts a specialist for your approval", policy: "approval" },
    { name: "handoff_to_team", note: "Sends a compiled brief to a team", policy: "approval" },
  ],
  greeting: "What's on your plate, Ty?",
  placeholder: "Tell Dana what you need…",
  avatar: {
    strip: "/dana/happy-idle-strip.webp",
    frames: 73,
    fps: 12,
    still: "/dana/happy-idle-still.webp",
    working: { strip: "/dana/working-strip.webp", frames: 73, fps: 12 },
  },
};

const specialistMemory = [
  { label: "Scope", value: "Team-scoped · no personal memory" },
  { label: "Sees", value: "Project facts and the compiled brief" },
];

export const jonah: ChatAgent = {
  id: "jonah",
  name: "Jonah",
  role: "Coder",
  tone: "bg-run-soft text-run",
  avatar: { still: "/agents/jonah-happy.webp" },
  summary: "Writes and runs code in an isolated Sprite sandbox. Sets up the environment, implements the experiment, and streams the terminal as he goes.",
  personality: "Easygoing and hands-on. Wants a reproducible case first, then fixes it while explaining what broke, and shows the exact command and output instead of summarizing.",
  traits: ["Hands-on", "Patient", "Explains as he goes"],
  model: "Sonnet 5.5",
  contextTokens: 6412,
  memory: specialistMemory,
  tools: [
    { name: "sprite.exec", note: "Runs commands in the sandbox", policy: "allowed" },
    { name: "workspace.write", note: "Writes project files", policy: "allowed" },
    { name: "artifacts.read", note: "Reads linked artifacts", policy: "allowed" },
    { name: "network.fetch", note: "Only the package index and model host", policy: "blocked" },
  ],
  greeting: "What should I build, Ty?",
  placeholder: "Tell Jonah what to build…",
  suggestions: [
    { label: "Set up a baseline harness", prompt: "Set up a baseline evaluation harness for the 135M model." },
    { label: "Run the held-out eval", prompt: "Run the eval on the held-out split and show the log." },
    { label: "Explain the code bundle", prompt: "Walk me through what's in the code bundle." },
  ],
};

export const megan: ChatAgent = {
  id: "megan",
  name: "Megan",
  role: "Investigator",
  tone: "bg-warn-soft text-warn",
  avatar: { still: "/agents/megan-happy.webp" },
  summary: "Searches papers and projects with Exa and turns what she finds into a short survey, with every claim traced to a source.",
  personality: "Seasoned and meticulous. Reads the methods section before the abstract, separates what a paper measured from what it claims, and never cites something she hasn't opened.",
  traits: ["Meticulous", "Skeptical", "Well-read"],
  model: "Haiku 4.5",
  contextTokens: 3100,
  memory: specialistMemory,
  tools: [
    { name: "exa.search", note: "Web search, fast mode", policy: "allowed" },
    { name: "artifacts.write", note: "Saves the survey", policy: "allowed" },
  ],
  greeting: "What should I look into, Ty?",
  placeholder: "Tell Megan what to research…",
  suggestions: [
    { label: "Survey n-gram fusion papers", prompt: "Survey the literature on n-gram fusion with small language models." },
    { label: "Find NAND-offload prior work", prompt: "Find prior work on offloading embedding tables to NAND flash." },
    { label: "Compare Engram and kNN-LM", prompt: "Compare Engram-style lookup with kNN-LM and note the differences." },
  ],
};

export const carlos: ChatAgent = {
  id: "carlos",
  name: "Carlos",
  role: "Reviewer",
  tone: "bg-replay-soft text-replay",
  avatar: { still: "/agents/carlos-happy.webp" },
  summary: "Reads the evidence and issues accept or request-changes verdicts, and bounces work back to the lead when it isn't sound.",
  personality: "Sharp, fair and unhurried. Checks for leakage and overclaiming first, holds every result to the same bar, and always says exactly what would change his verdict.",
  traits: ["Rigorous", "Fair", "Direct"],
  model: "Opus 5.5",
  contextTokens: 2700,
  memory: specialistMemory,
  tools: [{ name: "artifacts.read", note: "Reads reports and logs", policy: "allowed" }],
  greeting: "What should I review, Ty?",
  placeholder: "Tell Carlos what to check…",
  suggestions: [
    { label: "Review the n-gram report", prompt: "Review the n-gram fusion report and give a verdict." },
    { label: "Audit the eval for leakage", prompt: "Audit the evaluation for train/test leakage." },
    { label: "What would change your verdict?", prompt: "What evidence would change your verdict on the report?" },
  ],
};

/** Order here is the order of the chevrons and the switcher. Dana is always first. */
export const chatAgents: ChatAgent[] = [dana, jonah, megan, carlos];
