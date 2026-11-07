// Message format inside the runner: the Anthropic Messages shape, which Naïve's proxy speaks.
// Other providers translate to and from it.
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
/** Base64 source as it goes on the wire. */
export type ImageBase64Source = { type: "base64"; media_type: "image/png"; data: string };
/**
 * Inside the runner an image is a `ref` to a content-addressed copy under runs/<id>/images/
 * (sha256-named), so transcript.jsonl never carries base64 and a resume rebuilds the message
 * from the copy even if the workspace file changed. wireMessages() expands refs to base64
 * right before the provider call.
 */
export type ImageRefSource = { type: "ref"; path: string; media_type: "image/png"; sha256: string; size: number };
export type ImageBlock = { type: "image"; source: ImageRefSource | ImageBase64Source };
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
};
export type Block = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

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
