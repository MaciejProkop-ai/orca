import { expect, test } from 'vitest'
import {
  materializeReleaseCheckout,
  importReleaseCheckoutModule,
  resolveBaselineReleaseRef
} from './release-checkout'
import {
  historicalStore,
  historicalRecord,
  historicalHandle
} from './agent-session-historical-store.test-fixture'
import { providerContextRecordFixture } from '../../../src/shared/agent-session-provider-context.test-fixture'
import {
  encodeAgentSessionRecord,
  decodePersistedAgentSessionRecord
} from '../../../src/shared/agent-session-record-stored-form'
import { isPersistedAgentSessionRecord } from '../../../src/shared/agent-session-record'
import { activeProviderContext } from '../../../src/shared/agent-session-provider-context'

const refs = [...new Set(['v1.4.222', '8ae5264c638', resolveBaselineReleaseRef()])]
const cases = refs.flatMap((ref) =>
  (['claude', 'codex'] as const).flatMap((provider) =>
    (['resumed', 'forked'] as const).map((origin) => ({ ref, provider, origin }))
  )
)

test.each(cases)(
  '$ref preserves pending $provider clear and respects a later old-build $origin',
  async ({ ref, provider, origin }) => {
    const checkout = await materializeReleaseCheckout(ref)
    const store = await historicalStore(checkout)
    try {
      const original = {
        ...providerContextRecordFixture(provider),
        providerContextBoundary: { operationId: 'clear', afterFence: 3, clearedAt: 5000 }
      }
      store.insert(original.sessionId, encodeAgentSessionRecord(original))
      const loaded = store.load()
      expect(loaded.unreadableRecords.size).toBe(0)
      const old = historicalRecord(loaded.records.get(original.sessionId))
      const draft = store.draft(loaded)
      draft.records.set(original.sessionId, {
        ...old,
        lease: { ...old.lease, unreconciled: false }
      })
      store.write(loaded, draft)
      expect(store.read(original.sessionId)).toEqual(encodeAgentSessionRecord(original))
      const previous = old.providerHandleChain.at(-1)
      const link = {
        linkId: 'after-downgrade',
        origin,
        mintedAtFence: 4,
        observedAt: 6000,
        handle:
          origin === 'resumed'
            ? previous.handle
            : historicalHandle(provider, 'downgrade-fork', 'transport' in previous.handle),
        ...(origin === 'forked' ? { forkedFromKey: store.key(previous.handle) } : {})
      }
      const changed = store.draft(loaded)
      changed.records.set(original.sessionId, {
        ...old,
        providerHandleChain: store.appendLink(old.providerHandleChain, link),
        lease: {
          ...old.lease,
          runtimeFence: 4,
          provenHandleLinkId: link.linkId,
          unreconciled: false
        }
      })
      store.write(loaded, changed)
      const persisted = store.read(original.sessionId)
      if (!isPersistedAgentSessionRecord(persisted)) {
        throw new Error('downgraded clear record became unreadable')
      }
      const upgraded = decodePersistedAgentSessionRecord(persisted).record
      expect(upgraded.providerContextBoundary).toEqual(original.providerContextBoundary)
      expect(upgraded.providerHandleChain.slice(0, -1)).toEqual(original.providerHandleChain)
      expect(activeProviderContext(upgraded).pendingClear).toBe(false)
      expect(activeProviderContext(upgraded).head?.origin).toBe(origin)
      expect(activeProviderContext(upgraded).head?.handle.nativeId).toBe(
        origin === 'forked'
          ? 'downgrade-fork'
          : original.providerHandleChain.at(-1)!.handle.nativeId
      )
    } finally {
      store.db.close()
    }
  },
  300_000
)

test.each(refs)(
  '%s reads clear dividers and queue membership as ordinary known rows',
  async (ref) => {
    const checkout = await materializeReleaseCheckout(ref)
    const module = await importReleaseCheckoutModule(
      checkout,
      'src/main/native-chat/agent-session-journal/journal-row-schema.ts'
    )
    const parse = module.parseJournalRow
    if (typeof parse !== 'function') {
      throw new Error('historical journal parser missing')
    }
    const base = { v: 2, epoch: 'same-epoch', fence: 3, ts: 5000 }
    const body = {
      kind: 'status',
      text: 'Context cleared',
      presentation: 'context-cleared',
      contextClear: { operationId: 'clear', afterFence: 3, clearedAt: 5000 }
    }
    expect(
      parse(
        JSON.stringify({
          ...base,
          seq: 5,
          kind: 'item',
          itemId: 'clear-divider',
          revision: 1,
          body
        })
      )
    ).toMatchObject({ ok: true, row: { body: { text: 'Context cleared' } } })
    expect(
      parse(
        JSON.stringify({
          ...base,
          seq: 6,
          kind: 'tombstone',
          itemId: 'queue-clear',
          revision: 1,
          queueClear: { operationId: 'clear', messageIds: ['waiting-one'] }
        })
      )
    ).toMatchObject({ ok: true })
  },
  300_000
)

test('shipped clients keep their earlier goal and usage until new facts arrive', async () => {
  const checkout = await materializeReleaseCheckout('v1.4.222')
  const [goals, usage] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/shared/agent-session-thread-goal.ts'),
    importReleaseCheckoutModule(checkout, 'src/shared/structured-agent-session-context-usage.ts')
  ])
  if (
    typeof goals.currentAgentSessionThreadGoal !== 'function' ||
    typeof usage.selectStructuredAgentContextUsage !== 'function'
  ) {
    throw new Error('shipped goal/usage readers missing')
  }
  const goal = {
    objective: 'Old goal',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 1,
    timeUsedSeconds: 1,
    createdAt: 1,
    updatedAt: 1
  }
  const boundary = { operationId: 'clear', afterFence: 3, clearedAt: 5000 }
  const clear = {
    itemId: 'clear',
    revision: 1,
    sequence: 5,
    observedAt: 5000,
    body: {
      kind: 'status',
      text: 'Context cleared',
      presentation: 'context-cleared',
      contextClear: boundary
    }
  }
  const oldGoal = {
    itemId: 'goal',
    revision: 1,
    sequence: 2,
    observedAt: 2,
    body: { kind: 'status', text: 'Goal set', threadGoal: { state: 'set', goal } }
  }
  expect(goals.currentAgentSessionThreadGoal([oldGoal, clear])).toEqual(goal)
  expect(
    usage.selectStructuredAgentContextUsage([
      {
        itemId: 'turn',
        revision: 1,
        sequence: 3,
        observedAt: 3,
        body: {
          kind: 'turn',
          state: 'settled',
          contextUsage: {
            used: {
              kind: 'estimate',
              usage: {
                inputTokens: 100,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                outputTokens: 1
              }
            },
            window: { tokens: 200_000 }
          }
        }
      },
      clear
    ])
  ).toMatchObject({ usedTokens: 100, windowTokens: 200_000 })
}, 300_000)
