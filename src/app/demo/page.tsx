'use client'
// Dev-only: real components with made-up data, for website / README screenshots.
import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { PipelinePage } from '../components/PipelinePage'
import { TaskBoard } from '../components/TaskBoard'
import { Sidebar } from '../components/Sidebar'
import { NewSessionDialog } from '../components/NewSessionDialog'
import type { Org } from '@/lib/orgRegistry'
import type { Pipeline, PrTrack } from '@/lib/pipelines'
import type { Task } from '@/lib/taskStore'
import type { LiveSessionInfo } from '@/hooks/useTerminal'

const now = Date.now()
const m = (min: number) => now - min * 60_000

const pipeline: Pipeline = {
  id: 'demo', liveId: 'demo', template: 'ship-it',
  config: { slackChannel: { id: 'C0', name: 'ledger-reviews' }, maxRounds: 3, auto: { openPr: true, review: true, ci: true, ready: true, merge: false, postMerge: false } },
  phase: 'tracking', workingOn: null, actedAt: m(9), createdAt: m(120), updatedAt: m(1),
  prs: [
    {
      url: 'https://github.com/tidewater/ledger/pull/482', state: 'in-review', seenFeedback: 4, reviewRounds: 1, ciFixes: 1,
      view: { number: 482, title: 'Retry failed invoice webhooks with exponential backoff', state: 'OPEN', isDraft: false, reviewDecision: null, checks: 'passing',
        requested: ['tomas-reyes'], reviews: [{ login: 'mira-osei', state: 'CHANGES_REQUESTED', at: null }, { login: 'copilot-pull-request-reviewer[bot]', state: 'COMMENTED', at: null }], fetchedAt: m(1) },
      slack: { channel: 'ledger-reviews', permalink: 'https://example.slack.com/archives/C0/p1', checkedAt: m(2), reviewers: ['Tomás'], reactions: [],
        replies: [{ user: 'Mira', text: 'Left two notes on the retry cap, otherwise looks good' }, { user: 'Tomás', text: 'Taking a look after standup' }] },
    },
    {
      url: 'https://github.com/tidewater/ledger/pull/479', state: 'ready', seenFeedback: 2, reviewRounds: 0, ciFixes: 0,
      suggestion: { kind: 'merge', text: 'https://github.com/tidewater/ledger/pull/479 is approved and CI is green. Merge it with gh pr merge, using the merge method this repo uses, and delete the branch.', at: m(3) },
      view: { number: 479, title: 'Add idempotency keys to the payouts API', state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', checks: 'passing',
        requested: [], reviews: [{ login: 'mira-osei', state: 'APPROVED', at: null }, { login: 'jun-park', state: 'APPROVED', at: null }], fetchedAt: m(1) },
      slack: { channel: 'ledger-reviews', permalink: 'https://example.slack.com/archives/C0/p2', checkedAt: m(2), reviewers: ['Mira', 'Jun'], reactions: [], replies: [{ user: 'Jun', text: 'Approved, nice cleanup' }] },
    },
  ],
  log: [
    { t: m(118), text: 'Started' },
    { t: m(96), text: 'Automatic: asking the session to open a PR' },
    { t: m(90), text: 'PR opened tidewater/ledger#479' },
    { t: m(89), text: 'Posted tidewater/ledger#479 to #ledger-reviews' },
    { t: m(41), text: 'PR opened tidewater/ledger#482' },
    { t: m(33), text: 'CI failing on tidewater/ledger#482' },
    { t: m(33), text: 'Automatic: fix CI on tidewater/ledger#482' },
    { t: m(14), text: 'New review feedback on tidewater/ledger#482' },
    { t: m(14), text: 'Automatic: fix review comments on tidewater/ledger#482' },
    { t: m(9), text: 'Session finished work on tidewater/ledger#482' },
    { t: m(3), text: 'tidewater/ledger#479 approved and CI is green. Ready to merge' },
  ],
}

// /demo?scene=board: one task walks the board (To do → In progress → Your review → PR in review → Ready to merge)
const REPO = '/home/dev/tidewater/ledger'
const task = (id: string, title: string, min: number, extra: Partial<Task> = {}): Task =>
  ({ id, title, details: '', cwd: REPO, worktree: true, ship: true, orgId: 'default', liveId: null, done: false, createdAt: m(min), ...extra })
const session = (id: string, status: LiveSessionInfo['status'], branch: string): LiveSessionInfo =>
  ({ id, cwd: REPO, gitRoot: REPO, status, claudeSessionId: null, createdAt: m(30), prUrl: null, orgId: 'default', worktree: { branch, repo: REPO } })
const shipIt = (id: string, liveId: string, prs: PrTrack[], phase: Pipeline['phase'] = 'tracking'): Pipeline =>
  ({ id, liveId, template: 'ship-it', config: { slackChannel: { id: 'C0', name: 'ledger-reviews' }, maxRounds: 3 }, phase, prs, workingOn: null, actedAt: m(5), log: [], createdAt: m(60), updatedAt: m(1) })
const pr = (n: number, title: string, state: PrTrack['state'], checks: 'pending' | 'passing', approved: boolean, slack: boolean): PrTrack => ({
  url: `https://github.com/tidewater/ledger/pull/${n}`, state, seenFeedback: 0, reviewRounds: 0, ciFixes: 0,
  suggestion: state === 'ready' ? { kind: 'merge', text: '', at: m(0) } : null,
  view: { number: n, title, state: 'OPEN', isDraft: false, reviewDecision: approved ? 'APPROVED' : null, checks, requested: [],
    reviews: approved ? [{ login: 'mira-osei', state: 'APPROVED', at: null }] : [], fetchedAt: m(0) },
  slack: slack ? { channel: 'ledger-reviews', permalink: null, checkedAt: m(1) } : undefined,
})

const HERO = 'Retry failed invoice webhooks with exponential backoff'
const STEPS_MS = [1800, 4600, 6800, 9000, 11000] // start, needs review, PR opened, CI green, approved
function boardAt(step: number) {
  const tasks = [
    task('t1', 'Fix currency rounding in the CSV export', 50, { liveId: 's1' }),
    task('t2', 'Add idempotency keys to the payouts API', 90, { liveId: 's2' }),
    task('t3', HERO, 20, step >= 1 ? { liveId: 'hero' } : {}),
    task('t4', 'Rate-limit the public export endpoint', 10),
    task('t5', 'Document the refund state machine', 5, { cwd: 'general', worktree: false, ship: false }),
    task('t6', 'Upgrade the test runner to Node 22', 200, { liveId: 's3', done: true, doneAt: m(40) }),
  ]
  const sessions = [
    session('s1', 'thinking', 'csv-rounding'), session('s2', 'idle', 'payout-idempotency'), session('s3', 'idle', 'node-22'),
    ...(step >= 1 ? [session('hero', step === 1 ? 'thinking' : step === 2 ? 'waiting' : 'idle', 'webhook-retries')] : []),
  ]
  const pipelines = [
    shipIt('p2', 's2', [pr(479, 'Add idempotency keys to the payouts API', 'in-review', 'passing', false, true)]),
    ...(step === 2 ? [shipIt('ph', 'hero', [], 'waiting-for-session')] : []),
    ...(step >= 3 ? [shipIt('ph', 'hero', [pr(486, HERO, step >= 5 ? 'ready' : 'in-review', step >= 4 ? 'passing' : 'pending', step >= 5, step >= 4)])] : []),
  ]
  return { tasks, sessions, pipelines }
}

function BoardScene() {
  const [step, setStep] = useState(0)
  useEffect(() => {
    const timers = STEPS_MS.map((ms, i) => setTimeout(() => setStep(i + 1), ms))
    return () => timers.forEach(clearTimeout)
  }, [])
  const { tasks, sessions, pipelines } = boardAt(step)
  const noop = () => {}
  return (
    <div className="fixed inset-0">
      <TaskBoard orgId="all" folders={[REPO]} liveSessions={sessions} pipelines={pipelines} demoTasks={tasks}
        onStart={noop} onOpenSession={noop} onReview={noop} onAutomate={noop} onAct={noop} onDismiss={noop} />
    </div>
  )
}

// /demo?scene=sessions (and &dialog=1): the sessions view with made-up sessions.
// Session names, settings and model lists are stubbed in the browser so nothing
// real shows and nothing is saved.
const DEMO_SESSIONS: [string, string, LiveSessionInfo['status'], number][] = [
  ['s1', 'ledger: webhook retries', 'thinking', 6],
  ['s2', 'payouts: idempotency keys', 'waiting', 14],
  ['s3', 'docs: API reference cleanup', 'waiting', 31],
  ['s4', 'web: settings page a11y', 'thinking', 48],
  ['s5', 'infra: queue autoscaling', 'idle', 180],
  ['s6', 'chat: release notes draft', 'idle', 300],
]
const ORGS = [{ id: 'default', name: 'Acme', configDir: null }, { id: 'side', name: 'Side project', configDir: null }] as Org[]
function stubFetch() {
  const real = window.fetch.bind(window)
  const json = (d: unknown) => Promise.resolve(new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } }))
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/api/session-folders')) return json(init?.method === 'PUT' ? {} : {
      folders: [{ id: 'f1', name: 'Payments' }, { id: 'f2', name: 'Docs & web' }],
      assign: { s1: 'f1', s2: 'f1', s3: 'f2', s4: 'f2' },
    })
    if (url.includes('/api/session-names')) return json({ names: Object.fromEntries(DEMO_SESSIONS.map(([id, n]) => [id, n])) })
    if (url.includes('/api/settings')) return json({ autoCompact: { enabled: true, windowTokens: 300000 }, notifications: { enabled: true } })
    if (url.includes('/api/backends')) return json({ backends: [{ id: 'claude', label: 'Claude' }, { id: 'copilot', label: 'Copilot' }] })
    if (url.includes('/api/models')) return json({ models: [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' }] })
    return real(input, init)
  }) as typeof fetch
}
const TERMINAL = `╭───────────────────────────────────────────────╮
│ ✻ Welcome to Claude Code                      │
╰───────────────────────────────────────────────╯

> Retry failed invoice webhooks with exponential backoff, with tests.

⏺ I'll add a retry queue for failed webhook deliveries.

⏺ Read(src/webhooks/deliver.ts)
  ⎿  Read 142 lines

⏺ Update(src/webhooks/deliver.ts)
  ⎿  Added 38 lines, removed 6 lines

⏺ Bash(npm test -- webhooks)
  ⎿  PASS  src/webhooks/deliver.test.ts (14 tests)

✻ Opening the pull request… (41s · esc to interrupt)`

function SessionsScene({ dialog }: { dialog: boolean }) {
  const [ready, setReady] = useState(false)
  useEffect(() => { stubFetch(); setReady(true) }, [])
  if (!ready) return null
  const noop = () => {}
  const live: LiveSessionInfo[] = DEMO_SESSIONS.map(([id, , status, min], i) => ({
    id, cwd: `/Users/you/code/${['ledger', 'payouts', 'docs', 'web', 'infra', 'chat'][i]}`, gitRoot: null, status, claudeSessionId: null,
    createdAt: m(min), prUrl: i === 1 ? 'https://github.com/tidewater/ledger/pull/479' : null, orgId: 'default', backend: 'claude',
  }))
  return (
    <div className="fixed inset-0 flex bg-[#0d1117] text-white [&_.bg-amber-500]:hidden">
      <div style={{ width: 420, flexShrink: 0 }} className="h-screen overflow-hidden border-r border-gray-800">
      <Sidebar liveSessions={live} orgs={ORGS} activeOrgId="default" onSwitchOrg={noop} historySessions={[]} historyLoading={false}
        activeSessionId="s1" selectedHistoryId={null} onAttachLive={noop} onKillLive={noop} onDeleteLive={noop} onRemoveWorktree={noop}
        onReview={noop} onResumeLive={noop} onResumeAll={noop} onCompact={noop} onSetRemote={noop} onNewSession={noop}
        onSelectHistory={noop} onDeleteSession={noop} inbox={null} inboxLoading={false} inboxRefreshing={false} onRefreshInbox={noop}
        onOpenPrDashboard={noop} meetings={[]} selectedMeetingId={null} onSelectMeeting={noop} onRecordMeeting={noop}
        onOpenMeetingLibrary={noop} pipelines={[pipeline]} onOrgsChanged={noop} onRenameLive={noop} notes={[]} setNotes={noop}
        onOpenNotes={noop} onOpenSkills={noop} onOpenSettings={noop} onOpenBoard={noop} onOpenAutomations={noop} onHome={noop}
        selectedNoteId={null} selectedSkill={null} skillsVersion={0} onAutomate={noop} usage={null} onOpenUsage={noop} />
      </div>
      <div className="flex-1 relative bg-[#111827]">
        <pre className="p-5 text-[13px] leading-[1.45] text-gray-100 font-mono whitespace-pre-wrap">{TERMINAL}</pre>
        <span className="absolute top-2 right-4 text-xs px-2.5 py-1 rounded border border-gray-700 bg-gray-900/90 text-gray-300">Chat view</span>
      </div>
      {dialog && <NewSessionDialog knownCwds={['/Users/you/code/ledger', '/Users/you/code/payouts', '/Users/you/code/web', '/Users/you/code/infra']}
        orgs={ORGS} defaultOrgId="default" onAddOrg={async () => ORGS[0]} onConfirm={noop} onResumeById={noop} onCancel={noop} />}
    </div>
  )
}

export default function Demo() {
  const [scene, setScene] = useState<string | null>(null)
  useEffect(() => { setScene(new URLSearchParams(location.search).get('scene') ?? 'pipeline') }, [])
  if (process.env.NEXT_PUBLIC_POLYERGON_ENV !== 'dev') notFound()
  if (scene === 'board') return <BoardScene />
  if (scene === 'sessions') return <SessionsScene dialog={new URLSearchParams(location.search).get('dialog') === '1'} />
  if (!scene) return null
  const noop = () => {}
  return (
    <div className="fixed inset-0">
      <div className="relative w-full h-full">
        <PipelinePage sessionName="ledger: webhook retries" pipeline={new URLSearchParams(location.search).get('setup') ? null : pipeline} error={null}
          onOpenSession={noop} onStart={noop} onStop={noop} onAddPr={noop} onSetPrReview={noop} onTell={noop} onSetPostMerge={noop} onRemovePr={noop} onFindPrs={noop} onMarkReady={noop} onAct={noop} onDismiss={noop} onSetAuto={noop} />
      </div>
    </div>
  )
}
