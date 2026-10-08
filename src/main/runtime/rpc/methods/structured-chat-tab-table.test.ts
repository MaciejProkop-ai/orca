import '../unused-default-rpc-methods.test-fixture'
/**
 * A chat tab's pointer to the conversation it shows, driven end to end: a real record store on disk,
 * the real structured host, the real runtime, and the real RPC handlers. Only the provider is faked.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionStoreFromNewerBuild
} from '../../agent-session-record-store-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from '../../runtime-rpc'
import { DeviceRegistry } from '../../device-registry'
import WebSocket from 'ws'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { SESSION_TAB_METHODS } from './session-tabs'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import { commitStructuredAgentSessionCreate } from './structured-agent-session-create'
import { closeStructuredAgentSessionChild } from '../../structured-agent-session-close'
import { openTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'
import { codexProviderHandle } from '../../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'

const WORKTREE = `id:${HOST_TEST_LOCATION.workspaceId}`
const SOURCE_TAB = `structured-agent-session-${HOST_TEST_SESSION}`
const caller = { callerKey: 'trusted-local:runtime' }

let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let runtime: OrcaRuntimeService
let dispatcher: RpcDispatcher
let acquisitions = 0
let acquireFails = false
let closeSession: ReturnType<typeof vi.fn<() => Promise<boolean>>>

function providerAdapter(): StructuredAgentSessionAdapter {
  return {
    supportsLocation: (location) =>
      location.executionHostId === 'local' && location.wslDistro === null,
    acquire: vi.fn(async (input) => {
      if (acquireFails) {
        throw new Error('provider failed to start')
      }
      acquisitions++
      return {
        process: {
          hostId: 'local',
          pid: 4000 + acquisitions,
          processStartTimeMs: HOST_TEST_NOW,
          spawnToken: input.spawnToken
        },
        link: {
          linkId: `link-${acquisitions}`,
          mintedAtFence: input.fence,
          observedAt: HOST_TEST_NOW,
          origin: 'created' as const,
          handle: codexProviderHandle(
            `00000000-0000-4000-8000-${String(acquisitions).padStart(12, '0')}`
          )
        }
      }
    }),
    dispatch: vi.fn(async () => ({ state: 'admitted' as const })),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: async () => {},
    setOption: async () => {},
    releaseAcquisition: async () => true,
    closeSession,
    readOptions: async () => ({ models: [], current: { model: 'test-model', effort: 'high' } })
  }
}

async function openHost(): Promise<void> {
  store = await openTestAgentSessionRecordStore(directory)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: providerAdapter(),
    journalDatabase: openTestJournalHostDatabase(directory),
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    mintSpawnToken: () => `spawn-${acquisitions}`
  })
  setStructuredAgentSessionHost(host)
}

type CallResponse = {
  ok: boolean
  result?: { ok?: boolean; value?: { replacementSessionId?: string } }
}

async function call(
  method: string,
  params: unknown,
  context: RpcDispatchStreamingOptions = {}
): Promise<CallResponse> {
  const response = await dispatcher.dispatch(
    { id: 'request', authToken: 'token', method, params },
    context
  )
  return JSON.parse(JSON.stringify(response))
}

async function createChat(sessionId: string, tabId?: string) {
  return commitStructuredAgentSessionCreate({
    runtime,
    caller,
    activate: true,
    prepared: {
      host,
      attachParams: hostTestAttachParams(null, {
        envelope: {
          sessionId,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: ''
        },
        ...(tabId ? { surfaceTabId: tabId } : {})
      }),
      tab: { workspaceId: HOST_TEST_LOCATION.workspaceId, agent: 'codex' }
    }
  })
}

function envelopeFor(method: string, sessionId: string, fields: Record<string, unknown>) {
  return {
    sessionId,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(sessionId)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method, sessionId, fields })
  }
}

async function clear(
  sessionId: string,
  context: RpcDispatchStreamingOptions = {}
): Promise<string> {
  const response = await call(
    'agentSession.conversationCommand',
    {
      command: 'clear',
      envelope: envelopeFor('agentSession.conversationCommand', sessionId, { command: 'clear' })
    },
    context
  )
  expect(response).toMatchObject({ ok: true, result: { ok: true } })
  const replacement = response.result?.value?.replacementSessionId
  expect(replacement).toBeUndefined()
  return sessionId
}

async function send(sessionId: string, text: string) {
  const body = hostTestMessage(text)
  return call('agentSession.send', {
    body,
    envelope: envelopeFor('agentSession.send', sessionId, { body })
  })
}

async function snapshot() {
  return runtime.listMobileSessionTabs(WORKTREE)
}

beforeEach(async () => {
  resetHostTestOperationIds()
  acquisitions = 0
  acquireFails = false
  closeSession = vi.fn(async () => true)
  directory = await mkdtemp(join(tmpdir(), 'orca-chat-tab-table-'))
  runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getClientSettings').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the structured-chat policy reads only this one setting on these paths.
    { experimentalStructuredNativeChat: true } as ReturnType<
      OrcaRuntimeService['getClientSettings']
    >
  )
  dispatcher = new RpcDispatcher({
    runtime,
    methods: [...STRUCTURED_AGENT_SESSION_METHODS, ...SESSION_TAB_METHODS]
  })
  await openHost()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await host?.flushAllStreamedEvents()
  setStructuredAgentSessionHost(null)
  await rm(directory, { recursive: true, force: true })
})

describe('a chat tab across /clear', () => {
  it('keeps one conversation and published tab through repeated clears and a new send', async () => {
    expect(await createChat(HOST_TEST_SESSION)).toMatchObject({ ok: true })
    const before = await snapshot()
    for (let round = 0; round < 3; round++) {
      expect(await clear(HOST_TEST_SESSION)).toBe(HOST_TEST_SESSION)
      expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(SOURCE_TAB)
      const published = await snapshot()
      expect(published.tabs.map((tab) => tab.id)).toEqual(before.tabs.map((tab) => tab.id))
      expect(published.tabGroups).toEqual(before.tabGroups)
      expect(published.activeTabId).toBe(before.activeTabId)
    }
    expect(await send(HOST_TEST_SESSION, 'after three clears')).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    expect((await snapshot()).tabs).toHaveLength(1)
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
    expect(store.listRecords()).toHaveLength(1)
  })

  it('records another clear while idle without starting or renaming the chat', async () => {
    await createChat(HOST_TEST_SESSION)
    await clear(HOST_TEST_SESSION)
    const first = store.getRecord(HOST_TEST_SESSION)!.providerContextBoundary
    const started = acquisitions
    await clear(HOST_TEST_SESSION)
    expect(store.getRecord(HOST_TEST_SESSION)!.providerContextBoundary).not.toEqual(first)
    expect(acquisitions).toBe(started)
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
      `agent-session:${HOST_TEST_SESSION}`
    ])
  })

  it('replays a lost answer with the same tab and one divider', async () => {
    await createChat(HOST_TEST_SESSION)
    const journal = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
    const original = journal.context.clear.bind(journal.context)
    const lost = vi.spyOn(journal.context, 'clear').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error('lost acknowledgement')
    })
    const params = {
      command: 'clear',
      envelope: envelopeFor('agentSession.conversationCommand', HOST_TEST_SESSION, {
        command: 'clear'
      })
    }
    expect((await call('agentSession.conversationCommand', params)).result?.ok).not.toBe(true)
    lost.mockRestore()
    const landed = journal.snapshot()
    expect(await call('agentSession.conversationCommand', params)).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    expect(journal.snapshot()).toEqual(landed)
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
      `agent-session:${HOST_TEST_SESSION}`
    ])
  })

  it('reveals the same tab from history instead of opening another conversation', async () => {
    await createChat(HOST_TEST_SESSION)
    await clear(HOST_TEST_SESSION)
    expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
      ok: true
    })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(SOURCE_TAB)
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
      `agent-session:${HOST_TEST_SESSION}`
    ])
  })

  it('closes the same cleared chat as settled before its next provider start', async () => {
    await createChat(HOST_TEST_SESSION)
    await clear(HOST_TEST_SESSION)
    expect(await closeStructuredAgentSessionChild(HOST_TEST_SESSION)).toEqual({
      stopped: true,
      closeAttempted: true
    })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBeNull()
  })

  it('keeps the original tab when closing the new context is unverifiable', async () => {
    await createChat(HOST_TEST_SESSION)
    await clear(HOST_TEST_SESSION)
    expect(await send(HOST_TEST_SESSION, 'new context')).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(store.getRecord(HOST_TEST_SESSION)?.lease.claimStatus).toBe('live')
    )
    closeSession.mockResolvedValueOnce(false)
    expect(await closeStructuredAgentSessionChild(HOST_TEST_SESSION)).toMatchObject({
      stopped: false
    })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(SOURCE_TAB)
  })

  it('keeps the same tab and conversation across restart', async () => {
    await createChat(HOST_TEST_SESSION)
    await clear(HOST_TEST_SESSION)
    await host.flushAllStreamedEvents()
    await openHost()
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(SOURCE_TAB)
    expect(host.getPersistedVisibleSessionTabIndex()).toEqual({
      present: true,
      sessionIds: [HOST_TEST_SESSION]
    })
  })
})

describe('other clients after a clear', () => {
  it.each(['v1.4.222', 'fd9234eed1fecab614ab1a7d4a626587b8feaec6'])(
    '%s mirrors the actual published tab without changing pane or conversation identity',
    async (ref) => {
      // Historical sources load at runtime, outside the host's TypeScript project.
      const harnessPath = join(
        import.meta.dirname,
        '../../../../../tests/e2e/cross-version-wire/release-checkout.ts'
      )
      const harness = await import(/* @vite-ignore */ harnessPath)
      if (
        typeof harness.materializeReleaseCheckout !== 'function' ||
        typeof harness.importReleaseCheckoutModule !== 'function'
      ) {
        throw new Error('historical checkout harness missing')
      }
      const checkout = await harness.materializeReleaseCheckout(ref)
      vi.doMock(`${checkout.root}/src/renderer/src/runtime/web-runtime-session.ts`, () => ({
        HOST_TERMINAL_SURFACE_SEPARATOR: '::',
        WEB_TERMINAL_SURFACE_TAB_PREFIX: 'web-terminal:',
        toWebTerminalSurfaceTabId: (id: string) => id
      }))
      vi.doMock(`${checkout.root}/src/renderer/src/runtime/runtime-terminal-stream.ts`, () => ({
        getRemoteRuntimePtyEnvironmentId: () => null
      }))
      const module = await harness.importReleaseCheckoutModule(
        checkout,
        'src/renderer/src/runtime/web-session-tabs-sync/terminal-surfaces.ts'
      )
      const build = module.buildMirroredAgentTabs
      if (typeof build !== 'function') {
        throw new Error('historical agent tab mirror missing')
      }
      expect(await createChat(HOST_TEST_SESSION)).toMatchObject({ ok: true })
      const localTabs = [
        {
          id: 'existing-local-pane',
          entityId: HOST_TEST_SESSION,
          contentType: 'agent-session',
          agentSessionAgent: 'codex',
          worktreeId: WORKTREE,
          groupId: 'existing-local-group',
          label: 'Codex Chat',
          customLabel: 'My conversation',
          color: null,
          createdAt: HOST_TEST_NOW,
          sortOrder: 0,
          isPinned: true
        }
      ]
      const mirror = async () =>
        build(await snapshot(), 'remote-host', new Map(), 'fallback', 0, localTabs, HOST_TEST_NOW)
      const before = await mirror()
      await clear(HOST_TEST_SESSION)
      expect(await mirror()).toEqual(before)
      expect(await mirror()).toMatchObject([
        {
          hostTabId: `agent-session:${HOST_TEST_SESSION}`,
          unifiedTab: {
            id: 'existing-local-pane',
            entityId: HOST_TEST_SESSION,
            groupId: 'existing-local-group',
            customLabel: 'My conversation',
            isPinned: true
          }
        }
      ])
    },
    300_000
  )

  const capabilities = [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
  ]
  it('clears through the authenticated mobile WebSocket allowlist without replacing the tab', async () => {
    await createChat(HOST_TEST_SESSION)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: directory,
      enableWebSocket: false,
      methods: [...STRUCTURED_AGENT_SESSION_METHODS, ...SESSION_TAB_METHODS]
    })
    server['deviceRegistry'] = new DeviceRegistry(directory)
    const phone = server['deviceRegistry'].addDevice('phone', 'mobile')
    const socket = WebSocket.prototype
    const replies: unknown[] = []
    const before = await snapshot()
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'mobile-clear',
        method: 'agentSession.conversationCommand',
        deviceToken: phone.token,
        params: {
          command: 'clear',
          envelope: envelopeFor('agentSession.conversationCommand', HOST_TEST_SESSION, {
            command: 'clear'
          })
        }
      }),
      (response) => replies.push(JSON.parse(response)),
      () => undefined,
      undefined,
      undefined,
      phone.token,
      {
        ws: socket,
        connectionId: 'phone-connection',
        device: { deviceId: phone.deviceId, deviceToken: phone.token, scope: 'mobile' },
        clientCapabilities: capabilities,
        transport: { transport: 'direct' }
      }
    )
    expect(replies).toMatchObject([
      { ok: true, result: { ok: true, value: { command: 'clear', state: 'completed' } } }
    ])
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual(before.tabs.map((tab) => tab.id))
    expect(store.getRecord(HOST_TEST_SESSION)?.providerContextBoundary).toBeDefined()
  })

  it.each(['runtime', 'mobile'] as const)(
    'keeps the published identity for a %s caller and a reconnecting reader',
    async (clientKind) => {
      await createChat(HOST_TEST_SESSION)
      const before = await snapshot()
      await clear(HOST_TEST_SESSION, { clientKind, clientCapabilities: capabilities })
      const listed = await dispatcher.dispatch(
        {
          id: 'reconnected',
          authToken: 'token',
          method: 'session.tabs.list',
          params: { worktree: WORKTREE }
        },
        { clientKind, clientCapabilities: capabilities }
      )
      expect(listed).toMatchObject({
        ok: true,
        result: {
          activeTabId: before.activeTabId,
          tabs: [{ id: `agent-session:${HOST_TEST_SESSION}`, sessionId: HOST_TEST_SESSION }]
        }
      })
      const current = await snapshot()
      expect(current.tabGroups).toEqual(before.tabGroups)
      expect(current.tabs[0]).not.toHaveProperty('replacesSessionId')
    }
  )
})

describe('session tab mutations from other clients, unchanged by the table', () => {
  it('reorders a group holding a chat for a paired client', async () => {
    await createChat(HOST_TEST_SESSION)
    await createChat('session-bravo')
    const ids = (await snapshot()).tabs.map((tab) => tab.id)
    const group = (await snapshot()).tabGroups![0]!

    expect(
      await call(
        'session.tabs.move',
        {
          worktree: WORKTREE,
          tabId: ids[1],
          targetGroupId: group.id,
          kind: 'reorder',
          tabOrder: ids.toReversed()
        },
        {
          clientKind: 'runtime',
          clientCapabilities: [
            STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
            CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
          ]
        }
      )
    ).toMatchObject({ ok: true })
    expect((await snapshot()).tabGroups![0]!.tabOrder).toEqual(ids.toReversed())
  })

  it('refuses an old mobile client closing a chat it may only view', async () => {
    await createChat(HOST_TEST_SESSION)

    const response = await call(
      'session.tabs.close',
      { worktree: WORKTREE, tabId: `agent-session:${HOST_TEST_SESSION}`, reason: 'user' },
      { clientKind: 'mobile', clientCapabilities: [] }
    )

    expect(response.ok).toBe(false)
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(SOURCE_TAB)
    expect((await snapshot()).tabs).toHaveLength(1)
  })
})

describe('a create that reserves its tab', () => {
  it('answers with the reserved id and refuses a second chat under it', async () => {
    expect(await createChat(HOST_TEST_SESSION, 'reserved-tab')).toMatchObject({
      ok: true,
      value: { tabId: 'reserved-tab' }
    })
    expect(await createChat('session-bravo', 'reserved-tab')).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_conflict' }
    })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe('reserved-tab')
    expect(store.getRecord('session-bravo')).toBeNull()
  })

  it('answers a create that reserved nothing with the id its tab was given', async () => {
    expect(await createChat(HOST_TEST_SESSION)).toMatchObject({
      ok: true,
      value: { tabId: SOURCE_TAB }
    })
  })

  it('restores no tab for a reserved create that stopped before its tab was published', async () => {
    const attached = await host.attach(
      caller,
      hostTestAttachParams(null, {
        envelope: {
          sessionId: HOST_TEST_SESSION,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: ''
        },
        surfaceTabId: 'reserved-tab'
      })
    )
    expect(attached).toMatchObject({ ok: true })
    await host.flushAllStreamedEvents()

    await openHost()
    expect(host.getPersistedVisibleSessionTabIndex().sessionIds).toEqual([])
    expect(await createChat('session-bravo', 'reserved-tab')).toMatchObject({
      ok: true,
      value: { tabId: 'reserved-tab' }
    })
  })

  it('leaves no tab behind when the create fails, so nothing is restored and the id is free', async () => {
    acquireFails = true
    expect(await createChat(HOST_TEST_SESSION, 'reserved-tab')).toMatchObject({ ok: false })
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBeNull()
    expect(store.listVisibleSessionIds()).toEqual([])

    acquireFails = false
    expect(await createChat('session-bravo', 'reserved-tab')).toMatchObject({
      ok: true,
      value: { tabId: 'reserved-tab' }
    })
  })
})

describe('a chat tab over records a newer Orca wrote', () => {
  it("opens a closed chat's tab from history, whose chat does not load", async () => {
    await createChat(HOST_TEST_SESSION)
    await host.close(HOST_TEST_SESSION, 'user-close')
    await host.setSessionTabVisibility(HOST_TEST_SESSION, false)
    await host.flushAllStreamedEvents()
    await seedTestAgentSessionStoreFromNewerBuild(directory)
    await openHost()
    expect(store.readOnly).toBe(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
      ok: true,
      result: { ok: true, readable: false }
    })

    expect((await snapshot()).activeTabId).toBe(`agent-session:${HOST_TEST_SESSION}`)
    expect(warn).toHaveBeenCalledWith(
      '[agent-session] tab-visibility-open: recording an opened chat tab failed',
      expect.objectContaining({ scope: 'tab-visibility-open', sessionId: HOST_TEST_SESSION })
    )
  })
})

describe('a chat tab whose restore index cannot be written', () => {
  // The index is bookkeeping: the chat is created and its tab opens, but no restart restores it.
  it('creates the chat and opens its tab, reporting the index write', async () => {
    const failure = new Error('disk I/O error')
    vi.spyOn(store, 'setSessionTabVisibility').mockRejectedValue(failure)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const created = await createChat(HOST_TEST_SESSION)

    expect(created).toMatchObject({ ok: true, value: { sessionId: HOST_TEST_SESSION } })
    expect(created.ok ? created.value.tabId : null).toBeUndefined()
    expect((await snapshot()).activeTabId).toBe(`agent-session:${HOST_TEST_SESSION}`)
    expect(warn).toHaveBeenCalledWith(
      '[agent-session] tab-visibility-open: recording an opened chat tab failed',
      { scope: 'tab-visibility-open', sessionId: HOST_TEST_SESSION, error: failure }
    )
    expect(store.getSessionTabId(HOST_TEST_SESSION)).toBeNull()
  })
})
