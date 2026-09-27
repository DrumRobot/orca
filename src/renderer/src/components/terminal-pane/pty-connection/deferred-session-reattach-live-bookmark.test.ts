import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { runDeferredSessionReattachChoice } from './deferred-session-reattach-choice'
import type * as PairedParkedTerminalRestore from './paired-parked-terminal-restore'

// Reproduction: a mirrored remote web-terminal pane whose host PTY is alive, with a periodic
// origin:'live' crash-recovery bookmark, must attach to that PTY, not cold-restore a fresh agent.

const TAB_ID = 'web-terminal-e88edb91-9d06-4fa5-8edc-df755eeefaeb'
const LEAF_ID = '83fd6f72-3bf5-4cdc-bb6e-aadb221abbd2'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const ENV_ID = 'abfee683-80eb-4ac3-ada0-da5d1b6303a6'
const REMOTE_PTY_ID = `remote:${ENV_ID}@@term_3fb787bf-797f-456b-bbfa-02c890c26a9f`
const WORKTREE_ID =
  'a0a2b4a4-1bff-494c-b005-d77918abc6a7::C:/Users/neil/orca/workspaces/orca/wsl-managed-cli-auto-setup'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state, startDeferredSessionReattach: vi.fn(), canRestorePairedParked: false }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('../pty-dispatcher', () => ({ getEagerPtyBufferHandle: () => null }))
vi.mock('./paired-parked-terminal-restore', async (importOriginal) => ({
  ...(await importOriginal<typeof PairedParkedTerminalRestore>()),
  canRestorePairedParkedTerminal: () => mocks.canRestorePairedParked
}))
vi.mock('./deferred-session-reattach-connect', () => ({
  startDeferredSessionReattach: mocks.startDeferredSessionReattach
}))

const now = Date.UTC(2026, 8, 25)

const codexLiveBookmark = {
  worktreeId: WORKTREE_ID,
  tabId: TAB_ID,
  leafId: LEAF_ID,
  agent: 'codex',
  providerSession: { key: 'session_id', id: '01a0d67f-39f9-7730-b725-40953894d3e7' },
  connectionId: null,
  state: 'done',
  origin: 'live',
  capturedAt: now,
  updatedAt: now,
  launchConfig: { agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'" }
}

const claudeLiveBookmark = {
  worktreeId: WORKTREE_ID,
  tabId: TAB_ID,
  leafId: LEAF_ID,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'c1a0d67f-39f9-7730-b725-40953894d3e7' },
  connectionId: ENV_ID,
  state: 'working',
  origin: 'live',
  capturedAt: now,
  updatedAt: now
}

function setStore(sleepingRecord: Record<string, unknown> | null): void {
  mocks.state = {
    tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID, ptyId: REMOTE_PTY_ID }] },
    ptyIdsByTabId: { [TAB_ID]: [REMOTE_PTY_ID] },
    sleepingAgentSessionsByPaneKey: sleepingRecord ? { [PANE_KEY]: sleepingRecord } : {},
    runtimeStatusByEnvironmentId: new Map()
  }
}

function buildSession(): ConnectPanePtySession {
  let attachedPtyId: string | null = null
  const transport = {
    attach: vi.fn((opts: { existingPtyId: string }) => {
      attachedPtyId = opts.existingPtyId
    }),
    getPtyId: () => attachedPtyId
  }
  const session = {
    pane: { id: 1, leafId: LEAF_ID },
    cacheKey: PANE_KEY,
    pendingSpawnKey: PANE_KEY,
    tabGeneration: 0,
    transport,
    cols: 80,
    rows: 24,
    disposed: false,
    hadExistingPaneTransportAtConnect: false,
    mountFollowsTerminalPark: false,
    runtimeEnvironmentId: ENV_ID,
    connectionId: null,
    allowInitialIdleCacheSeed: true,
    deps: {
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      restoredLeafId: LEAF_ID,
      restoredPtyIdByLeafId: { [LEAF_ID]: REMOTE_PTY_ID },
      paneTransportsRef: { current: new Map([[1, transport]]) },
      clearTabPtyId: vi.fn()
    },
    // Mirrors installSleepingRecordAccess's stable-key lookup, which does not filter on origin.
    getSleepingRecordForPane: (state: {
      sleepingAgentSessionsByPaneKey: Record<string, unknown>
    }) => {
      const record = state.sleepingAgentSessionsByPaneKey[PANE_KEY]
      return record ? { paneKey: PANE_KEY, record } : null
    },
    buildColdRestoreAgentResumeStartup: vi.fn(() => ({ command: 'resume' })),
    syncPanePtyLayoutBinding: vi.fn(),
    clearPaneMode2031State: vi.fn(),
    clearHiddenOutputRestoreState: vi.fn(),
    captureTransportOutputCallbacks: vi.fn(() => ({ callbacks: {}, generation: 0 })),
    bindActivePanePty: vi.fn(),
    registerPaneSerializerFor: vi.fn(),
    reportError: vi.fn(),
    startFreshSpawn: vi.fn(),
    startFreshColdRestoreAgentResume: vi.fn(),
    armDirectSshPaneRetryTimeout: vi.fn(),
    canAdoptCapturedDirectSshRetryPty: vi.fn(() => true)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test bag covers every member runDeferredSessionReattachChoice reads.
  return session as unknown as ConnectPanePtySession
}

function expectAttachedToLiveRemotePty(session: ConnectPanePtySession): void {
  expect(session.transport.attach).toHaveBeenCalledWith(
    expect.objectContaining({ existingPtyId: REMOTE_PTY_ID })
  )
  expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  expect(session.startFreshSpawn).not.toHaveBeenCalled()
  expect(session.deps.clearTabPtyId).not.toHaveBeenCalled()
  expect(session.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(null)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.canRestorePairedParked = false
})

describe('deferred reattach choice: mirrored remote pane with a live crash-recovery bookmark', () => {
  it('a. no sleeping record: attaches to the restored remote PTY', () => {
    setStore(null)
    const session = buildSession()
    runDeferredSessionReattachChoice(session)
    expectAttachedToLiveRemotePty(session)
    expect(mocks.startDeferredSessionReattach).not.toHaveBeenCalled()
  })

  it("b. origin:'live' codex bookmark (state done): still attaches to the live remote PTY", () => {
    setStore(codexLiveBookmark)
    const session = buildSession()
    runDeferredSessionReattachChoice(session)
    expectAttachedToLiveRemotePty(session)
  })

  it("c. origin:'live' claude bookmark (state working): still attaches to the live remote PTY", () => {
    setStore(claudeLiveBookmark)
    const session = buildSession()
    runDeferredSessionReattachChoice(session)
    expectAttachedToLiveRemotePty(session)
  })

  // Why: a host-mirrored tab can only attach; the host owns its liveness, so no note may divert the load.
  it.each(['worktree-sleep', 'quit'])(
    'd. genuine sleep marker (origin %s) on a mirrored tab: still attaches to the host PTY',
    (origin) => {
      setStore({ ...codexLiveBookmark, origin })
      const session = buildSession()
      runDeferredSessionReattachChoice(session)
      expectAttachedToLiveRemotePty(session)
      expect(session.buildColdRestoreAgentResumeStartup).not.toHaveBeenCalled()
    }
  )

  it("e. parked-tab mount with paired-parking capability and an origin:'live' note: reattaches without clearing the binding", () => {
    mocks.canRestorePairedParked = true
    setStore(codexLiveBookmark)
    const session = buildSession()
    Object.assign(session, { mountFollowsTerminalPark: true })
    runDeferredSessionReattachChoice(session)
    expect(mocks.startDeferredSessionReattach).toHaveBeenCalledWith(session, REMOTE_PTY_ID)
    expect(session.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(null)
    expect(session.deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
    expect(session.buildColdRestoreAgentResumeStartup).not.toHaveBeenCalled()
  })
})

describe('deferred reattach choice: client-created runtime tab keeps its sleep note', () => {
  it.each(['worktree-sleep', 'quit'])(
    'f. non-mirrored remote tab with a real sleep note (origin %s): takes the slept branch',
    (origin) => {
      const tabId = 'client-tab-1'
      const paneKey = `${tabId}:${LEAF_ID}`
      const record = { ...codexLiveBookmark, tabId, origin }
      mocks.state = {
        tabsByWorktree: { [WORKTREE_ID]: [{ id: tabId, ptyId: REMOTE_PTY_ID }] },
        ptyIdsByTabId: { [tabId]: [REMOTE_PTY_ID] },
        sleepingAgentSessionsByPaneKey: { [paneKey]: record },
        runtimeStatusByEnvironmentId: new Map()
      }
      const session = buildSession()
      Object.assign(session.deps, { tabId })
      Object.assign(session, {
        cacheKey: paneKey,
        pendingSpawnKey: paneKey,
        getSleepingRecordForPane: () => ({ paneKey, record })
      })
      runDeferredSessionReattachChoice(session)
      expect(session.transport.attach).not.toHaveBeenCalled()
      expect(session.syncPanePtyLayoutBinding).toHaveBeenCalledWith(null)
      expect(session.deps.clearTabPtyId).toHaveBeenCalledWith(tabId, REMOTE_PTY_ID)
      expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledWith({ command: 'resume' })
      expect(session.startFreshSpawn).not.toHaveBeenCalled()
    }
  )
})
