import { expect, it } from 'vitest'
import { agentSessionProviderClaims } from './agent-session-provider-claims'
import { agentSessionProviderHandleRoot } from './agent-session-provider-handle'
import { providerContextRecordFixture } from './agent-session-provider-context.test-fixture'

it('keeps archives as reservations and prefers the visible owner regardless of record order', () => {
  const original = providerContextRecordFixture('codex')
  const adopted = { ...providerContextRecordFixture('codex', [1]), sessionId: 'adopted-chat' }
  for (const records of [
    [original, adopted],
    [adopted, original]
  ]) {
    expect(
      agentSessionProviderClaims(records).filter((claim) => claim.handle.nativeId === 'context-0')
    ).toEqual([{ record: adopted, handle: adopted.providerHandleChain[0].handle, archived: false }])
  }
  expect(
    agentSessionProviderClaims([original]).find((claim) => claim.handle.nativeId === 'context-0')
      ?.archived
  ).toBe(true)
})

it('does not hide conflicting visible claims, and picks a stable archive-only display owner', () => {
  const first = { ...providerContextRecordFixture('codex'), sessionId: 'a-chat' }
  const second = { ...providerContextRecordFixture('codex'), sessionId: 'z-chat' }
  for (const records of [
    [first, second],
    [second, first]
  ]) {
    const claims = agentSessionProviderClaims(records)
    expect(claims.filter((claim) => claim.handle.nativeId === 'context-1')).toHaveLength(2)
    expect(claims.find((claim) => claim.handle.nativeId === 'context-0')?.record.sessionId).toBe(
      'a-chat'
    )
  }
})

it('reserves pre-clear handles while a later old-host adoption remains the visible owner', () => {
  const cleared = {
    ...providerContextRecordFixture('codex'),
    providerContextBoundary: { operationId: 'clear', afterFence: 3, clearedAt: 5000 }
  }
  expect(agentSessionProviderClaims([cleared]).every((claim) => claim.archived)).toBe(true)
  const last = cleared.providerHandleChain.at(-1)
  if (!last) {
    throw new Error('missing fixture handle')
  }
  const adopted = {
    ...cleared,
    sessionId: 'adopted-by-old-host',
    providerContextBoundary: undefined,
    providerHandleChain: [{ ...last, origin: 'adopted' as const, replaces: undefined }]
  }
  const root = agentSessionProviderHandleRoot(last.handle)
  for (const records of [
    [cleared, adopted],
    [adopted, cleared]
  ]) {
    expect(
      agentSessionProviderClaims(records).filter(
        (claim) => agentSessionProviderHandleRoot(claim.handle) === root
      )
    ).toEqual([{ record: adopted, handle: last.handle, archived: false }])
  }
})
