// Message format inside the runner: the Anthropic Messages shape, which Naïve's proxy speaks.
// Other providers translate to and from it.
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type Block = TextBlock | ToolUseBlock | ToolResultBlock;

export type Message = { role: "user" | "assistant"; content: string | Block[] };

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolDef[];
  max_tokens: number;
}

export interface ModelReply {
  content: Block[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
  cost_micro_usd: number;
  request_id: string;
  model: string;
}

export interface Provider {
  readonly label: string;
  complete(req: ModelRequest): Promise<ModelReply>;
}
