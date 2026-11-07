import type { Organization, StudioTeam } from "@fabric/contracts";
export type { OrgHandoff, Organization, StudioTeam, TeamMember, WorkflowStage } from "@fabric/contracts";

export const studioTeams: StudioTeam[] = [
  {
    id: "research",
    name: "Research Team",
    tagline: "Tests your research ideas end to end",
    purpose: "Investigates ideas end to end: survey, implementation, independent validation and review.",
    status: "active",
    origin: "Created in chat · today",
    members: [
      { agentId: "elliot", duty: "Plans the experiment and owns rework", lead: true },
      { agentId: "megan", duty: "Surveys prior work with Exa" },
      { agentId: "jonah", duty: "Implements and runs it in a Sprite" },
      { agentId: "sana", duty: "Re-checks results on a held-out split" },
      { agentId: "carlos", duty: "Accepts or requests changes" },
    ],
    workflow: [
      { label: "Plan", agentIds: ["elliot"], note: "Hypothesis, baselines and completion criteria" },
      { label: "Prepare", agentIds: ["megan", "jonah", "sana"], note: "Survey · environment setup · validation prep" },
      { label: "Synthesize", agentIds: ["elliot"], note: "Turns the survey into the exact test to run" },
      { label: "Implement", agentIds: ["jonah"], note: "Runs the experiment, streams the terminal" },
      { label: "Validate", agentIds: ["sana"], note: "Independent re-run on unseen data" },
      { label: "Review", agentIds: ["carlos"], note: "Accept, or send back to Elliot", gate: true },
    ],
    reworkBudget: 2,
    criteria: [
      "Baseline and fused model evaluated on the same split",
      "Held-out split never seen by the n-gram table",
      "Sana reproduces the headline number",
      "Report states caveats and what would change the verdict",
    ],
  },
  {
    id: "product",
    name: "Product Team",
    tagline: "Turns findings into product bets",
    purpose: "Turns validated findings into product decisions: market fit, scope and a first build.",
    status: "idle",
    origin: "Seeded",
    members: [
      { agentId: "diego", duty: "Decides what's worth building", lead: true },
      { agentId: "lila", duty: "Sizes and validates demand" },
      { agentId: "jonah", duty: "Builds the first prototype" },
      { agentId: "maya", duty: "Designs the first experience" },
    ],
    workflow: [
      { label: "Frame", agentIds: ["diego"], note: "Customer, problem and the bet" },
      { label: "Explore", agentIds: ["lila", "maya"], note: "Demand evidence · first-run flow" },
      { label: "Prototype", agentIds: ["jonah"], note: "Smallest version someone can try" },
      { label: "Decide", agentIds: ["diego"], note: "Build, pivot or drop", gate: true },
    ],
    reworkBudget: 2,
    criteria: [
      "A named customer and the problem in their words",
      "At least three real demand signals",
      "A prototype someone outside the team has tried",
    ],
  },
];

/** Teams shared by others, built from community profiles. Adding one adds its members too. */
export const communityTeams: StudioTeam[] = [
  {
    id: "trip-crew",
    name: "Trip Crew",
    tagline: "Plans a trip and keeps it on budget",
    purpose: "Plans trips end to end: options that fit your calendar, a budget you can see, and an itinerary doc you can share.",
    status: "idle",
    origin: "Community",
    author: "@wanderlist",
    installs: 820,
    members: [
      { agentId: "nadine", duty: "Finds options and builds the itinerary", lead: true },
      { agentId: "rosa", duty: "Keeps the trip inside the budget" },
      { agentId: "yuki", duty: "Writes the shareable itinerary" },
    ],
    workflow: [
      { label: "Brief", agentIds: ["nadine"], note: "Dates, budget and must-haves" },
      { label: "Options", agentIds: ["nadine", "rosa"], note: "Two routes · cost breakdown" },
      { label: "Write up", agentIds: ["yuki"], note: "Day-by-day itinerary doc" },
      { label: "Confirm", agentIds: ["nadine"], note: "Holds fares only after you approve", gate: true },
    ],
    reworkBudget: 1,
    criteria: ["Fits the dates on your calendar", "Total cost under the stated budget", "Itinerary readable on a phone"],
  },
  {
    id: "launch-squad",
    name: "Launch Squad",
    tagline: "Takes an idea to a launch plan",
    purpose: "Turns a product idea into a launch plan: who it's for, evidence of demand, and the announcement copy.",
    status: "idle",
    origin: "Community",
    author: "@shipnotes",
    installs: 1460,
    members: [
      { agentId: "nikhil", duty: "Frames the bet and the customer", lead: true },
      { agentId: "bea", duty: "Pulls the numbers behind the bet" },
      { agentId: "yuki", duty: "Writes the launch copy" },
    ],
    workflow: [
      { label: "Frame", agentIds: ["nikhil"], note: "Customer, problem, bet" },
      { label: "Evidence", agentIds: ["bea", "nikhil"], note: "Usage data · competitor scan" },
      { label: "Copy", agentIds: ["yuki"], note: "Launch post and landing copy" },
      { label: "Decide", agentIds: ["nikhil"], note: "Launch, test more, or drop", gate: true },
    ],
    reworkBudget: 2,
    criteria: ["A named customer", "At least one number that supports the bet", "Copy under 150 words"],
  },
  {
    id: "money-desk",
    name: "Money Desk",
    tagline: "A monthly check-in on your spending",
    purpose: "Reviews last month's spending, flags what changed, and charts where the money went.",
    status: "idle",
    origin: "Community",
    author: "@ledgerly",
    installs: 2210,
    members: [
      { agentId: "rosa", duty: "Categorises and flags changes", lead: true },
      { agentId: "bea", duty: "Charts the month" },
    ],
    workflow: [
      { label: "Categorise", agentIds: ["rosa"], note: "Sorts every transaction" },
      { label: "Chart", agentIds: ["bea"], note: "Where the money went" },
      { label: "Summarise", agentIds: ["rosa"], note: "What changed since last month", gate: true },
    ],
    reworkBudget: 1,
    criteria: ["Every transaction categorised", "Subscriptions listed with price changes"],
  },
];

export const organizations: Organization[] = [
  {
    id: "ty-lab",
    name: "Ty's Lab",
    headId: "dana",
    slots: [{ key: "research-1", teamId: "research" }, { key: "product-1", teamId: "product" }],
    handoffs: [{ from: "research", to: "product", question: "Can these results drive a real, value-driven product?", preview: true }],
  },
];
