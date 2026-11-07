import type { Suggestion } from "@fabric/contracts";
import { IDEA_PROMPT } from "./chat";
export type { Suggestion } from "@fabric/contracts";

// Stand-in for a "smart suggestions" service: prompts derived from recent sessions.
// The first three are the demo path and must stay in this order.
// Keep labels short (<= ~32 chars) so a set of three stays on one line; the full prompt is what gets sent.
export const suggestionPool: Suggestion[] = [
  { label: "What's an n-gram, in one line?", prompt: "What's an n-gram, in one line?", from: "Ngram Model Grafting" },
  { label: "Test my n-gram / Engram idea", prompt: IDEA_PROMPT, from: "GLM + Engram?" },
  { label: "Recap my memory grafting work", prompt: "Summarize where I left off on memory grafting and what's still open.", from: "Create memory grafting handoff" },

  { label: "Compare routing tradeoffs", prompt: "Compare the routing tradeoffs we discussed: one classifier vs. the assistant's own judgment.", from: "Compare Routing Tradeoffs" },
  { label: "Can a 4B model fit my hardware?", prompt: "Re-check whether a 4B model fits on the hardware we listed, and what it would cost on an H100.", from: "4B Model Hardware Requirements" },
  { label: "What's new in post-training?", prompt: "What changed in SOTA post-training techniques since our last session?", from: "Current SOTA Posttraining Techniques" },

  { label: "Is streaming feasible for the demo?", prompt: "Turn the streaming feasibility check into a go / no-go for the demo.", from: "Streaming feasibility check" },
  { label: "Explain the Executor MCP catalog", prompt: "Explain the Executor MCP catalog in five bullets, with what matters for Fabric.", from: "Explain Executor MCP Catalog" },
  { label: "Plan the Raspberry Pi cluster", prompt: "Draft a parts list and plan for the Raspberry Pi cluster.", from: "Plan Raspberry Pi Cluster" },
];
