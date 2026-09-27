import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindHandleReattachResult } from './reattach-result-handler'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session-resume'

/**
 * An empty reattach (no replay) under a cold-restore resume may be retired only
 * when retiring converges: local/SSH `disconnect()` kills the PTY so the resume
 * respawns a new one, while a remote `disconnect()` only closes this viewer's
 * stream, so retiring and reconnecting lands on the same live PTY forever.
 */
const REMOTE_PTY_ID = 'remote:env-1@@term_1'
const LOCAL_PTY_ID = 'local-pty-1'
const DAEMON_SESSION_ID = 'wt-1@@daemon-session-1'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = { tabsByWorktree: {}, terminalLayoutsByTabId: {} }
  return { state }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('../terminal-freeze-breadcrumbs', () => ({ recordTerminalFreezeBreadcrumb: vi.fn() }))
vi.mock('./apply-reattach-payload', () => ({
  createReattachPayloadHandlers: (_session: unknown, ctx: { reattachPayloadApplied: boolean }) => ({
    applyReattachPayload: async () => {
      ctx.reattachPayloadApplied = true
    },
    fitAfterReattachRestore: async () => {}
  })
}))

function note(overrides: Partial<SleepingAgentSessionRecord>): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'conv-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function resumeStartup(record: SleepingAgentSessionRecord): ColdRestoreAgentResumeStartup {
  return {
    command: 'codex resume conv-1',
    agent: 'codex',
    resumeProviderSession: { key: 'session_id', id: 'conv-1' },
    launchConfig: { agentArgs: '', agentEnv: {} },
    launchToken: 'token-1',
    useLiveEntry: false,
    hasSleepingRecord: true,
    sleepingRecordEntry: { paneKey: record.paneKey, record }
  }
}

const LIVE_DONE = note({ origin: 'live' })
const WORKTREE_SLEEP_DONE = note({ origin: 'worktree-sleep' })

function buildSession(ptyId: string, overrides: Record<string, unknown> = {}) {
  const transport = { getPtyId: () => ptyId, disconnect: vi.fn() }
  const bag = {
    transport,
    disposed: false,
    transportStreamGeneration: 0,
    authoritativeReattachGeneration: 0,
    mountFollowsTerminalPark: false,
    followsDirectSshReconnect: false,
    connectionId: null,
    cacheKey: 'tab-1:leaf-1',
    directSshRetryAttempt: undefined,
    capturedDirectSshRetryPtyAccepted: false,
    pane: { id: 'pane-1', leafId: 'leaf-1', terminal: { options: { scrollback: 1000 } } },
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      paneTransportsRef: { current: new Map([['pane-1', transport]]) },
      isVisibleRef: { current: true },
      clearTabPtyId: vi.fn(),
      updateTabPtyId: vi.fn(),
      restoredLeafId: null
    },
    agentCompletionCoordinator: { startProcessTracking: vi.fn() },
    structuralReplayCoordinator: {
      run: async (task: () => Promise<void>, opts?: { afterRestore?: () => Promise<void> }) => {
        await task()
        await opts?.afterRestore?.()
      }
    },
    getSshMainModelSnapshotProbe: () => async () => null,
    serializeHiddenOutputSnapshot: vi.fn(async () => ({
      kind: 'snapshot',
      snapshot: { data: 'PROMPT $ ', cols: 80, rows: 24, seq: 1, source: 'headless' }
    })),
    retryUnverifiableParkRevealSnapshot: vi.fn(),
    warnParkRevealNoHostImage: vi.fn(),
    rejectObsoleteDirectSshReattach: () => false,
    registerEffectiveLaunchConfig: vi.fn(),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    startFreshColdRestoreAgentResume: vi.fn(),
    setPanePtyFitBinding: vi.fn(),
    reportPanePtyVisibility: vi.fn(),
    registerSideEffectFactConsumerForPty: vi.fn(),
    syncHiddenRendererPtyDelivery: vi.fn(),
    registerPaneSerializerFor: vi.fn(),
    sampleVisiblePaneForegroundAgent: vi.fn(),
    scheduleReattachIdleAgentCursorReset: vi.fn(),
    settlePaneAttachAttempt: vi.fn(),
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial bag holding every member the reattach handler reads on these paths; a missing one throws and fails the test.
  const session = bag as unknown as ConnectPanePtySession
  bindHandleReattachResult(session)
  return { session, bag }
}

type Built = ReturnType<typeof buildSession>

function expectKept({ bag }: Built, accepted: boolean, ptyId: string): void {
  expect(accepted).toBe(true)
  expect(bag.transport.disconnect).not.toHaveBeenCalled()
  expect(bag.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  expect(bag.setPanePtyFitBinding).toHaveBeenCalledWith(ptyId)
  expect(bag.syncPanePtyLayoutBinding).toHaveBeenLastCalledWith(ptyId)
}

function expectRetired(
  { bag }: Built,
  accepted: boolean,
  startup: ColdRestoreAgentResumeStartup
): void {
  expect(accepted).toBe(false)
  expect(bag.transport.disconnect).toHaveBeenCalledOnce()
  expect(bag.startFreshColdRestoreAgentResume).toHaveBeenCalledExactlyOnceWith(startup, {
    forceBlankRestoredViewport: true
  })
  expect(bag.setPanePtyFitBinding).not.toHaveBeenCalled()
}

beforeEach(() => {
  mocks.state = { tabsByWorktree: {}, terminalLayoutsByTabId: {} }
})

describe('handleReattachResult: retiring an empty reattach under a cold-restore resume', () => {
  it.each([
    ['1. live+done idle anchor', LIVE_DONE],
    ['2. worktree-sleep done note (in-pane hibernation wake)', WORKTREE_SLEEP_DONE]
  ])('%s on a remote mirrored fresh-spawn reattach: kept', async (_label, record) => {
    const built = buildSession(REMOTE_PTY_ID)
    const accepted = await built.session.handleReattachResult(
      { id: REMOTE_PTY_ID, replay: '', isReattach: true },
      null,
      resumeStartup(record)
    )
    expectKept(built, accepted, REMOTE_PTY_ID)
  })

  it('3. local fresh-spawn stable-pane adoption + worktree-sleep note: retired and resumed', async () => {
    const built = buildSession(LOCAL_PTY_ID)
    const startup = resumeStartup(WORKTREE_SLEEP_DONE)
    const accepted = await built.session.handleReattachResult(
      { id: LOCAL_PTY_ID, isReattach: true },
      null,
      startup
    )
    expectRetired(built, accepted, startup)
    expect(built.bag.syncPanePtyLayoutBinding).toHaveBeenCalledWith(null)
  })

  it('4. #9648: local reattach by session id + passive note: retired and resumed', async () => {
    const built = buildSession(DAEMON_SESSION_ID)
    const startup = resumeStartup(WORKTREE_SLEEP_DONE)
    const accepted = await built.session.handleReattachResult(
      { id: DAEMON_SESSION_ID, isReattach: true },
      DAEMON_SESSION_ID,
      startup
    )
    expectRetired(built, accepted, startup)
    expect(built.bag.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(DAEMON_SESSION_ID)
    expect(built.bag.deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', DAEMON_SESSION_ID)
  })

  it('5. local reattach + live+done idle anchor: kept (not sleep evidence)', async () => {
    const built = buildSession(DAEMON_SESSION_ID)
    const accepted = await built.session.handleReattachResult(
      { id: DAEMON_SESSION_ID, isReattach: true },
      DAEMON_SESSION_ID,
      resumeStartup(LIVE_DONE)
    )
    expectKept(built, accepted, DAEMON_SESSION_ID)
  })

  it.each([
    ['live+done', LIVE_DONE],
    ['worktree-sleep done', WORKTREE_SLEEP_DONE]
  ])('6a. remote paired-parked reveal reattach + %s note: kept', async (_label, record) => {
    const built = buildSession(REMOTE_PTY_ID, { mountFollowsTerminalPark: true })
    const accepted = await built.session.handleReattachResult(
      { id: REMOTE_PTY_ID, replay: '', isReattach: true },
      REMOTE_PTY_ID,
      resumeStartup(record)
    )
    expectKept(built, accepted, REMOTE_PTY_ID)
  })

  it.each([
    ['live+done', LIVE_DONE],
    ['worktree-sleep done', WORKTREE_SLEEP_DONE]
  ])('6b. remote host wake-hint reattach + %s note: kept', async (_label, record) => {
    const built = buildSession(REMOTE_PTY_ID)
    const accepted = await built.session.handleReattachResult(
      { id: REMOTE_PTY_ID, replay: '', isReattach: true },
      'term_1',
      resumeStartup(record)
    )
    expectKept(built, accepted, REMOTE_PTY_ID)
  })
})
