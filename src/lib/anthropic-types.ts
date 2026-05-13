// Subset of the Anthropic Messages API schema we care about for capture/render.
// Mirrors content blocks 1:1 — do not invent new kinds, see claude-demo AGENTS.md.

export type Role = 'user' | 'assistant' | 'system'

export interface TextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' } | null
}

export interface ImageBlock {
  type: 'image'
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<TextBlock | ImageBlock>
  is_error?: boolean
  cache_control?: { type: 'ephemeral' } | null
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock

export interface MessageParam {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface ToolDefinition {
  name: string
  description?: string
  input_schema: unknown
  cache_control?: { type: 'ephemeral' } | null
  type?: string
}

export interface SystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' } | null
}

export interface AnthropicRequest {
  model: string
  max_tokens: number
  messages: MessageParam[]
  system?: string | SystemBlock[]
  tools?: ToolDefinition[]
  tool_choice?: unknown
  temperature?: number
  top_k?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  metadata?: { user_id?: string } & Record<string, unknown>
  thinking?: { type: 'enabled'; budget_tokens?: number } | { type: 'disabled' }
  anthropic_version?: string
  anthropic_beta?: string[]
}

export interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | null

export interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: ContentBlock[]
  stop_reason: StopReason
  stop_sequence: string | null
  usage: Usage
}

// SSE event types from Anthropic streaming
export type SseEvent =
  | { type: 'message_start'; message: AnthropicResponse }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: StopReason; stop_sequence?: string | null }; usage?: Usage }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } }

export type ContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'input_json_delta'; partial_json: string }

// ── Captured records (what we write to JSONL) ────────────────────────────────
//
// One JSONL file per project (cwd-keyed). A project file's first line is a
// `CapturedProject` record; subsequent lines are messages and interactions.
//
// On READ we also accept legacy `{type:"session", sessionId}` records — that
// was the original schema before we collapsed time-based session buckets
// into cwd-based projects. The storage layer translates them into project
// records in memory so the rest of the codebase only ever sees the new
// shape.

export interface CapturedProject {
  type: 'project'
  projectId: string
  startedAt: string // ISO — first time we saw this cwd
  firstSeenModel?: string
  cwd?: string // extracted from system prompt of the first request
  proxyVersion: string
}

export interface CapturedMessage {
  type: 'message'
  messageId: string
  projectId: string
  index: number // 0-based in project
  startedAt: string
  firstUserText?: string // for sidebar preview
}

export interface CapturedInteraction {
  type: 'interaction'
  interactionId: string
  projectId: string
  messageId: string
  index: number // 0-based within message
  startedAt: string
  endedAt?: string
  durationMs?: number
  request: AnthropicRequest
  requestHeaders: Record<string, string>
  responseHeaders?: Record<string, string>
  // Full assembled response after SSE has been replayed.
  // Undefined while the request is still in flight, or if it errored.
  response?: AnthropicResponse
  // Raw SSE events in order, for the timeline view & debugging.
  sseEvents?: SseEvent[]
  // Set when proxy upstream failed.
  error?: { message: string; status?: number }
}

export type CapturedRecord = CapturedProject | CapturedMessage | CapturedInteraction
