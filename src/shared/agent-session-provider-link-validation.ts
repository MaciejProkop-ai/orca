import type {
  AgentSessionProviderHandle,
  AgentSessionProviderHandleLink
} from './agent-session-provider-handle'
import {
  agentSessionProviderHandleKey,
  agentSessionProviderHandleRoot,
  isAgentSessionProviderHandle,
  isAgentSessionProviderHandleInNamespace,
  isAgentSessionProviderHandleKeyFor
} from './agent-session-provider-handle-encoding'
import { isAgentSessionProviderHandleReplacement } from './agent-session-provider-handle-replacement'

const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Every field, resume cursor included: a resume that only moved the adapter's state is still news. */
export function agentSessionProviderHandlesEqual(
  left: AgentSessionProviderHandle,
  right: AgentSessionProviderHandle
): boolean {
  return (
    left.transport === right.transport &&
    left.agent === right.agent &&
    left.nativeId === right.nativeId &&
    left.resumeCursor === right.resumeCursor
  )
}

export function isAgentSessionProviderHandleLink(
  value: unknown
): value is AgentSessionProviderHandleLink {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field is validated below before this unknown value is accepted as a link.
  const link = value as Partial<AgentSessionProviderHandleLink>
  if (!isAgentSessionProviderHandle(link.handle)) {
    return false
  }
  const handle = link.handle
  const originValid =
    link.origin === 'created' ||
    link.origin === 'adopted' ||
    link.origin === 'resumed' ||
    link.origin === 'forked'
  return (
    typeof link.linkId === 'string' &&
    LINK_ID_PATTERN.test(link.linkId) &&
    originValid &&
    typeof link.mintedAtFence === 'number' &&
    Number.isSafeInteger(link.mintedAtFence) &&
    link.mintedAtFence >= 0 &&
    Number.isSafeInteger(link.observedAt) &&
    (link.origin === 'forked'
      ? isAgentSessionProviderHandleKeyFor(handle, link.forkedFromKey)
      : link.forkedFromKey === undefined) &&
    (link.supersedesKey === undefined ||
      (link.origin === 'created' &&
        isAgentSessionProviderHandleKeyFor(handle, link.supersedesKey))) &&
    (link.replaces === undefined ||
      (link.origin === 'created' && isAgentSessionProviderHandleReplacement(handle, link.replaces)))
  )
}

export function providerHandleLinkFollows(
  head: AgentSessionProviderHandleLink,
  link: AgentSessionProviderHandleLink
): boolean {
  if (!providerHandleNamespacesContinue(head, link) || link.mintedAtFence < head.mintedAtFence) {
    return false
  }
  const sameRoot =
    agentSessionProviderHandleRoot(link.handle) === agentSessionProviderHandleRoot(head.handle)
  if (link.origin === 'created') {
    return link.replaces?.key === agentSessionProviderHandleKey(head.handle) && !sameRoot
  }
  if (link.origin === 'forked') {
    return !sameRoot && link.forkedFromKey === agentSessionProviderHandleKey(head.handle)
  }
  return (
    link.origin === 'resumed' &&
    sameRoot &&
    !(
      agentSessionProviderHandlesEqual(link.handle, head.handle) &&
      link.mintedAtFence === head.mintedAtFence
    )
  )
}

export function providerHandleNamespacesContinue(
  head: AgentSessionProviderHandleLink,
  link: AgentSessionProviderHandleLink
): boolean {
  return (
    isAgentSessionProviderHandleInNamespace(link.handle, head.handle) ||
    (link.origin === 'created' &&
      link.replaces?.reason === 'context-cleared' &&
      link.handle.agent === head.handle.agent)
  )
}
