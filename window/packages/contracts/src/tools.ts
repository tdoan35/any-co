// The canonical tool registry (DATA-6). Studio, the profile sheet, the inspector and the runtime use
// these names. Community and Product Team profiles may still list other tools (docs.write,
// flights.search, …) as display-only until phase 2.
export const TOOL_NAMES = [
  "sprite.exec",
  "workspace.write",
  "artifacts.read",
  "artifacts.write",
  "exa.search",
  "agentmail.send",
  "network.fetch",
  "team.assign",
  "browser.task",
  "recall",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const isToolName = (name: string): name is ToolName => (TOOL_NAMES as readonly string[]).includes(name);
