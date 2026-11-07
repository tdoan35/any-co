// Option lists shared by the composer, the session panel and the settings dialog.
import { Cloud, Laptop, Server } from "lucide-react";

export const MODELS = [
  { id: "fable-5-1", name: "Fable 5.1", note: "Most capable" },
  { id: "opus-5-5", name: "Opus 5.5", note: "Deep reasoning" },
  { id: "sonnet-5-5", name: "Sonnet 5.5", note: "Balanced" },
  { id: "haiku-4-5", name: "Haiku 4.5", note: "Fastest" },
  { id: "glm-5-3-flash", name: "GLM 5.3 Flash", note: "Open model, fast" },
];
export const EFFORTS = ["Low", "Medium", "High", "Extra high"];

export const APPROVALS = [
  { id: "ask", name: "Ask for approval", note: "Confirm before creating or running anything" },
  { id: "edits", name: "Auto-approve edits", note: "Ask only for new agents and teams" },
  { id: "auto", name: "Full auto", note: "Never ask (inside the sandbox)" },
];

export const CONNECTORS = [
  { id: "exa", name: "Exa", note: "Web search" },
  { id: "agentmail", name: "AgentMail", note: "Agent inboxes" },
  { id: "executor", name: "Executor", note: "Tool gateway" },
  { id: "neon", name: "Neon", note: "Postgres" },
  { id: "kernel", name: "Kernel", note: "Browser sessions" },
];

export const TARGETS = [
  { id: "local", name: "This machine", note: "Runs locally", icon: Laptop },
  { id: "sprite", name: "Sprite sandbox", note: "Isolated", icon: Cloud },
  { id: "remote", name: "Remote host", note: "Your own server", icon: Server },
] as const;
export type TargetId = (typeof TARGETS)[number]["id"];
