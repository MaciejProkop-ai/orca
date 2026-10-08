import { describe, expect, it } from 'vitest'
import {
  activeProviderContext,
  providerContextProofLink,
  isAgentSessionProviderContextBoundary
} from './agent-session-provider-context'
import { providerContextRecordFixture } from './agent-session-provider-context.test-fixture'
import {
  appendAgentSessionProviderHandleLink,
  isAgentSessionProviderHandleChain
} from './agent-session-provider-handle'
import {
  claudeProviderHandle,
  codexProviderHandle,
  agentSessionProviderHandleKey
} from './agent-session-provider-handle-encoding'
import { isPersistedAgentSessionRecord } from './agent-session-record'

const boundary = { operationId: 'clear-operation', afterFence: 3, clearedAt: 5000 }
const cleared = () => ({
  ...providerContextRecordFixture('codex'),
  providerContextBoundary: boundary
})
const proof = () => ({
  linkId: 'new-proof',
  origin: 'created' as const,
  mintedAtFence: 4,
  observedAt: 6000,
  handle: codexProviderHandle('fresh-thread')
})

describe('active provider context', () => {
  it('keeps all history but selects no handle until proof after clear', () => {
    const record = cleared()
    expect(record.providerHandleChain).toHaveLength(3)
    expect(activeProviderContext(record)).toEqual({
      head: null,
      handleChain: [],
      pendingClear: true
    })
    const link = providerContextProofLink(record, proof())
    expect(link.replaces).toEqual({
      key: agentSessionProviderHandleKey(record.providerHandleChain.at(-1)!.handle),
      reason: 'context-cleared',
      replacedAt: boundary.clearedAt
    })
    const chain = appendAgentSessionProviderHandleLink(record.providerHandleChain, link)
    expect(activeProviderContext({ ...record, providerHandleChain: chain })).toEqual({
      head: link,
      handleChain: [link],
      pendingClear: false
    })
  })

  it('clears an empty context repeatedly without manufacturing ancestry', () => {
    const record = { ...cleared(), providerHandleChain: [] }
    expect(providerContextProofLink(record, proof())).toEqual(proof())
    expect(
      activeProviderContext({
        ...record,
        providerContextBoundary: { ...boundary, operationId: 'again' }
      }).head
    ).toBeNull()
  })

  it('respects a later old-build resume as the user action after a downgrade', () => {
    const record = cleared()
    const resumed = {
      ...proof(),
      origin: 'resumed' as const,
      handle: record.providerHandleChain.at(-1)!.handle
    }
    const chain = appendAgentSessionProviderHandleLink(record.providerHandleChain, resumed)
    expect(activeProviderContext({ ...record, providerHandleChain: chain }).head).toEqual(resumed)
  })

  it.each(['resumed', 'forked'] as const)(
    'refuses a new-host %s proof while the clear is pending',
    (origin) => {
      expect(() => providerContextProofLink(cleared(), { ...proof(), origin })).toThrow(
        'agent_session_provider_handle_invalid'
      )
    }
  )

  it('refuses delayed proof from at or before the boundary', () => {
    expect(() => providerContextProofLink(cleared(), { ...proof(), mintedAtFence: 3 })).toThrow(
      'agent_session_provider_handle_invalid'
    )
  })

  it('permits a transport change only for fresh proof in the same agent', () => {
    const old = {
      ...proof(),
      linkId: 'old-proof',
      mintedAtFence: 3,
      handle: { agent: 'opencode', transport: 'acp', nativeId: 'old' }
    }
    const record = { ...cleared(), provider: 'opencode', providerHandleChain: [old] }
    const fresh = providerContextProofLink(record, {
      ...proof(),
      handle: { ...old.handle, transport: 'jsonl-rpc', nativeId: 'fresh' }
    })
    const chain = appendAgentSessionProviderHandleLink(record.providerHandleChain, fresh)
    expect(isAgentSessionProviderHandleChain(chain)).toBe(true)
    expect(() =>
      appendAgentSessionProviderHandleLink(record.providerHandleChain, {
        ...fresh,
        handle: { ...fresh.handle, agent: 'omp' }
      })
    ).toThrow('agent_session_provider_handle_provider_mismatch')
  })

  it('keeps typed Claude/Codex namespace and record-provider checks', () => {
    const record = cleared()
    const wrong = providerContextProofLink(record, {
      ...proof(),
      handle: claudeProviderHandle('fresh', null)
    })
    expect(() => appendAgentSessionProviderHandleLink(record.providerHandleChain, wrong)).toThrow()
    expect(
      isPersistedAgentSessionRecord({
        ...record,
        lease: { ...record.lease, runtimeFence: 4 },
        providerHandleChain: [...record.providerHandleChain, wrong]
      })
    ).toBe(false)
  })

  it.each([
    {},
    { ...boundary, afterFence: -1 },
    { ...boundary, clearedAt: Number.NaN },
    { ...boundary, operationId: '' }
  ])('rejects malformed boundary metadata', (value) =>
    expect(isAgentSessionProviderContextBoundary(value)).toBe(false)
  )
})
