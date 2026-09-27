import { describe, expect, it } from 'vitest'
import { mayRetireEmptyReattach } from './empty-reattach-retire-evidence'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import { AGENT_STATUS_STATES } from '../../../../../shared/agent-status-types'

const ORIGINS = [undefined, 'worktree-sleep', 'quit', 'live'] as const

function record(
  origin: SleepingAgentSessionRecord['origin'],
  state: SleepingAgentSessionRecord['state'],
  interrupted?: boolean
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'conv-1' },
    prompt: '',
    state,
    capturedAt: 1,
    updatedAt: 1,
    ...(origin ? { origin } : {}),
    ...(interrupted === undefined ? {} : { interrupted })
  }
}

describe('mayRetireEmptyReattach truth table', () => {
  const rows = ORIGINS.flatMap((origin) =>
    AGENT_STATUS_STATES.flatMap((state) =>
      [undefined, false, true].map((interrupted) => ({
        origin,
        state,
        interrupted,
        // Only a finished pane that real hibernation captured (worktree-sleep or legacy) counts.
        expected: state === 'done' && (origin === undefined || origin === 'worktree-sleep')
      }))
    )
  )

  it.each(rows)(
    'origin=$origin state=$state interrupted=$interrupted -> $expected',
    ({ origin, state, interrupted, expected }) => {
      expect(mayRetireEmptyReattach(record(origin, state, interrupted))).toBe(expected)
    }
  )
})
