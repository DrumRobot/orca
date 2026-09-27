import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'
import type { PtyConnectResult } from '../pty-transport'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

// Why not isPassiveCompletedHibernationEvidence: #16308 widened that for the wake
// sweep; a live+done note is the idle anchor of a running pane, not sleep evidence.
export function mayRetireEmptyReattach(record: SleepingAgentSessionRecord): boolean {
  return record.origin !== 'quit' && record.origin !== 'live' && record.state === 'done'
}

export function shouldRetireEmptyReattach(args: {
  ptyId: string
  connectResult: PtyConnectResult | null
  hasStructuralReplay: boolean
  coldRestoreStartup: ColdRestoreAgentResumeStartup | null | undefined
}): boolean {
  const { ptyId, connectResult, hasStructuralReplay, coldRestoreStartup } = args
  // Why: reattach drops startup commands; only passive hibernation is authority to retire an empty adopted shell and resume its provider session.
  // Never for remote: disconnect() only closes this viewer's stream, so the retry re-lands on the same live PTY and loops.
  return Boolean(
    !hasStructuralReplay &&
    connectResult?.isReattach &&
    !isRemoteRuntimePtyId(ptyId) &&
    coldRestoreStartup &&
    !coldRestoreStartup.useLiveEntry &&
    coldRestoreStartup.sleepingRecordEntry &&
    mayRetireEmptyReattach(coldRestoreStartup.sleepingRecordEntry.record)
  )
}
