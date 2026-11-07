import type { Project, Session } from "@fabric/contracts";
export type { Project, Session, SessionStatus } from "@fabric/contracts";

export const projects: Project[] = [
  { id: "engram", name: "Engram on small models", goal: "Find out whether lookup tables make small open models more capable, and whether the tables can live on NAND." },
  { id: "product", name: "Product exploration", goal: "Decide whether anything from the research is worth building for other people." },
  { id: "tokenizer", name: "Tokenizer sweep", goal: "Check whether a larger vocabulary helps a 135M model enough to pay for its memory.", archived: true },
];

export const sessions: Session[] = [
  // Project-linked sessions
  { id: "p1", title: "n-gram fusion experiment", href: "/work/ngram-135m", projectId: "engram", agentId: "elliot", teamId: "research", messages: 18, updated: "1d" },
  { id: "p2", title: "NAND-offloaded tables", href: "/", projectId: "engram", agentId: "dana", messages: 9, updated: "2d" },
  { id: "p3", title: "Who would buy this?", href: "/", projectId: "product", agentId: "diego", teamId: "product", messages: 7, updated: "3d" },
  // Recent sessions (imported from ChatGPT history)
  { id: "s1", title: "Dog Sitting Allergy Advice", href: "/", agentId: "dana", messages: 4, updated: "4d" },
  { id: "s2", title: "Edit Baking Response", href: "/", agentId: "dana", messages: 6, updated: "5d" },
  { id: "s3", title: "Ngram Model Grafting", href: "/", status: "unread", agentId: "dana", messages: 11, newReplies: 2, updated: "12m" },
  { id: "s4", title: "Explain Executor MCP Catalog", href: "/", status: "input", agentId: "jonah", messages: 5, updated: "1h" },
  { id: "s5", title: "AI Reasoning Settings", href: "/", agentId: "dana", messages: 3, updated: "2h" },
  { id: "s6", title: "H100 Qwen Capacity", href: "/", agentId: "megan", messages: 8, updated: "3h" },
  { id: "s7", title: "4B Model Hardware Requirements", href: "/", agentId: "dana", messages: 14, updated: "6h" },
  { id: "s8", title: "Redesign the Chromebook", href: "/", agentId: "dana", messages: 10, updated: "1d" },
  { id: "s9", title: "Streaming feasibility check", href: "/", status: "input", agentId: "elliot", teamId: "research", messages: 6, updated: "2h" },
  { id: "s10", title: "Create memory grafting handoff", href: "/", status: "unread", agentId: "dana", messages: 7, newReplies: 1, updated: "25m" },
  { id: "s11", title: "iOS开发工作流", href: "/", agentId: "dana", messages: 2, updated: "1w" },
  { id: "s12", title: "Plan Raspberry Pi Cluster", href: "/", agentId: "jonah", messages: 13, updated: "1w" },
  { id: "s13", title: "Mirror iPhone Linux", href: "/", agentId: "dana", messages: 5, updated: "1w" },
  { id: "s14", title: "China RAM prices", href: "/", agentId: "megan", messages: 4, updated: "2w" },
  { id: "s15", title: "Current SOTA Posttraining Techniques", href: "/", agentId: "carlos", messages: 9, updated: "2w" },
  { id: "s16", title: "GLM + Engram?", href: "/", status: "unread", agentId: "dana", messages: 6, newReplies: 3, updated: "8m" },
  { id: "s17", title: "Branch · Current SOTA Posttraining Techniques", href: "/", agentId: "dana", messages: 3, updated: "3w" },
  { id: "s18", title: "Compare Routing Tradeoffs", href: "/", agentId: "dana", messages: 8, updated: "3w" },
];
