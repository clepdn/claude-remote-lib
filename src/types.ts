/**
 * Message types for the Claude remote-control wire protocol.
 *
 * These mirror the `SDKMessage` / control-message shapes that Claude's servers
 * exchange with bridge workers. They are the "lingua franca" of the protocol —
 * your host code must EMIT these shapes to be understood by the server, even
 * though the library never calls Claude inference. (You're talking *to Claude
 * servers*, not *to Claude the model*.)
 *
 * Structurally compatible with @anthropic-ai/claude-code's SDKMessage, but
 * defined here with zero dependencies so the library is self-contained.
 */

// ─── Content blocks (Anthropic Messages API shapes) ────────────────────────

export type TextBlock = {
  type: 'text'
  text: string
  citations?: unknown
}

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<TextBlock | { type: 'image'; source: ImageSource }>
  is_error?: boolean
}

export type ImageSource = {
  type: 'base64'
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string
}

export type ImageBlockParam = {
  type: 'image'
  source: ImageSource
}

export type ThinkingBlock = {
  type: 'thinking'
  thinking: string
  signature?: string
}

/** A single content block within a message. */
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlockParam
  | ThinkingBlock

// ─── SDK messages (the NDJSON / SSE-payload union) ────────────────────────

/** A user message arriving from claude.ai (the thing your handler receives). */
export type SDKUserMessage = {
  type: 'user'
  uuid?: string
  session_id?: string
  parent_tool_use_id?: string | null
  message: {
    role: 'user'
    content: string | ContentBlock[]
  }
}

/**
 * An assistant message — what YOUR code produces and sends to the server so it
 * appears in the Claude app. `message.id` is an API-style id (e.g. `msg_<rand>`);
 * `stop_reason` should be 'end_turn' for a normal completion.
 */
export type SDKAssistantMessage = {
  type: 'assistant'
  uuid?: string
  session_id?: string
  parent_tool_use_id?: string | null
  message: {
    id: string
    role: 'assistant'
    content: ContentBlock[]
    model?: string
    stop_reason?: string | null
    stop_sequence?: string | null
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

/** A partial/streaming assistant event (deltas). Optional — you can instead send
 *  a complete SDKAssistantMessage. */
export type SDKPartialAssistantMessage = {
  type: 'stream_event'
  uuid?: string
  session_id?: string
  parent_tool_use_id?: string | null
  event: {
    type:
      | 'message_start'
      | 'content_block_start'
      | 'content_block_delta'
      | 'content_block_stop'
      | 'message_delta'
      | 'message_stop'
    [key: string]: unknown
  }
}

/** A terminal result for a turn. */
export type SDKResultMessage = {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_during_execution'
  is_error?: boolean
  duration_ms?: number
  duration_api_ms?: number
  num_turns?: number
  result?: string
  session_id?: string
  total_cost_usd?: number
  sequence_num?: number
  usage?: Record<string, number>
}

export type SDKSystemMessage = {
  type: 'system'
  subtype: 'init' | 'init_status'
  [key: string]: unknown
}

/** Any message your code can push to the server (including control responses). */
export type OutboundMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKPartialAssistantMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKControlResponse

/** Any message that can arrive from the server (SSE payload). */
export type InboundMessage =
  | SDKUserMessage
  | SDKAssistantMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKControlRequest
  | SDKControlResponse

// ─── Control protocol (permissions, initialize, set_model) ─────────────────

export type SDKControlRequestInner =
  | { subtype: 'initialize'; mcp_servers?: unknown }
  | { subtype: 'set_model'; model: string }
  | { subtype: 'set_max_thinking_tokens'; max_tokens: number | null }
  | { subtype: 'can_use_tool'; tool_name: string; input: Record<string, unknown>; tool_use_id: string }
  | { subtype: 'remote_control'; enabled: boolean }
  | { subtype: 'interrupt' }
  | { subtype: string; [key: string]: unknown }

/** A request FROM the server (e.g. "may I run this tool?" permission prompt,
 *  or "switch model", or "initialize"). */
export type SDKControlRequest = {
  type: 'control_request'
  request_id: string
  request: SDKControlRequestInner
}

/** Your response TO a control_request (e.g. a permission decision). */
export type SDKControlResponse =
  | {
      type: 'control_response'
      response: {
        subtype: 'success'
        request_id: string
        response: Record<string, unknown>
      }
    }
  | {
      type: 'control_response'
      response: {
        subtype: 'error'
        request_id: string
        error: string
      }
    }

/** A permission decision you can send back for a `can_use_tool` request. */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

// ─── Transport-level event wrapper (SSE frame payload) ────────────────────

/** The SSE stream wraps each SDK payload in this envelope. */
export type StreamClientEvent = {
  event_id: string
  event_type: string
  sequence_num?: number
  payload: Record<string, unknown>
}

// ─── Type guards ──────────────────────────────────────────────────────────

export function isSDKControlRequest(v: unknown): v is SDKControlRequest {
  return (
    typeof v === 'object' &&
    v !== null &&
    'type' in v &&
    (v as { type: unknown }).type === 'control_request' &&
    'request_id' in v &&
    'request' in v
  )
}

export function isSDKControlResponse(v: unknown): v is SDKControlResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    'type' in v &&
    (v as { type: unknown }).type === 'control_response' &&
    'response' in v
  )
}

export function isSDKMessage(v: unknown): v is InboundMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    'type' in v &&
    typeof (v as { type: unknown }).type === 'string'
  )
}

export function isSDKUserMessage(v: unknown): v is SDKUserMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: unknown }).type === 'user'
  )
}
