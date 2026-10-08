import type { AgentSessionProviderContextBoundary } from '../../../shared/agent-session-provider-context'
import type { JournalReducerState } from './journal-reducer'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import type { JournalQueuedMessages } from './journal-queued-messages'
import type { JournalTombstoneRow } from './journal-row-schema'
import { buildJournalQueueClearRow } from './journal-stop-and-resume-rows'

export function appendJournalContextClear(input: {
  state: () => JournalReducerState
  writer: JournalRowWriter
  cards: JournalQueuedMessages
  boundary: AgentSessionProviderContextBoundary
  receipt: JournalOperationReceipt
}) {
  const { boundary, state } = input
  return input.writer
    .enqueueRows(() => {
      const messageIds = input.cards
        .list()
        .filter((card) => card.state === 'waiting')
        .map((card) => card.messageId)
      return [
        journalItemRowBuilder(
          state,
          { provider: 'orca', clientMessageId: `context-clear:${boundary.operationId}` },
          {
            kind: 'status',
            text: 'Context cleared',
            presentation: 'context-cleared',
            contextClear: boundary
          },
          { fence: boundary.afterFence, turnScope: { kind: 'thread' } }
        ),
        (seq: number, ts: number): JournalTombstoneRow =>
          buildJournalQueueClearRow({
            state: state(),
            seq,
            ts,
            fence: boundary.afterFence,
            clear: { operationId: boundary.operationId, messageIds }
          })
      ]
    }, input.receipt)
    .then((rows) => ({
      epoch: state().epoch,
      sequence: rows.at(-1)?.seq ?? state().lastSequence
    }))
}
