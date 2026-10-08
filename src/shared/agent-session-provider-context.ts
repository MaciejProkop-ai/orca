import {
  agentSessionProviderContextStart,
  agentSessionProviderHandleKey,
  type AgentSessionProviderHandleLink
} from './agent-session-provider-handle'
import type { AgentSessionRecord } from './agent-session-record'

export type AgentSessionProviderContextBoundary = {
  operationId: string
  afterFence: number
  clearedAt: number
}

export function isAgentSessionProviderContextBoundary(
  value: unknown
): value is AgentSessionProviderContextBoundary {
  return (
    typeof value === 'object' &&
    value !== null &&
    'operationId' in value &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    value.operationId.length <= 512 &&
    'afterFence' in value &&
    typeof value.afterFence === 'number' &&
    Number.isSafeInteger(value.afterFence) &&
    value.afterFence >= 0 &&
    'clearedAt' in value &&
    typeof value.clearedAt === 'number' &&
    Number.isSafeInteger(value.clearedAt) &&
    value.clearedAt >= 0
  )
}

/** Later proof wins, including a resumed context written by an older build. */
export function activeProviderContext(
  record: Pick<AgentSessionRecord, 'providerHandleChain' | 'providerContextBoundary'>
) {
  const boundary = record.providerContextBoundary
  const segment = record.providerHandleChain.slice(
    agentSessionProviderContextStart(record.providerHandleChain)
  )
  const handleChain = boundary
    ? segment.filter((link) => link.mintedAtFence > boundary.afterFence)
    : segment
  const head = handleChain.at(-1) ?? null
  return { handleChain, head, pendingClear: boundary !== undefined && head === null }
}

/** A deliberate reset has ancestry only once the provider proves its new context. */
export function providerContextProofLink(
  record: AgentSessionRecord,
  link: AgentSessionProviderHandleLink
): AgentSessionProviderHandleLink {
  if (!activeProviderContext(record).pendingClear) {
    return link
  }
  const boundary = record.providerContextBoundary
  if (!boundary || link.mintedAtFence <= boundary.afterFence || link.origin !== 'created') {
    throw new Error('agent_session_provider_handle_invalid')
  }
  const previous = record.providerHandleChain.at(-1)
  return previous
    ? {
        ...link,
        replaces: {
          key: agentSessionProviderHandleKey(previous.handle),
          reason: 'context-cleared',
          replacedAt: boundary.clearedAt
        }
      }
    : link
}
