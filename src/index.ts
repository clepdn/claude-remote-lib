/**
 * claude-remote-lib — public API.
 *
 * A Claude-agnostic bridge: speaks Claude's remote-control server protocol so
 * your own code can appear as a session in the Claude app / claude.ai, WITHOUT
 * calling Claude inference. You provide the inference via callbacks.
 */

export { Bridge } from './bridge.js'
export type {
  BridgeHandlers,
  BridgeOptions,
} from './bridge.js'

export {
  CCRTransport,
  parseSSEFrames,
} from './transport.js'
export type {
  SessionState,
  TransportCallbacks,
  TransportOpts,
} from './transport.js'

export { IngressRouter } from './ingress.js'
export type { IngressCallbacks } from './ingress.js'

export {
  createCodeSession,
  fetchOrganizationUuid,
  fetchRemoteCredentials,
  registerWorker,
  toCompatSessionId,
  updateSessionTitle,
  buildSessionUrl,
  DEFAULT_API_BASE_URL,
  DEFAULT_SESSION_TIMEOUT_MS,
} from './codeSessionApi.js'
export type { RemoteCredentials } from './codeSessionApi.js'

export { TokenRefreshScheduler } from './tokenRefresh.js'
export type { RefreshResult } from './tokenRefresh.js'

export { decodeJwtExpiry, decodeJwtPayload } from './jwt.js'

// Re-export the wire types so hosts emit correct shapes.
export type {
  ContentBlock,
  ImageBlockParam,
  ImageSource,
  OutboundMessage,
  InboundMessage,
  PermissionDecision,
  SDKAssistantMessage,
  SDKControlRequest,
  SDKControlRequestInner,
  SDKControlResponse,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
  StreamClientEvent,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from './types.js'

export {
  isSDKControlRequest,
  isSDKControlResponse,
  isSDKMessage,
  isSDKUserMessage,
} from './types.js'
