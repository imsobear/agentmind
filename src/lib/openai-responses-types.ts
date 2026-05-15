// Subset of the OpenAI Responses API schema we care about for capture/render.
//
// Mirrors the shapes the Codex CLI sends/receives 1:1 — kept narrow on
// purpose. When you need to know what's actually on the wire, the canonical
// reference is openai/codex:codex-rs/protocol/src/models.rs (every variant
// we model here exists in that file's `ResponseItem` / `ResponseInputItem`
// enums) plus codex-rs/codex-api/src/common.rs#ResponsesApiRequest for the
// request envelope.

// ── Request body ────────────────────────────────────────────────────────────

// Items the client puts in `input`. Codex CLI rebuilds the full transcript
// each turn (the HTTP envelope has no `previous_response_id`), so this array
// grows monotonically across a multi-iteration ReAct loop, which means the
// same prefix-equality message-grouping logic we use for Anthropic Messages
// works here without modification.
export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCallOutput
  | ResponsesCustomToolCallOutput
  | ResponsesMcpToolCallOutput
  | ResponsesToolSearchOutput

export interface ResponsesInputMessage {
  type: 'message'
  role: 'user' | 'assistant' | 'system' | 'developer'
  content: ResponsesContentItem[]
  // `commentary` (mid-turn narration) vs `final_answer`. Optional and not
  // emitted by every provider — treat absence as "unknown".
  phase?: 'commentary' | 'final_answer'
}

// `function_call_output.output` is polymorphic on the wire: either a plain
// string OR a structured `[{type: "input_text"|"input_image", ...}]` array.
// We keep the union shape so the renderer can switch.
export type FunctionCallOutputPayload =
  | string
  | Array<
      | { type: 'input_text'; text: string }
      | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' | 'original' }
    >

export interface ResponsesFunctionCallOutput {
  type: 'function_call_output'
  call_id: string
  output: FunctionCallOutputPayload
}

export interface ResponsesCustomToolCallOutput {
  type: 'custom_tool_call_output'
  call_id: string
  name?: string
  output: FunctionCallOutputPayload
}

export interface ResponsesMcpToolCallOutput {
  type: 'mcp_tool_call_output'
  call_id: string
  output: unknown
}

export interface ResponsesToolSearchOutput {
  type: 'tool_search_output'
  call_id: string
  status: string
  execution: string
  tools: unknown[]
}

export type ResponsesContentItem =
  | { type: 'input_text'; text: string }
  | {
      type: 'input_image'
      image_url: string
      detail?: 'auto' | 'low' | 'high' | 'original'
    }
  | { type: 'output_text'; text: string }

export interface ResponsesReasoningConfig {
  effort?: 'minimal' | 'low' | 'medium' | 'high'
  summary?: 'auto' | 'concise' | 'detailed' | 'none'
}

export interface ResponsesRequest {
  model: string
  // Stable system-level instructions (the "system prompt" for a Responses
  // turn). Codex CLI omits this when empty via #[serde(skip)] so absent =
  // empty.
  instructions?: string
  input: ResponsesInputItem[]
  tools: unknown[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  reasoning?: ResponsesReasoningConfig | null
  store?: boolean
  stream?: boolean
  include?: string[]
  service_tier?: string
  prompt_cache_key?: string
  text?: { verbosity?: 'low' | 'medium' | 'high'; format?: unknown }
  client_metadata?: Record<string, string>
}

// ── Response body (the "completed" object) ──────────────────────────────────
//
// Final shape that `response.completed` delivers on its `response` payload,
// also what a non-streaming response returns. Output items are heterogenous
// (`ResponsesOutputItem`) — they're a superset of input items plus tool
// invocations the model emitted.

export interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  cached_tokens?: number
  reasoning_tokens?: number
  total_tokens?: number
}

export type ResponsesStatus =
  | 'completed'
  | 'failed'
  | 'in_progress'
  | 'incomplete'
  | 'cancelled'

export interface ResponsesObject {
  id: string
  object?: 'response'
  status?: ResponsesStatus
  model?: string
  created_at?: number
  output: ResponsesOutputItem[]
  usage?: ResponsesUsage
  error?: { type?: string; message?: string } | null
  incomplete_details?: { reason?: string } | null
}

export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesReasoningItem
  | ResponsesFunctionCallItem
  | ResponsesCustomToolCallItem
  | ResponsesLocalShellCallItem
  | ResponsesToolSearchCallItem
  | ResponsesWebSearchCallItem
  | ResponsesImageGenerationCallItem
  | { type: string; [k: string]: unknown }

export interface ResponsesOutputMessage {
  type: 'message'
  id?: string
  role: 'assistant'
  content: ResponsesContentItem[]
  phase?: 'commentary' | 'final_answer'
  status?: string
}

export interface ResponsesReasoningItem {
  type: 'reasoning'
  id?: string
  summary?: Array<{ type: string; text: string }>
  content?: Array<{ type: string; text?: string }>
  encrypted_content?: string | null
}

export interface ResponsesFunctionCallItem {
  type: 'function_call'
  id?: string
  call_id: string
  name: string
  namespace?: string
  // Codex preserves arguments as a raw JSON string (deferred-parse).
  arguments: string
  status?: string
}

export interface ResponsesCustomToolCallItem {
  type: 'custom_tool_call'
  id?: string
  call_id: string
  name: string
  // Custom tools use a free-form string input (not necessarily JSON).
  input: string
  status?: string
}

export interface ResponsesLocalShellCallItem {
  type: 'local_shell_call'
  id?: string
  call_id?: string
  status: string
  action: unknown
}

export interface ResponsesToolSearchCallItem {
  type: 'tool_search_call'
  id?: string
  call_id?: string
  status?: string
  execution: string
  arguments: unknown
}

export interface ResponsesWebSearchCallItem {
  type: 'web_search_call'
  id?: string
  status?: string
  action?: { type: string; query?: string }
}

export interface ResponsesImageGenerationCallItem {
  type: 'image_generation_call'
  id?: string
  status?: string
  revised_prompt?: string
  result?: string
}

// ── SSE event union ────────────────────────────────────────────────────────
//
// Codex CLI's `process_responses_event` dispatcher matches a finite set;
// the OpenAI Streaming Responses guide lists more. We include both so we
// don't silently drop kinds — Codex degrades to a `trace!` for unhandled
// kinds, which is too quiet for a capture UI.
//
// New kinds the spec adds in future should fall into the trailing
// open-shape `{ type: string }` variant so the parser keeps working.

export type ResponsesSseEvent =
  // Lifecycle.
  | { type: 'response.created'; response: Partial<ResponsesObject> }
  | { type: 'response.in_progress'; response: Partial<ResponsesObject> }
  | { type: 'response.completed'; response: ResponsesObject }
  | { type: 'response.failed'; response?: Partial<ResponsesObject>; error?: { message?: string; type?: string } }
  | { type: 'response.incomplete'; response?: Partial<ResponsesObject> }
  // Output items.
  | { type: 'response.output_item.added'; output_index?: number; item: ResponsesOutputItem }
  | { type: 'response.output_item.done'; output_index?: number; item: ResponsesOutputItem }
  // Text streaming.
  | {
      type: 'response.output_text.delta'
      delta: string
      output_index?: number
      content_index?: number
      item_id?: string
    }
  | { type: 'response.output_text.done'; text?: string; output_index?: number; item_id?: string }
  // Tool args streaming.
  | {
      type: 'response.function_call_arguments.delta'
      delta: string
      output_index?: number
      item_id?: string
    }
  | { type: 'response.function_call_arguments.done'; arguments?: string; output_index?: number; item_id?: string }
  | {
      type: 'response.custom_tool_call_input.delta'
      delta: string
      output_index?: number
      item_id?: string
    }
  | { type: 'response.custom_tool_call_input.done'; input?: string; output_index?: number; item_id?: string }
  // Reasoning streaming.
  | { type: 'response.reasoning_text.delta'; delta: string; output_index?: number; item_id?: string }
  | { type: 'response.reasoning_text.done'; text?: string; output_index?: number; item_id?: string }
  | { type: 'response.reasoning_summary_text.delta'; delta: string; output_index?: number; item_id?: string }
  | { type: 'response.reasoning_summary_text.done'; text?: string; output_index?: number; item_id?: string }
  | { type: 'response.reasoning_summary_part.added'; output_index?: number; item_id?: string; part?: unknown }
  // Errors.
  | { type: 'error'; error: { type?: string; message?: string } }
  // Catch-all so we never crash on an unrecognised kind.
  | { type: string; [k: string]: unknown }
