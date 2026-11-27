'use client'
import { withOrg } from '@/lib/activeOrg'
import { useState, useEffect, useRef } from 'react'
import type { SessionSummary } from '@/lib/sessionStore'
import type { SessionFolders } from '@/lib/sessionFolderStore'
import type { LiveSessionInfo, SessionStatus } from '@/hooks/useTerminal'
import type { PrSessionEntry, PrStatus } from '@/lib/prTypes'
import type { PrInbox, InboxPr } from '@/lib/ghInbox'
import { repoInOrg } from '@/lib/orgFilter'
import { useSessionNames } from '@/hooks/useSessionNames'
import type { Note } from '@/lib/notesStore'
import { findDueReminder } from '@/lib/reminders'
import { OrgsDialog } from './OrgsDialog'
import { SETTINGS_CHANGED_EVENT } from '@/hooks/useDesktopNotifications'
import type { Pipeline } from '@/lib/pipelines'
import { pipelineSummary, isRunning, prSteps, preprSteps, shortPr } from '@/lib/pipelineView'
import type { Org } from '@/lib/orgRegistry'
import type { Meeting } from '@/lib/meetingStore'
import type { UsageReport, OrgUsage } from '@/lib/usageStore'
import { notificationsEnabled } from '@/hooks/useDesktopNotifications'

// Session status: blue = working, green dot + label = needs you, gray = idle.
// Only the dot and label are green; borders and badges stay neutral so the list isn't all green.
const STATUS_BORDER: Record<SessionStatus, string> = {
  thinking: 'border-l-blue-400',
  waiting:  'border-l-gray-700',
  idle:     'border-l-gray-700',
}

const STATUS_DOT: Record<SessionStatus, string> = {
  thinking: 'border-2 border-blue-400 border-t-transparent animate-spin motion-reduce:animate-none',
  waiting:  'bg-emerald-400',
  idle:     'bg-gray-600',
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  thinking: 'thinking…',
  waiting:  'waiting for input',
  idle:     'idle',
}

const STATUS_TEXT: Record<SessionStatus, string> = {
  thinking: 'text-blue-300',
  waiting:  'text-emerald-300',
  idle:     'text-gray-500',
}

interface Props {
  liveSessions: LiveSessionInfo[]
  orgs: Org[]
  activeOrgId: string // 'all' or an org id — scopes every tab
  onSwitchOrg: (id: string) => void
  historySessions: SessionSummary[]
  historyLoading: boolean
  activeSessionId: string | null
  selectedHistoryId: string | null
  sessionNameOverrides?: Record<string, string>
  onAttachLive: (id: string) => void
  onKillLive: (id: string) => void
  onRemoveWorktree: (id: string) => void
  onReview: (id: string) => void
  onDeleteLive: (id: string, claudeSessionId: string | null) => void
  onResumeLive: (id: string) => void
  onResumeAll: () => void
  onCompact: (id: string) => void
  onSetRemote: (id: string, on: boolean) => void
  onNewSession: () => void
  onSelectHistory: (sessionId: string, cwd: string | null, orgId?: string) => void
  onDeleteSession: (sessionId: string) => void
  inbox: PrInbox | null
  inboxLoading: boolean
  inboxRefreshing: boolean
  onRefreshInbox: () => void
  onOpenPrDashboard: () => void
  meetings: Meeting[]
  selectedMeetingId: string | null
  onSelectMeeting: (id: string) => void
  onRecordMeeting: () => void
  onOpenMeetingLibrary: () => void
  pipelines: Pipeline[]
  onOrgsChanged: () => void
  onRenameLive: (id: string, name: string) => void
  notes: Note[]
  setNotes: (updater: (prev: Note[]) => Note[]) => void
  onOpenNotes: (id: string | null) => void
  onOpenSkills: (name: string | null) => void
  onOpenSettings: () => void
  onOpenBoard: () => void
  onOpenSlack?: () => void // undefined = Slack not set up for this org: tab hidden
  onOpenAutomations: () => void
  onHome: () => void
  selectedNoteId: string | null
  selectedSkill: string | null
  skillsVersion: number
  onAutomate: (liveId: string) => void
  usage: UsageReport | null
  onOpenUsage: () => void
}

function isPrActionable(status: PrStatus | null): boolean {
  return status?.state === 'OPEN' && (status.reviewDecision === 'CHANGES_REQUESTED' || status.checks === 'failing')
}

function getPrBadge(status: PrStatus | null): { label: string; className: string } {
  if (!status) return { label: 'Unknown', className: 'bg-gray-800 text-gray-500' }
  if (status.state === 'MERGED') return { label: 'Merged', className: 'bg-purple-500/20 text-purple-400' }
  if (status.state === 'CLOSED') return { label: 'Closed', className: 'bg-gray-800 text-gray-500' }
  if (status.reviewDecision === 'CHANGES_REQUESTED') return { label: 'Changes requested', className: 'bg-red-500/20 text-red-400' }
  if (status.checks === 'failing') return { label: 'Checks failing', className: 'bg-red-500/20 text-red-400' }
  if (status.reviewDecision === 'APPROVED') return { label: 'Approved', className: 'bg-green-500/20 text-green-400' }
  if (status.checks === 'pending') return { label: 'Checks running', className: 'bg-yellow-500/20 text-yellow-400' }
  return { label: 'Review pending', className: 'bg-gray-800 text-gray-400' }
}

function getPrRepoLabel(prUrl: string): string {
  const match = prUrl.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
  return match ? `${match[1]}#${match[2]}` : prUrl
}

// The PR's own GitHub last-updated time once known (post-refresh); falls
// back to the session's own date so every entry always has something to
// sort/display by, even before a refresh has ever run.
function getPrEffectiveDate(e: PrSessionEntry): number {
  return e.status?.updatedAt ?? e.sessionDate
}

// Context thresholds (tokens). Bentzy's data + our own: quality degrades and
// cache cost balloons past ~600–700k; nudge from 400k.
const CTX_WARN = 400_000
const CTX_RED = 600_000
function fmtCtx(n: number): string { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k` }

// datetime-local wants local wall-clock "YYYY-MM-DDTHH:mm" (no zone)
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function fmtCost(v: number): string {
  if (v >= 100) return `$${Math.round(v)}`
  if (v >= 1) return `$${v.toFixed(2)}`
  if (v > 0) return `$${v.toFixed(2)}`
  return '$0'
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function formatRelativeDate(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  const minute = 60_000, hour = 3_600_000, day = 86_400_000
  if (diff < minute) return 'just now'
  if (diff < hour) return `${Math.round(diff / minute)}m ago`
  if (diff < day) return `${Math.round(diff / hour)}h ago`
  if (diff < day * 30) return `${Math.round(diff / day)}d ago`
  return new Date(ms).toLocaleDateString()
}

function getPrSessionTitle(e: PrSessionEntry, sessionNames: Record<string, string>, historySessions: SessionSummary[]): string {
  const key = e.sessionId
  const historyMatch = key ? historySessions.find(h => h.sessionId === key) : undefined
  const savedName = (e.liveId ? sessionNames[e.liveId] : undefined) ?? (key ? sessionNames[key] : undefined)
  return savedName
    ?? historyMatch?.firstUserMessage
    ?? e.cwd?.split('/').at(-1)
    ?? getPrRepoLabel(e.prUrl)
}

function PrSessionCard({ entry, title, isPinned, isDismissed, onTogglePin, onToggleDismiss, onRename, onAttachLive, onSelectHistory }: {
  entry: PrSessionEntry
  title: string
  isPinned: boolean
  isDismissed: boolean
  onTogglePin: (prUrl: string) => void
  onToggleDismiss: (prUrl: string) => void
  onRename: (entry: PrSessionEntry, name: string) => void
  onAttachLive: (id: string) => void
  onSelectHistory: (sessionId: string, cwd: string | null, orgId?: string) => void
}) {
  const badge = getPrBadge(entry.status)
  const repoLabel = getPrRepoLabel(entry.prUrl)

  function handleClick() {
    if (entry.source === 'live' && entry.liveId) onAttachLive(entry.liveId)
    else if (entry.sessionId) onSelectHistory(entry.sessionId, entry.cwd, entry.orgId)
  }

  return (
    <div className={`group/pr rounded-lg bg-gray-900 hover:bg-gray-800/70 transition-all cursor-pointer ${isPinned ? 'ring-1 ring-yellow-600/50' : ''} ${isDismissed ? 'opacity-50' : ''}`} onClick={handleClick}>
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <button
              onClick={e => { e.stopPropagation(); onTogglePin(entry.prUrl) }}
              className={`flex-shrink-0 text-sm leading-none ${isPinned ? 'text-yellow-400' : 'text-gray-700 hover:text-gray-400'}`}
              title={isPinned ? 'Unpin' : 'Pin this PR'}
            >📌</button>
            <InlineEdit
              value={title}
              onSave={n => onRename(entry, n)}
              className="text-sm text-gray-100 font-medium truncate"
            />
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span className={`text-xs rounded-full px-2 py-0.5 font-medium whitespace-nowrap ${badge.className}`}>{badge.label}</span>
            <button
              onClick={e => { e.stopPropagation(); onToggleDismiss(entry.prUrl) }}
              className="opacity-0 group-hover/pr:opacity-100 text-gray-600 hover:text-gray-300 text-xs"
              title={isDismissed ? 'Show again (undo dismiss)' : 'Dismiss — no longer relevant'}
            >{isDismissed ? '↺' : '×'}</button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-gray-600 truncate">
            {entry.status?.title ?? repoLabel}
            {formatRelativeDate(getPrEffectiveDate(entry)) && ` · ${formatRelativeDate(getPrEffectiveDate(entry))}`}
          </span>
          <a
            href={entry.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-xs text-blue-500 hover:text-blue-300 flex-shrink-0"
          >{repoLabel}</a>
        </div>
      </div>
    </div>
  )
}

function InboxPrCard({ pr, isDismissed, onToggleDismiss, onAttachLive, onSelectHistory }: {
  pr: InboxPr
  isDismissed: boolean
  onToggleDismiss: (url: string) => void
  onAttachLive: (id: string) => void
  onSelectHistory: (sessionId: string, cwd: string | null) => void
}) {
  const badge = getPrBadge(pr.status)
  const num = pr.url.match(/\/pull\/(\d+)/)?.[1]
  const repoLabel = `${pr.repo.split('/').at(-1)}#${num ?? '?'}`
  const hasSession = !!(pr.liveId || pr.sessionId)

  function handleClick() {
    if (pr.liveId) onAttachLive(pr.liveId)
    else if (pr.sessionId) onSelectHistory(pr.sessionId, pr.cwd)
    else window.open(pr.url, '_blank', 'noopener')
  }

  return (
    <div className={`group/inpr rounded-lg bg-gray-900 hover:bg-gray-800/70 transition-all cursor-pointer ${isDismissed ? 'opacity-50' : ''}`} onClick={handleClick}>
      <div className="px-3 py-2">
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <span className="text-sm text-gray-100 font-medium truncate flex-1" title={pr.title}>{pr.title}</span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {pr.isDraft && <span className="text-xs rounded-full px-2 py-0.5 bg-gray-800 text-gray-500">Draft</span>}
            <span className={`text-xs rounded-full px-2 py-0.5 font-medium whitespace-nowrap ${badge.className}`}>{badge.label}</span>
            <button
              onClick={e => { e.stopPropagation(); onToggleDismiss(pr.url) }}
              className="opacity-0 group-hover/inpr:opacity-100 text-gray-600 hover:text-gray-300 text-xs"
              title={isDismissed ? 'Show again' : 'Dismiss'}
            >{isDismissed ? '↺' : '×'}</button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-gray-600 truncate">
            {formatRelativeDate(pr.status?.updatedAt ?? pr.updatedAt)}
            {hasSession && <span className="text-blue-500/80"> · has session</span>}
          </span>
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-xs text-blue-500 hover:text-blue-300 flex-shrink-0"
          >{repoLabel}</a>
        </div>
      </div>
    </div>
  )
}

function getLiveSessionTitle(s: LiveSessionInfo, sessionNames: Record<string, string>, historySessions: SessionSummary[]): string {
  const historyMatch = s.claudeSessionId
    ? historySessions.find(h => h.sessionId === s.claudeSessionId)
    : undefined
  // Always use s.id as primary key — it never changes unlike claudeSessionId which is detected later
  const savedName = sessionNames[s.id] ?? (s.claudeSessionId ? sessionNames[s.claudeSessionId] : undefined)
  return savedName
    ?? historyMatch?.firstUserMessage
    ?? s.cwd.split('/').at(-1)
    ?? s.cwd
}

function LiveSessionCard({ s, isActive, sessionNames, historySessions, cost, contextTokens, compactAt, pipeline, onAutomate, onRenameLive, onAttachLive, onKillLive, onRemoveWorktree, onReview, onDeleteLive, onResume, onCompact, onSetRemote, onRename, folders, folderId, onMoveToFolder }: {
  folders?: { id: string; name: string }[]
  folderId?: string | null
  onMoveToFolder?: (id: string, folderId: string | null) => void
  pipeline: Pipeline | null
  onAutomate: (id: string) => void
  onRenameLive: (id: string, name: string) => void
  compactAt: number | null
  s: LiveSessionInfo
  isActive: boolean
  sessionNames: Record<string, string>
  historySessions: SessionSummary[]
  cost?: number
  contextTokens?: number
  onAttachLive: (id: string) => void
  onKillLive: (id: string) => void
  onRemoveWorktree: (id: string) => void
  onReview: (id: string) => void
  onDeleteLive: (id: string, claudeSessionId: string | null) => void
  onResume: (id: string) => void
  onCompact: (id: string) => void
  onSetRemote: (id: string, on: boolean) => void
  onRename: (key: string, name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function copySessionId(e: React.MouseEvent) {
    e.stopPropagation()
    const id = s.claudeSessionId
    if (!id) return
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200) }
    // navigator.clipboard can reject (page not focused / permission) — fall back
    // to a hidden textarea + execCommand so copy still works.
    const fallback = () => {
      try {
        const ta = document.createElement('textarea')
        ta.value = id; ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.focus(); ta.select()
        document.execCommand('copy'); document.body.removeChild(ta)
        done()
      } catch {}
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(id).then(done).catch(fallback)
    } else {
      fallback()
    }
  }

  const savedName = sessionNames[s.id] ?? (s.claudeSessionId ? sessionNames[s.claudeSessionId] : undefined)
  const baseTitle = getLiveSessionTitle(s, sessionNames, historySessions)
  const time = new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const title = baseTitle
  // Folder shown in the meta line — hidden for throwaway "Just chat" scratch
  // dirs (~/General/<hash>), which are noise, not a real project.
  const folderLabel = /\/General\/[^/]+$/.test(s.cwd) ? null : (s.cwd.split('/').at(-1) ?? null)

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation()
    setDraft(savedName ?? s.cwd.split('/').at(-1) ?? s.cwd)
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function commit() {
    setEditing(false)
    const trimmed = draft.trim()
    if (!trimmed) return
    // Save under s.id (stable) and also claudeSessionId (for history tab lookup)
    onRename(s.id, trimmed)
    if (s.claudeSessionId) onRename(s.claudeSessionId, trimmed)
    onRenameLive(s.id, trimmed)
  }

  return (
    <div
      className={`group/live rounded-lg border-l-2 cursor-pointer ${STATUS_BORDER[s.status]} transition-all ${isActive ? 'bg-gray-800 shadow-sm' : 'bg-gray-900 hover:bg-gray-800/70'}`}
      onClick={() => onAttachLive(s.id)}
    >
      <div className="px-3 py-2.5 min-w-0">
        {/* Title row: status dot + name + rename */}
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[s.status]}`} />
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
              onClick={e => e.stopPropagation()}
              className="bg-gray-700 text-white rounded px-1 outline-none flex-1 text-sm min-w-0"
              autoFocus
            />
          ) : (
            <span
              className="text-sm text-gray-100 font-medium truncate flex-1"
              onDoubleClick={startEdit}
              title={title}
            >{title}</span>
          )}
          {!editing && (
            <button
              onClick={startEdit}
              className="opacity-0 group-hover/live:opacity-100 text-gray-600 hover:text-gray-300 text-xs flex-shrink-0"
              title="Rename"
            >✎</button>
          )}
          {(
            <button
              onClick={e => { e.stopPropagation(); onAutomate(s.id) }}
              className={`text-xs flex-shrink-0 ${isRunning(pipeline) ? 'text-blue-400' : 'opacity-0 group-hover/live:opacity-100 text-gray-500 hover:text-yellow-300'}`}
              title="Automate: open a PR, post for review, handle feedback and CI"
            >⚡</button>
          )}
          {s.rc && s.rcUrl ? (
            <a
              href={s.rcUrl}
              target="_blank"
              rel="noreferrer"
              onClick={e => e.stopPropagation()}
              className="text-xs flex-shrink-0"
              title="Remote Control ON — open on your phone / claude.ai/code. Hover actions → Remote off."
            >📱</a>
          ) : s.rc ? (
            <span className="text-xs flex-shrink-0 opacity-40 animate-pulse" title="Remote Control pairing…">📱</span>
          ) : (
            <button
              onClick={e => { e.stopPropagation(); onSetRemote(s.id, true) }}
              className="opacity-0 group-hover/live:opacity-100 text-xs flex-shrink-0 grayscale hover:grayscale-0"
              title="Enable Remote Control for this session (continue from your phone)"
            >📱</button>
          )}
        </div>

        {pipeline && pipeline.phase !== 'stopped' && pipeline.prs.length === 0 && (
          <button onClick={e => { e.stopPropagation(); onAutomate(s.id) }} title={`Automation: ${preprSteps(pipeline)[0].label}. Click to open.`}
            className="mt-1.5 ml-4 flex items-center gap-1.5 text-[10px] text-gray-400 hover:text-gray-200">
            <span className="text-yellow-300">⚡</span>
            <span className="flex items-center">
              {preprSteps(pipeline).map((st, i) => (
                <span key={st.label} className="flex items-center">
                  {i > 0 && <span className="w-2 h-px bg-gray-700" />}
                  <span className={`w-1.5 h-1.5 rounded-full ${st.current ? (pipeline.suggestion ? 'bg-amber-400 animate-pulse' : 'bg-blue-400 animate-pulse') : 'bg-gray-700'}`} />
                </span>
              ))}
            </span>
            <span className="truncate">{preprSteps(pipeline)[0].label}</span>
          </button>
        )}
        {pipeline && pipeline.phase !== 'stopped' && pipeline.prs.length > 0 && (
          <div onClick={e => { e.stopPropagation(); onAutomate(s.id) }} className="mt-1.5 ml-4 space-y-1 cursor-pointer" title="Open automation">
            {pipeline.prs.slice(0, 3).map(t => (
              <div key={t.url} className="flex items-center gap-1.5 text-[10px] text-gray-400">
                <span className="tabular-nums w-14 truncate">{shortPr(t.url).split('/').at(-1)}</span>
                <span className="flex items-center">
                  {prSteps(t, !!pipeline.config.slackChannel).map((st, i) => (
                    <span key={st.label} className="flex items-center" title={st.label}>
                      {i > 0 && <span className={`w-2 h-px ${st.done || st.current ? 'bg-blue-500/70' : 'bg-gray-700'}`} />}
                      <span className={`w-1.5 h-1.5 rounded-full ${st.done ? 'bg-emerald-400' : st.current ? 'bg-blue-400 animate-pulse' : 'bg-gray-700'}`} />
                    </span>
                  ))}
                </span>
                <span className="flex -space-x-1 ml-1">
                  {[...(t.view?.reviews ?? []).map(r => ({ who: r.login, c: r.state === 'APPROVED' ? 'bg-emerald-600' : r.state === 'CHANGES_REQUESTED' ? 'bg-red-600' : 'bg-gray-600' })),
                    ...(t.view?.requested ?? []).map(r => ({ who: r, c: 'bg-gray-800 ring-gray-600' }))].slice(0, 4).map(r => (
                    <span key={r.who} title={r.who} className={`w-3.5 h-3.5 rounded-full ring-1 ring-gray-900 text-[8px] leading-[14px] text-center text-white uppercase ${r.c}`}>{r.who[0]}</span>
                  ))}
                </span>
                {t.view?.checks === 'failing' && <span className="text-red-400" title="CI failing">✗ CI</span>}
              </div>
            ))}
          </div>
        )}

        {pipeline && pipeline.phase !== 'stopped' && (
          <button onClick={e => { e.stopPropagation(); onAutomate(s.id) }}
            className={`mt-1.5 ml-4 text-[11px] px-1.5 py-0.5 rounded ${pipeline.phase === 'done' || pipeline.prs.some(t => t.state === 'ready') ? 'bg-emerald-500/15 text-emerald-300' : pipeline.phase === 'needs-you' || pipeline.prs.some(t => t.state === 'needs-you') ? 'bg-amber-500/15 text-amber-300' : 'bg-blue-500/15 text-blue-300'}`}>
            ⚡ {pipelineSummary(pipeline)}
          </button>
        )}
        {!!(s.gitRoot || s.prUrl || pipeline?.prs.length) && (
          <button onClick={e => { e.stopPropagation(); onReview(s.id) }}
            className="mt-1.5 ml-4 flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border border-gray-700/80 text-gray-300 hover:bg-gray-800 hover:text-white"
            title="See what this session changed, comment on lines, then send feedback or approve">
            <span className="font-mono">±</span> Review changes
          </button>
        )}

        {/* Meta row: status text · folder · time · cost · org */}
        <div className="flex items-center gap-1.5 mt-1.5 pl-4 text-[11px] min-w-0">
          {s.limitResetAt
            ? <span className="flex-shrink-0 font-medium text-amber-300" title="Claude's usage limit was reached. Polyergon sends &quot;continue&quot; a minute after it resets.">limit · resumes {new Date(s.limitResetAt + 60_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            : s.stalledSince && s.status === 'thinking'
              ? <span className="flex-shrink-0 font-medium text-amber-300" title="Says it's working, but nothing has changed for a while. Open it to check.">stalled {Math.round((Date.now() - s.stalledSince) / 60_000)}m</span>
              : <span className={`flex-shrink-0 font-medium ${STATUS_TEXT[s.status]}`}>{STATUS_LABEL[s.status]}</span>}
          {s.worktree
            ? <><span className="text-gray-700">·</span><span className="truncate text-gray-400" title={`Own worktree of ${s.worktree.repo} on branch ${s.worktree.branch}`}>⑂ {s.worktree.branch.replace(/^polyergon\//, '')}</span></>
            : folderLabel && <><span className="text-gray-700">·</span><span className="truncate text-gray-500">{folderLabel}</span></>}
          {time && <><span className="text-gray-700">·</span><span className="flex-shrink-0 text-gray-600">{time}</span></>}
        </div>

        {/* Stats row: cost pill + context meter (fills toward auto-compact, or 600k when it's off) */}
        {((cost !== undefined && cost > 0) || (!!contextTokens && contextTokens > 0)) && (() => {
          const max = compactAt ?? CTX_RED
          const level = !contextTokens ? 0 : contextTokens >= max ? 2 : contextTokens >= max * 0.8 ? 1 : 0
          return (
            <div className="flex items-center gap-2 mt-1.5 pl-4 text-[11px]">
              {cost !== undefined && cost > 0 && (
                <span className="flex-shrink-0 px-1.5 py-px rounded bg-gray-800 text-gray-300 font-medium tabular-nums" title="Estimated API-equivalent cost of this session">{fmtCost(cost)}</span>
              )}
              {!!contextTokens && contextTokens > 0 && (
                <span className="flex items-center gap-1.5 flex-1 min-w-0"
                  title={compactAt
                    ? `Context on last turn: ${contextTokens.toLocaleString()} tokens. Auto-compact runs at ${fmtCtx(compactAt)} (Settings).`
                    : `Context on last turn: ${contextTokens.toLocaleString()} tokens. Auto-compact is off. Quality drops past ~600k; compact it.`}>
                  <span className="flex-1 h-1 rounded-full bg-gray-800 overflow-hidden max-w-[90px]">
                    <span className={`block h-full rounded-full ${level === 2 ? 'bg-red-400' : level === 1 ? 'bg-amber-400' : 'bg-gray-500'}`}
                      style={{ width: `${Math.min(100, Math.max(4, (contextTokens / max) * 100))}%` }} />
                  </span>
                  <span className={`flex-shrink-0 tabular-nums ${level === 2 ? 'text-red-300' : level === 1 ? 'text-amber-300' : 'text-gray-500'}`}>{fmtCtx(contextTokens)} / {fmtCtx(max)}</span>
                </span>
              )}
            </div>
          )
        })()}

        {/* Hover actions — collapsed to zero height until hover */}
        <div className="flex items-center gap-3 pl-4 max-h-0 opacity-0 overflow-hidden group-hover/live:max-h-8 group-hover/live:opacity-100 group-hover/live:mt-2 transition-all duration-150">
          {s.status === 'waiting' && !!contextTokens && contextTokens >= (compactAt ? compactAt * 0.8 : CTX_WARN) && (
            <button
              onClick={e => { e.stopPropagation(); onCompact(s.id) }}
              className="text-[11px] text-amber-400 hover:text-amber-200 font-medium"
              title="Send /compact — summarizes the conversation to shrink context (cuts cache cost, restores quality)"
            >Compact</button>
          )}
          {s.claudeSessionId && (
            <button
              onClick={copySessionId}
              className={`text-[11px] ${copied ? 'text-emerald-400' : 'text-gray-500 hover:text-gray-200'}`}
              title="Copy this session's ID (for resuming it elsewhere)"
            >{copied ? '✓ Copied' : 'Copy ID'}</button>
          )}
          {s.rc && (
            <button
              onClick={e => { e.stopPropagation(); onSetRemote(s.id, false) }}
              className="text-[11px] text-gray-500 hover:text-gray-200"
              title="Turn Remote Control off for this session"
            >Remote off</button>
          )}
          {s.status === 'idle' && s.claudeSessionId && (
            <button
              onClick={e => { e.stopPropagation(); onResume(s.id) }}
              className="text-[11px] text-blue-500 hover:text-blue-300"
            >Resume</button>
          )}
          {onMoveToFolder && (
            <select
              value={folderId ?? ''}
              onClick={e => e.stopPropagation()}
              onChange={e => onMoveToFolder(s.id, e.target.value || null)}
              className="text-[11px] bg-transparent text-gray-500 hover:text-gray-200 outline-none cursor-pointer max-w-[7rem] truncate"
              title="Put this session in a folder"
            >
              <option value="" className="bg-gray-900">{folderId ? 'No folder' : '📁 Folder…'}</option>
              {(folders ?? []).map(f => <option key={f.id} value={f.id} className="bg-gray-900">📁 {f.name}</option>)}
              <option value="__new" className="bg-gray-900">＋ New folder</option>
            </select>
          )}
          <button
            onClick={e => { e.stopPropagation(); onKillLive(s.id) }}
            className="text-[11px] text-gray-500 hover:text-red-400 ml-auto"
            title="Stops the live process. The conversation itself isn't deleted — it stays available in the History tab."
          >Archive</button>
          {s.worktree && (
            <button
              onClick={e => { e.stopPropagation(); if (window.confirm(`Remove the worktree for branch ${s.worktree!.branch}? The session stops and its folder is deleted. The branch and any commits stay. Uncommitted changes block this.`)) onRemoveWorktree(s.id) }}
              className="text-[11px] text-gray-500 hover:text-red-400"
              title="Stop the session and delete its worktree folder. The branch and its commits are kept."
            >Remove worktree</button>
          )}
          <button
            onClick={e => {
              e.stopPropagation()
              if (window.confirm(`Delete "${title}"? It moves to a trash folder (not permanently gone), but stops the live process and disappears from both Live and History.`)) {
                onDeleteLive(s.id, s.claudeSessionId)
              }
            }}
            className="text-[11px] text-gray-500 hover:text-red-500"
            title="Stops the live process and moves the conversation to a trash folder — no longer shown in Live/History, but recoverable."
          >Delete</button>
        </div>
      </div>
    </div>
  )
}

function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  // Initialize with the default and load the saved value after mount —
  // reading localStorage in the initializer makes the server-rendered HTML
  // disagree with the client's first render (hydration error).
  const [val, setVal] = useState<T>(initial)
  useEffect(() => {
    try {
      const s = localStorage.getItem(key)
      if (s !== null) setVal(JSON.parse(s))
    } catch {}
  }, [key])
  function set(v: T) { setVal(v); try { localStorage.setItem(key, JSON.stringify(v)) } catch {} }
  return [val, set]
}

function InlineEdit({ value, onSave, className, forceEdit, onEditDone }: {
  value: string
  onSave: (v: string) => void
  className?: string
  forceEdit?: boolean
  onEditDone?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing || forceEdit) inputRef.current?.select() }, [editing, forceEdit])
  useEffect(() => { if (forceEdit) { setDraft(value); setEditing(true) } }, [forceEdit, value])

  function commit() {
    setEditing(false)
    onEditDone?.()
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onSave(trimmed)
    else setDraft(value)
  }

  if (editing || forceEdit) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') { setEditing(false); setDraft(value); onEditDone?.() }
        }}
        onClick={e => e.stopPropagation()}
        className={`bg-gray-700 text-white rounded px-1 outline-none w-full ${className}`}
      />
    )
  }
  return (
    <span className={className} onDoubleClick={e => { e.stopPropagation(); setEditing(true) }}>
      {value}
    </span>
  )
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0">
      {open
        ? <path d="M1.5 3A1.5 1.5 0 000 4.5v8A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H7.621a1.5 1.5 0 01-1.06-.44L5.5 3H1.5z"/>
        : <path d="M.54 3.87L.5 3a2 2 0 012-2h3.672a2 2 0 011.414.586l.828.828A2 2 0 009.828 3h3.982a2 2 0 011.992 2.181l-.637 7A2 2 0 0113.174 14H2.826a2 2 0 01-1.991-1.819l-.637-7a1.99 1.99 0 01.342-1.31z"/>
      }
    </svg>
  )
}

export function Sidebar({ liveSessions, orgs, activeOrgId, onSwitchOrg, historySessions, historyLoading, activeSessionId, selectedHistoryId, sessionNameOverrides, onAttachLive, onKillLive, onDeleteLive, onRemoveWorktree, onReview, onResumeLive, onResumeAll, onCompact, onSetRemote, onNewSession, onSelectHistory, onDeleteSession, inbox, inboxLoading, inboxRefreshing, onRefreshInbox, onOpenPrDashboard, meetings, selectedMeetingId, onSelectMeeting, onRecordMeeting, onOpenMeetingLibrary, pipelines, onOrgsChanged, onRenameLive, notes, setNotes, onOpenNotes, onOpenSkills, onOpenSlack, onOpenSettings, onOpenBoard, onOpenAutomations, onHome, selectedNoteId, selectedSkill, skillsVersion, onAutomate, usage, onOpenUsage }: Props) {
  // Search text is remembered per org, so switching orgs and back restores
  // whatever you'd typed in each
  const [searchByOrg, setSearchByOrg] = useState<Record<string, string>>({})
  const search = searchByOrg[activeOrgId] ?? ''
  const setSearch = (v: string) => setSearchByOrg(prev => ({ ...prev, [activeOrgId]: v }))
  // Names now live on the server (origin/browser/machine-independent) and are
  // migrated up from the old localStorage key on first load.
  const { names: sessionNames, setName } = useSessionNames()
  const sessionNamesRef = useRef(sessionNames)
  sessionNamesRef.current = sessionNames

  // Names set at creation time (from the New Session dialog) — persist them to
  // the server, but only for keys not already named (never clobber a rename).
  useEffect(() => {
    if (!sessionNameOverrides || Object.keys(sessionNameOverrides).length === 0) return
    for (const [k, v] of Object.entries(sessionNameOverrides)) {
      if (!sessionNamesRef.current[k]) setName(k, v)
    }
  }, [sessionNameOverrides]) // eslint-disable-line react-hooks/exhaustive-deps
  const [groupNames, setGroupNames] = useLocalStorage<Record<string, string>>('claude-group-names', {})
  const [collapsed, setCollapsed] = useLocalStorage<Record<string, boolean>>('claude-group-collapsed', {})
  const [sessionGroupOverrides, setSessionGroupOverrides] = useLocalStorage<Record<string, string>>('claude-session-group-overrides', {})
  const [liveOrder, setLiveOrder] = useLocalStorage<string[]>('claude-live-order', [])
  const [liveSort, setLiveSort] = useLocalStorage<'custom' | 'recent' | 'name'>('claude-live-sort', 'custom')
  // Folders for live sessions, stored on the server so every browser sees them
  const [sf, setSf] = useState<SessionFolders>({ folders: [], assign: {} })
  const [newFolderId, setNewFolderId] = useState<string | null>(null)
  useEffect(() => { fetch('/api/session-folders').then(r => r.json()).then(d => { sfRef.current = d; setSf(d) }).catch(() => {}) }, [])
  // Changes build on the latest state (not a render's stale copy) and save in order
  const sfRef = useRef(sf)
  const saving = useRef(Promise.resolve())
  function saveFolders(change: (cur: SessionFolders) => SessionFolders) {
    const next = change(sfRef.current)
    sfRef.current = next
    setSf(next)
    saving.current = saving.current
      .then(() => fetch('/api/session-folders', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) }))
      .then(() => {}, () => {})
  }
  function updateFolder(id: string, patch: { name?: string; collapsed?: boolean }) {
    saveFolders(cur => ({ ...cur, folders: cur.folders.map(f => (f.id === id ? { ...f, ...patch } : f)) }))
  }
  function deleteFolder(id: string) {
    saveFolders(cur => ({ folders: cur.folders.filter(f => f.id !== id), assign: Object.fromEntries(Object.entries(cur.assign).filter(([, f]) => f !== id)) }))
  }
  // folderId '__new' makes a folder (named inline right away) and puts the session in it
  function moveToFolder(sessionId: string | null, folderId: string | null) {
    const created = folderId === '__new' ? crypto.randomUUID() : null
    if (created) { folderId = created; setNewFolderId(created) }
    const sOrg = sessionId ? (liveSessions.find(s => s.id === sessionId)?.orgId ?? 'default') : undefined
    const orgId = sOrg ?? (activeOrgId === 'all' ? undefined : activeOrgId)
    saveFolders(cur => {
      const assign = { ...cur.assign }
      if (sessionId) { if (folderId) assign[sessionId] = folderId; else delete assign[sessionId] }
      const folders = created ? [...cur.folders, { id: created, name: 'New folder', ...(orgId ? { orgId } : {}) }]
        : cur.folders.map(f => (f.id === folderId && !f.orgId && orgId ? { ...f, orgId } : f))
      return { folders, assign }
    })
  }
  // Last time each session was opened (ms epoch), for the "Last used" sort.
  const [lastActive, setLastActive] = useLocalStorage<Record<string, number>>('claude-live-last-active', {})
  const lastActiveRef = useRef(lastActive)
  lastActiveRef.current = lastActive
  const [pinnedPrs, setPinnedPrs] = useLocalStorage<Record<string, boolean>>('claude-pinned-prs', {})
  const [dismissedPrs, setDismissedPrs] = useLocalStorage<Record<string, boolean>>('claude-dismissed-prs', {})
  const [showDismissedPrs, setShowDismissedPrs] = useState(false)
  const [mergedCollapsed, setMergedCollapsed] = useState(true)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null)
  const [dragOverLiveId, setDragOverLiveId] = useState<string | null>(null)
  const [tab, setTab] = useState<'live' | 'history' | 'prs' | 'notes' | 'meetings' | 'usage' | 'skills' | 'slack' | 'automations'>('live')
  const [showOrgs, setShowOrgs] = useState(false)
  const [compactAt, setCompactAt] = useState<number | null>(null)
  useEffect(() => {
    const load = () => fetch('/api/settings').then(r => r.json())
      .then(st => setCompactAt(st?.autoCompact?.enabled ? st.autoCompact.windowTokens : null)).catch(() => {})
    load()
    window.addEventListener(SETTINGS_CHANGED_EVENT, load)
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, load)
  }, [])

  // Persists to the server under this key (both s.id and s.claudeSessionId are
  // saved by callers, so the name resolves whichever key a card looks it up by).
  function renameSession(id: string, name: string) {
    setName(id, name)
  }
  function renameGroup(key: string, name: string) { setGroupNames({ ...groupNames, [key]: name }) }
  function toggleGroup(key: string) { setCollapsed({ ...collapsed, [key]: !collapsed[key] }) }

  // Org scoping: every tab shows only the active org's content ('all' = no
  // filter). Entries persisted before orgs existed count as 'default'.
  // historySessions itself stays unfiltered — it doubles as a name-lookup
  // table for live/PR cards, which must work across orgs.
  const inOrg = (orgId: string | null | undefined) =>
    activeOrgId === 'all' || (orgId ?? 'default') === activeOrgId
  const orgLive = liveSessions.filter(s => inOrg(s.orgId))
  const orgHistory = historySessions.filter(s => inOrg(s.orgId) && !s.headless)
  const orgMeetings = meetings.filter(m => inOrg(m.orgId))
  const recordingCount = orgMeetings.filter(m => m.status === 'recording').length

  // Sessions with a recorded position keep it; anything new is appended in
  // its existing (server) order after all explicitly-ordered sessions.
  const orderedLive = [...orgLive].sort((a, b) => {
    if (liveSort === 'recent') {
      // Most-recently-opened first; sessions never opened fall back to createdAt.
      const la = lastActive[a.id] ?? a.createdAt
      const lb = lastActive[b.id] ?? b.createdAt
      return lb - la
    }
    if (liveSort === 'name') {
      return getLiveSessionTitle(a, sessionNames, historySessions)
        .localeCompare(getLiveSessionTitle(b, sessionNames, historySessions), undefined, { sensitivity: 'base' })
    }
    const ia = liveOrder.indexOf(a.id)
    const ib = liveOrder.indexOf(b.id)
    if (ia === -1 && ib === -1) return 0
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  }).filter(s => {
    if (!search) return true
    const title = getLiveSessionTitle(s, sessionNames, historySessions)
    const folder = s.cwd.split('/').at(-1) ?? s.cwd
    return title.toLowerCase().includes(search.toLowerCase()) ||
      folder.toLowerCase().includes(search.toLowerCase())
  })

  function moveLiveSession(draggedId: string, targetId: string) {
    if (draggedId === targetId) return
    const current = orderedLive.map(s => s.id).filter(id => id !== draggedId)
    const targetIdx = current.indexOf(targetId)
    current.splice(targetIdx, 0, draggedId)
    setLiveOrder(current)
  }

  const folderOf = (id: string): string | null => {
    const f = sf.assign[id]
    return f && sf.folders.some(x => x.id === f) ? f : null
  }
  // A folder belongs to one org. Older folders have no orgId: they take the org of a session in them.
  const folderOrg = (f: SessionFolders['folders'][number]): string | null => {
    if (f.orgId) return f.orgId
    const s = liveSessions.find(x => sf.assign[x.id] === f.id)
    return s ? (s.orgId ?? 'default') : null
  }
  const orgFolders = sf.folders.filter(f => activeOrgId === 'all' || folderOrg(f) === activeOrgId)
  const foldersFor = (s: LiveSessionInfo) => sf.folders.filter(f => { const o = folderOrg(f); return !o || o === (s.orgId ?? 'default') })

  const renderLive = (s: LiveSessionInfo) => (
                  <div
                    key={s.id}
                    draggable
                    onDragStart={e => {
                      e.dataTransfer.setData('text/live-session-id', s.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={e => { e.preventDefault(); setDragOverLiveId(s.id) }}
                    onDragLeave={() => setDragOverLiveId(prev => (prev === s.id ? null : prev))}
                    onDrop={e => {
                      e.preventDefault()
                      setDragOverLiveId(null)
                      const draggedId = e.dataTransfer.getData('text/live-session-id')
                      if (draggedId) { moveLiveSession(draggedId, s.id); if (folderOf(draggedId) !== folderOf(s.id)) moveToFolder(draggedId, folderOf(s.id)) }
                    }}
                    className={`cursor-grab active:cursor-grabbing rounded-lg transition-colors ${
                      dragOverLiveId === s.id ? 'ring-2 ring-blue-600' : ''
                    }`}
                  >
                    <LiveSessionCard
                      s={s}
                      isActive={activeSessionId === s.id}
                      sessionNames={sessionNames}
                      historySessions={historySessions}
                      cost={s.claudeSessionId ? usage?.sessions[s.claudeSessionId]?.costUSD : undefined}
                      contextTokens={s.claudeSessionId ? usage?.sessions[s.claudeSessionId]?.contextTokens : undefined}
                      onCompact={onCompact}
                      pipeline={[...pipelines].reverse().find(p => p.liveId === s.id) ?? null}
                      onAutomate={onAutomate}
                      onSetRemote={onSetRemote}
                      onAttachLive={onAttachLive}
                      onKillLive={onKillLive}
                      onRemoveWorktree={onRemoveWorktree}
                      onReview={onReview}
                      onDeleteLive={onDeleteLive}
                      onResume={onResumeLive}
                      onRename={renameSession}
                      onRenameLive={onRenameLive}
                      compactAt={compactAt}
                      folders={foldersFor(s)}
                      folderId={folderOf(s.id)}
                      onMoveToFolder={moveToFolder}
                    />
                  </div>
  )

  function togglePinPr(prUrl: string) {
    setPinnedPrs({ ...pinnedPrs, [prUrl]: !pinnedPrs[prUrl] })
  }

  function toggleDismissPr(prUrl: string) {
    setDismissedPrs({ ...dismissedPrs, [prUrl]: !dismissedPrs[prUrl] })
  }

  // Saves under both the live id and the history session id (like
  // LiveSessionCard.commit does) so the name sticks whichever tab you're
  // looking at it from, and survives the session moving live <-> history.
  function renamePrEntry(entry: PrSessionEntry, name: string) {
    if (entry.liveId) renameSession(entry.liveId, name)
    if (entry.sessionId) renameSession(entry.sessionId, name)
  }

  // (Legacy localStorage notes are migrated up to the server inside useNotes.)

  // --- reminders ---
  const notesRef = useRef(notes)
  notesRef.current = notes
  const [dueNote, setDueNote] = useState<Note | null>(null)

  function setReminder(id: string, localValue: string) {
    const remindAt = localValue ? new Date(localValue).getTime() : undefined
    setNotes(prev => prev.map(n => n.id === id ? { ...n, remindAt, reminderDone: false } : n))
  }

  // Poll every 30s (and on load) for a due reminder: show the in-app banner,
  // fire a desktop notification when allowed, and mark it fired so it doesn't
  // re-alert. Marking goes through setNotes, so it persists server-side.
  useEffect(() => {
    const check = () => {
      const due = findDueReminder(notesRef.current)
      if (!due) return
      setDueNote(due)
      setNotes(prev => prev.map(n => n.id === due.id ? { ...n, reminderDone: true } : n))
      if (notificationsEnabled() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('Reminder', { body: due.text.slice(0, 200) })
      }
    }
    check()
    const t = setInterval(check, 30_000)
    return () => clearInterval(t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps



  // Inbox sections: scoped to the active org (via GitHub-owner mapping),
  // dismissed items hidden (unless toggled), search filters by title/repo.
  // Section order is the priority order — no sort modes.
  const matchesSearch = (title: string, repo: string) =>
    !search || title.toLowerCase().includes(search.toLowerCase()) || repo.toLowerCase().includes(search.toLowerCase())
  const inOrgRepo = (p: InboxPr) => repoInOrg(p.repo, activeOrgId, orgs)
  const filterInbox = (items: InboxPr[]) => items.filter(p =>
    inOrgRepo(p) && (showDismissedPrs || !dismissedPrs[p.url]) && matchesSearch(p.title, p.repo))
  const inboxSections: { key: string; title: string; accent: string; items: InboxPr[] }[] = inbox ? [
    { key: 'needsReview', title: 'Needs your review', accent: 'text-red-400', items: filterInbox(inbox.sections.needsReview) },
    { key: 'returned', title: 'Returned to you', accent: 'text-orange-400', items: filterInbox(inbox.sections.returned) },
    { key: 'waiting', title: 'Waiting on others', accent: 'text-yellow-500', items: filterInbox(inbox.sections.waiting) },
    { key: 'mergedRecent', title: 'Recently merged', accent: 'text-purple-400', items: filterInbox(inbox.sections.mergedRecent) },
  ] : []
  const fromSessions = (inbox?.fromSessions ?? []).filter(e =>
    inOrg(e.orgId) && (showDismissedPrs || !dismissedPrs[e.prUrl]) &&
    matchesSearch(getPrSessionTitle(e, sessionNames, historySessions), getPrRepoLabel(e.prUrl)))
  const orgInboxAll = inbox ? Object.values(inbox.sections).flat().filter(inOrgRepo) : []
  const dismissedPrCount = inbox
    ? [...orgInboxAll.map(p => p.url), ...inbox.fromSessions.filter(e => inOrg(e.orgId)).map(e => e.prUrl)]
        .filter(url => dismissedPrs[url]).length
    : 0
  // Tab badge: what actually needs you — review requests + returned PRs
  const actionablePrCount = inbox
    ? [...inbox.sections.needsReview, ...inbox.sections.returned].filter(p => inOrgRepo(p) && !dismissedPrs[p.url]).length
    : 0
  const nonDismissedPrCount = orgInboxAll.filter(p => !dismissedPrs[p.url]).length

  const filtered = orgHistory.filter(s => {
    const name = sessionNames[s.sessionId] ?? s.firstUserMessage ?? ''
    const groupKey = sessionGroupOverrides[s.sessionId] ?? s.gitRoot ?? s.cwd ?? s.projectEncoded
    const group = groupNames[groupKey] ?? groupKey.split('/').at(-1) ?? groupKey
    return name.toLowerCase().includes(search.toLowerCase()) ||
      group.toLowerCase().includes(search.toLowerCase())
  })

  const groupMap = new Map<string, SessionSummary[]>()
  for (const s of filtered) {
    const key = sessionGroupOverrides[s.sessionId] ?? s.gitRoot ?? s.cwd ?? s.projectEncoded
    if (!groupMap.has(key)) groupMap.set(key, [])
    groupMap.get(key)!.push(s)
  }
  const groups = Array.from(groupMap.values()).sort((a, b) => {
    const ta = a[0].lastTimestamp ?? '', tb = b[0].lastTimestamp ?? ''
    return tb > ta ? 1 : tb < ta ? -1 : 0
  })

  // Auto-switch to live tab when a new session becomes active, and stamp it as
  // most-recently-used (drives the "Last used" sort).
  useEffect(() => {
    if (!activeSessionId) return
    setTab('live')
    setLastActive({ ...lastActiveRef.current, [activeSessionId]: Date.now() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  return (
    <aside className="w-full flex-shrink-0 bg-gray-950 text-white flex flex-col h-screen">
      {/* Header */}
      <div className="px-3 pt-4 pb-3 border-b border-gray-800/60">
        <div className="flex items-center justify-between">
          <span onClick={onHome} title="Home" className="cursor-pointer text-sm font-bold text-white tracking-tight px-1 hover:text-blue-300">Polyergon<span className="ml-1.5 text-[10px] font-normal text-gray-500" title="Polyergon version">v{process.env.NEXT_PUBLIC_POLYERGON_VERSION}</span>{process.env.NEXT_PUBLIC_POLYERGON_ENV === 'dev' && <span className="ml-2 text-[10px] font-semibold bg-amber-500 text-black rounded px-1.5 py-0.5">DEV</span>}</span>
          <button onClick={onOpenSettings} title="Settings" className="flex items-center gap-1.5 text-xs font-medium text-gray-200 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-md px-2.5 py-1 transition-colors"><span className="text-sm leading-none">⚙</span>Settings</button>
        </div>

        {showOrgs && <OrgsDialog orgs={orgs} onClose={() => setShowOrgs(false)} onChanged={onOrgsChanged} />}

        {/* Org switcher — scopes every tab below to one org. Always shown so orgs can be added. */}
        {(
          <div className="flex gap-1 mt-3 bg-gray-900 rounded-lg p-1">
            <button
              onClick={() => onSwitchOrg('all')}
              className={`flex-1 py-1 rounded-md text-xs font-medium transition-colors truncate ${
                activeOrgId === 'all' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >All</button>
            {orgs.map(o => (
              <button
                key={o.id}
                onClick={() => onSwitchOrg(o.id)}
                title={o.name}
                className={`flex-1 py-1 rounded-md text-xs font-medium transition-colors truncate ${
                  activeOrgId === o.id ? 'bg-purple-800/80 text-purple-100' : 'text-gray-500 hover:text-gray-300'
                }`}
              >{o.name}</button>
            ))}
            <button onClick={() => setShowOrgs(true)} title="Add or edit orgs"
              className="px-2 py-1 rounded-md text-xs text-gray-500 hover:text-white hover:bg-gray-800 flex-shrink-0">＋</button>
          </div>
        )}

        <div className="flex gap-2 mt-3">
          <button
            onClick={onNewSession}
            className="flex-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-3 py-2 text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            <span className="text-base leading-none">+</span> New Session
          </button>
          <button
            onClick={onOpenBoard}
            title="Task board: plan tasks and follow each one from session to merged PR"
            className="bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm font-medium transition-colors flex items-center justify-center gap-1.5"
          >
            <span className="text-gray-400">▦</span> Board
          </button>
          <button
            onClick={onRecordMeeting}
            title="Record a meeting"
            className="bg-gray-800 hover:bg-red-900/60 text-red-400 rounded-lg px-3 py-2 text-sm font-medium transition-colors flex items-center justify-center"
          >
            <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
          </button>
        </div>
      </div>

      {/* Tabs — grid; 4+ tabs in one row got too cramped */}
      <div className="grid grid-cols-[1fr_1fr_1.2fr] border-b border-gray-800/60">
        <button
          onClick={() => setTab('live')}
          className={`py-2.5 text-xs font-semibold tracking-wide flex items-center justify-center gap-1.5 transition-colors border-b-2 ${
            tab === 'live'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Live
          {orgLive.length > 0 && (
            <span className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${tab === 'live' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-800 text-gray-500'}`}>
              {orgLive.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('history')}
          className={`py-2.5 text-xs font-semibold tracking-wide flex items-center justify-center gap-1.5 transition-colors border-b-2 ${
            tab === 'history'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          History
          {groups.length > 0 && (
            <span className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${tab === 'history' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-800 text-gray-500'}`}>
              {groups.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('prs')}
          className={`py-2.5 text-xs font-semibold tracking-wide flex items-center justify-center gap-1.5 transition-colors border-b-2 ${
            tab === 'prs'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          PRs
          {nonDismissedPrCount > 0 && (
            <span className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${
              actionablePrCount > 0 ? 'bg-red-500/20 text-red-400' : tab === 'prs' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-800 text-gray-500'
            }`}>
              {actionablePrCount > 0 ? actionablePrCount : nonDismissedPrCount}
            </span>
          )}
        </button>
        <button
          onClick={() => { setTab('notes'); onOpenNotes(null) }}
          className={`py-2.5 text-xs font-semibold tracking-wide flex items-center justify-center gap-1.5 transition-colors border-b-2 ${
            tab === 'notes'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Notes
        </button>
        <button
          onClick={() => { setTab('meetings'); onOpenMeetingLibrary() }}
          className={`py-2.5 text-xs font-semibold tracking-wide flex items-center justify-center gap-1.5 transition-colors border-b-2 ${
            tab === 'meetings'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Meetings
          {recordingCount > 0 && (
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          )}
        </button>
        <button
          onClick={() => { setTab('usage'); onOpenUsage() }}
          className={`py-2.5 text-xs font-semibold tracking-wide flex items-center justify-center gap-1.5 transition-colors border-b-2 ${
            tab === 'usage'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Usage
        </button>
        <button
          onClick={() => { setTab('skills'); onOpenSkills(null) }}
          className={`py-2.5 text-xs font-semibold tracking-wide flex items-center justify-center gap-1.5 transition-colors border-b-2 ${
            tab === 'skills'
              ? 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Skills
        </button>
        {onOpenSlack && <button
          onClick={() => { setTab('slack'); onOpenSlack() }}
          className={`py-2.5 text-xs font-semibold tracking-wide flex items-center justify-center gap-1.5 transition-colors border-b-2 ${
            tab === 'slack' ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Slack
        </button>}
        <button
          onClick={() => { setTab('automations'); onOpenAutomations() }}
          className={`py-2.5 pr-1 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors border-b-2 ${
            tab === 'automations' ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          <span className="whitespace-nowrap">Automations</span>
          {pipelines.filter(isRunning).length > 0 && (
            <span title={`${pipelines.filter(isRunning).length} running`} className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${tab === 'automations' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-800 text-gray-500'}`}>
              {pipelines.filter(isRunning).length}
            </span>
          )}
        </button>
      </div>

      {/* Search — shared across live/history/PRs/skills tabs */}
      {tab !== 'notes' && tab !== 'meetings' && tab !== 'usage' && tab !== 'slack' && tab !== 'automations' && tab !== 'skills' && (
        <div className="px-3 py-2 border-b border-gray-800/40">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
            </svg>
            <input
              type="text"
              placeholder={tab === 'live' ? 'Search live sessions…' : tab === 'prs' ? 'Search PRs…' : 'Search sessions…'}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-gray-900 text-white rounded-lg pl-8 pr-3 py-2 text-sm placeholder-gray-600 outline-none border border-gray-800 focus:border-gray-600 transition-colors"
            />
          </div>
        </div>
      )}

      {/* Live tab */}
      {tab === 'live' && (
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {orgLive.length > 0 && (
            <div className="flex items-center justify-end gap-1 mb-2 text-[11px]">
              <button
                onClick={() => moveToFolder(null, '__new')}
                className="mr-auto text-gray-500 hover:text-gray-200"
                title="Make a folder, then drag sessions into it"
              >＋ New folder</button>
              <span className="text-gray-600 mr-0.5">Sort:</span>
              <button
                onClick={() => setLiveSort('custom')}
                className={liveSort === 'custom' ? 'text-blue-400 font-medium' : 'text-gray-500 hover:text-gray-300'}
                title="Your manual drag order"
              >Custom</button>
              <span className="text-gray-700">·</span>
              <button
                onClick={() => setLiveSort('recent')}
                className={liveSort === 'recent' ? 'text-blue-400 font-medium' : 'text-gray-500 hover:text-gray-300'}
                title="Most recently opened first"
              >Last used</button>
              <span className="text-gray-700">·</span>
              <button
                onClick={() => setLiveSort('name')}
                className={liveSort === 'name' ? 'text-blue-400 font-medium' : 'text-gray-500 hover:text-gray-300'}
                title="Alphabetical by name"
              >Name</button>
            </div>
          )}
          {orgLive.filter(s => s.status === 'idle' && s.claudeSessionId).length > 1 && (
            <button
              onClick={onResumeAll}
              className="w-full mb-2 bg-gray-800 hover:bg-gray-700 text-blue-400 rounded-lg px-3 py-1.5 text-xs font-medium"
            >⟳ Resume all ({orgLive.filter(s => s.status === 'idle' && s.claudeSessionId).length} idle)</button>
          )}
          {orderedLive.length === 0 && orgFolders.length === 0
            ? <p className="text-xs text-gray-600 text-center mt-8">No active sessions</p>
            : <div className="flex flex-col gap-1.5">
                {orgFolders.map(f => {
                  const items = orderedLive.filter(s => folderOf(s.id) === f.id)
                  if (search && !items.length) return null
                  const open = !f.collapsed || !!search
                  const waiting = items.filter(s => s.status === 'waiting').length
                  return (
                    <div key={f.id}>
                      <div
                        onClick={() => updateFolder(f.id, { collapsed: !f.collapsed })}
                        onDragOver={e => { e.preventDefault(); setDragOverGroup(f.id) }}
                        onDragLeave={() => setDragOverGroup(prev => (prev === f.id ? null : prev))}
                        onDrop={e => {
                          e.preventDefault()
                          setDragOverGroup(null)
                          const id = e.dataTransfer.getData('text/live-session-id')
                          if (id) moveToFolder(id, f.id)
                        }}
                        title="Click to open or close. Double-click the name to rename. Drag sessions here."
                        className={`group/folder flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-gray-400 hover:bg-gray-800/60 transition-colors ${dragOverGroup === f.id ? 'ring-2 ring-blue-600 bg-blue-950/30' : ''}`}
                      >
                        <span className={`text-[9px] text-gray-600 transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
                        <FolderIcon open={open} />
                        <InlineEdit
                          value={f.name}
                          onSave={name => updateFolder(f.id, { name })}
                          forceEdit={newFolderId === f.id}
                          onEditDone={() => setNewFolderId(null)}
                          className="text-xs font-semibold flex-1 truncate"
                        />
                        {waiting > 0 && <span className="text-[10px] text-amber-400" title={`${waiting} waiting for you`}>● {waiting}</span>}
                        <span className="text-[11px] text-gray-600">{items.length}</span>
                        <button
                          onClick={e => { e.stopPropagation(); deleteFolder(f.id) }}
                          className="opacity-0 group-hover/folder:opacity-100 text-gray-600 hover:text-red-400 text-xs"
                          title="Delete this folder. Its sessions go back to the main list; nothing is stopped."
                        >✕</button>
                      </div>
                      {open && (
                        <div className="flex flex-col gap-1.5 mt-1.5 ml-2 pl-2 border-l border-gray-800">
                          {items.length ? items.map(renderLive) : <p className="text-[11px] text-gray-600 px-1 py-1">Drag sessions here, or use Folder on a session.</p>}
                        </div>
                      )}
                    </div>
                  )
                })}
                {orgFolders.length > 0 && orderedLive.some(s => !folderOf(s.id)) && (
                  <div
                    onDragOver={e => { e.preventDefault(); setDragOverGroup('') }}
                    onDragLeave={() => setDragOverGroup(null)}
                    onDrop={e => { e.preventDefault(); setDragOverGroup(null); const id = e.dataTransfer.getData('text/live-session-id'); if (id) moveToFolder(id, null) }}
                    className={`mt-1 px-2 py-1 text-[11px] uppercase tracking-wide text-gray-600 rounded ${dragOverGroup === '' ? 'ring-2 ring-blue-600' : ''}`}
                  >Not in a folder</div>
                )}
                {orderedLive.filter(s => !folderOf(s.id)).map(renderLive)}
              </div>
          }
        </div>
      )}

      {/* History tab */}
      {tab === 'history' && (
        <>
          <div className="overflow-y-auto flex-1 px-2 pb-4">
        {historyLoading && <p className="p-4 text-gray-600 text-xs">Loading…</p>}
        {groups.map(projectSessions => {
          const key = projectSessions[0].gitRoot ?? projectSessions[0].cwd ?? projectSessions[0].projectEncoded
          const rawLabel = projectSessions[0].gitRoot ?? projectSessions[0].cwd ?? projectSessions[0].projectPath
          const groupLabel = groupNames[key] ?? rawLabel.split('/').at(-1) ?? rawLabel
          const isCollapsed = collapsed[key]
          const isDragOver = dragOverGroup === key

          return (
            <div key={key} className="mt-3">
              {/* Group header */}
              <div
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer group transition-colors ${
                  isDragOver ? 'bg-blue-900/30 border border-dashed border-blue-600' : 'hover:bg-gray-800/50'
                }`}
                onClick={() => toggleGroup(key)}
                onDragOver={e => { e.preventDefault(); setDragOverGroup(key) }}
                onDragLeave={() => setDragOverGroup(null)}
                onDrop={e => {
                  e.preventDefault()
                  setDragOverGroup(null)
                  const sessionId = e.dataTransfer.getData('text/session-id')
                  if (sessionId) setSessionGroupOverrides({ ...sessionGroupOverrides, [sessionId]: key })
                }}
              >
                <span className="text-gray-500 group-hover:text-gray-400 transition-colors">
                  <FolderIcon open={!isCollapsed} />
                </span>
                <InlineEdit
                  value={groupLabel}
                  onSave={name => renameGroup(key, name)}
                  className="text-xs font-semibold text-gray-400 group-hover:text-gray-300 flex-1 truncate transition-colors"
                />
                <span className="text-xs text-gray-700 bg-gray-800 rounded-full px-1.5 py-0.5 font-medium ml-auto flex-shrink-0">
                  {projectSessions.length}
                </span>
              </div>

              {/* Session rows */}
              {!isCollapsed && (
                <div className="ml-3 mt-0.5 border-l border-gray-800/60 pl-2">
                  {projectSessions.map(s => {
                    const name = sessionNames[s.sessionId] ?? s.title ?? s.firstUserMessage ?? 'Empty session'
                    const isActive = selectedHistoryId === s.sessionId
                    const isEditing = editingSessionId === s.sessionId

                    return (
                      <div
                        key={s.sessionId}
                        draggable
                        onDragStart={e => {
                          e.dataTransfer.setData('text/session-id', s.sessionId)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        className={`group/session flex items-stretch rounded-md transition-colors cursor-grab active:cursor-grabbing ${
                          isActive ? 'bg-gray-800 border-l-2 border-l-blue-500 -ml-px' : 'hover:bg-gray-800/50'
                        }`}
                      >
                        <button
                          onClick={() => onSelectHistory(s.sessionId, s.cwd, s.orgId)}
                          className="flex-1 text-left px-2 py-2 min-w-0"
                        >
                          <div className="flex items-center gap-1 min-w-0">
                            <InlineEdit
                              value={name}
                              onSave={n => renameSession(s.sessionId, n)}
                              forceEdit={isEditing}
                              onEditDone={() => setEditingSessionId(null)}
                              className="text-xs text-gray-300 flex-1 truncate leading-relaxed"
                            />
                            {!isEditing && (
                              <button
                                onClick={e => { e.stopPropagation(); setEditingSessionId(s.sessionId) }}
                                className="opacity-0 group-hover/session:opacity-100 text-gray-600 hover:text-gray-300 text-xs flex-shrink-0"
                                title="Rename"
                              >✎</button>
                            )}
                          </div>
                          <p className="text-xs text-gray-600 mt-0.5">
                            {s.messageCount} msgs · {s.lastTimestamp ? new Date(s.lastTimestamp).toLocaleDateString() : '—'}
                            {(usage?.sessions[s.sessionId]?.costUSD ?? 0) > 0 && (
                              <span className="text-emerald-700"> · {fmtCost(usage!.sessions[s.sessionId].costUSD)}</span>
                            )}
                          </p>
                        </button>
                        <button
                          onClick={e => {
                            e.stopPropagation()
                            if (window.confirm(`Delete "${name}"? It moves to a trash folder (not permanently gone), but disappears from here.`)) {
                              onDeleteSession(s.sessionId)
                            }
                          }}
                          className="opacity-0 group-hover/session:opacity-100 px-2 text-gray-600 hover:text-red-400 transition-all flex-shrink-0 text-sm"
                          title="Delete session"
                        >×</button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
        </>
      )}

      {/* PRs tab — GitHub workload inbox */}
      {tab === 'prs' && (
        <>
          <div className="px-3 py-2 border-b border-gray-800/40 flex items-center justify-between gap-2">
            <span className="text-xs text-gray-600">
              {inbox ? `${nonDismissedPrCount} open · updated ${formatRelativeDate(inbox.fetchedAt)}` : 'Loading your GitHub PRs…'}
            </span>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                onClick={onOpenPrDashboard}
                className="bg-gray-800 hover:bg-gray-700 text-gray-200 rounded px-2.5 py-1 text-xs font-medium"
                title="Open PR dashboard"
              >📊 Stats</button>
              <button
                onClick={onRefreshInbox}
                disabled={inboxRefreshing}
                className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-200 rounded px-2.5 py-1 text-xs font-medium flex items-center gap-1.5"
              >
                {inboxRefreshing && <span className="inline-block w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />}
                {inboxRefreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </div>
          {inbox?.error && (
            <div className="px-3 py-1.5 border-b border-yellow-800/40 bg-yellow-900/20 text-yellow-500 text-xs">{inbox.error}</div>
          )}
          {dismissedPrCount > 0 && (
            <div className="px-3 py-1.5 border-b border-gray-800/40">
              <button
                onClick={() => setShowDismissedPrs(v => !v)}
                className="text-xs text-gray-600 hover:text-gray-400"
              >{showDismissedPrs ? `Hide dismissed (${dismissedPrCount})` : `Show ${dismissedPrCount} dismissed`}</button>
            </div>
          )}
          <div className="flex-1 overflow-y-auto px-3 py-3">
            {inboxLoading && !inbox
              ? <p className="text-xs text-gray-600 text-center mt-8">Loading…</p>
              : <div className="flex flex-col gap-4">
                  {inboxSections.map(section => {
                    const isMerged = section.key === 'mergedRecent'
                    const collapsed = isMerged && mergedCollapsed
                    return (
                      <div key={section.key}>
                        <button
                          onClick={isMerged ? () => setMergedCollapsed(v => !v) : undefined}
                          className={`w-full flex items-center gap-2 mb-1.5 ${isMerged ? 'cursor-pointer' : 'cursor-default'}`}
                        >
                          <span className={`text-xs font-semibold uppercase tracking-wide ${section.accent}`}>{section.title}</span>
                          <span className="text-xs text-gray-700 bg-gray-800 rounded-full px-1.5 py-0.5 font-medium">{section.items.length}</span>
                          {isMerged && <span className="text-xs text-gray-600 ml-auto">{collapsed ? '▸' : '▾'}</span>}
                        </button>
                        {!collapsed && (
                          section.items.length === 0
                            ? <p className="text-xs text-gray-700 pl-1">Nothing here 🎉</p>
                            : <div className="flex flex-col gap-1.5">
                                {section.items.map(pr => (
                                  <InboxPrCard
                                    key={pr.url}
                                    pr={pr}
                                    isDismissed={!!dismissedPrs[pr.url]}
                                    onToggleDismiss={toggleDismissPr}
                                    onAttachLive={onAttachLive}
                                    onSelectHistory={onSelectHistory}
                                  />
                                ))}
                              </div>
                        )}
                      </div>
                    )
                  })}
                  {fromSessions.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">From sessions</span>
                        <span className="text-xs text-gray-700 bg-gray-800 rounded-full px-1.5 py-0.5 font-medium">{fromSessions.length}</span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {fromSessions.map(e => (
                          <PrSessionCard
                            key={e.prUrl + (e.liveId ?? e.sessionId ?? '')}
                            entry={e}
                            title={getPrSessionTitle(e, sessionNames, historySessions)}
                            isPinned={!!pinnedPrs[e.prUrl]}
                            isDismissed={!!dismissedPrs[e.prUrl]}
                            onTogglePin={togglePinPr}
                            onToggleDismiss={toggleDismissPr}
                            onRename={renamePrEntry}
                            onAttachLive={onAttachLive}
                            onSelectHistory={onSelectHistory}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
            }
          </div>
        </>
      )}

      {/* Usage tab — per-org token/cost standing */}
      {tab === 'usage' && (
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {!usage
            ? <p className="text-xs text-gray-600 text-center mt-8">Scanning transcripts…</p>
            : <div className="flex flex-col gap-3">
                {orgs.filter(o => activeOrgId === 'all' || o.id === activeOrgId).map(org => {
                  const u: OrgUsage | undefined = usage.orgs[org.id]
                  if (!u) return (
                    <div key={org.id} className="rounded-lg bg-gray-900 px-3 py-2.5">
                      <p className="text-sm text-gray-100 font-medium">{org.name}</p>
                      <p className="text-xs text-gray-600 mt-1">No usage recorded</p>
                    </div>
                  )
                  return (
                    <div key={org.id} className="rounded-lg bg-gray-900 px-3 py-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm text-gray-100 font-medium">{org.name}</span>
                        <span className="text-xs text-gray-500">{u.sessions} sessions</span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 mb-2">
                        {([['5h', u.last5h], ['24h', u.last24h], ['7d', u.last7d]] as const).map(([label, w]) => (
                          <div key={label} className="rounded bg-gray-800/60 px-2 py-1.5 text-center">
                            <p className="text-[10px] text-gray-500 uppercase">{label}</p>
                            <p className="text-sm text-white font-semibold">{fmtCost(w.costUSD)}</p>
                            <p className="text-[10px] text-gray-600">{fmtTokens(w.outputTokens)} out</p>
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center justify-between text-xs text-gray-500">
                        <span>All-time value: <span className="text-gray-300 font-medium">{fmtCost(u.totalCostUSD)}</span></span>
                        <span>{fmtTokens(u.totalTokens.input + u.totalTokens.output)} in+out · {fmtTokens(u.totalTokens.cacheRead)} cached</span>
                      </div>
                    </div>
                  )
                })}
                <p className="text-[10px] text-gray-700 leading-relaxed px-1">
                  Costs are estimated API-equivalent value computed from transcripts (you pay via subscription).
                  The 5h and 7d windows mirror your plan&apos;s rate-limit windows — for official remaining quota run
                  <code className="text-gray-500"> /usage</code> inside any Claude session.
                </p>
              </div>
          }
        </div>
      )}

      {/* Notes tab */}
      {dueNote && (
        <div className="fixed bottom-4 left-4 z-50 w-80 rounded-lg border border-amber-700/60 bg-gray-900 shadow-xl p-3">
          <p className="text-[11px] uppercase tracking-wide text-amber-400 mb-1">⏰ Reminder</p>
          <p className="text-sm text-gray-100 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{dueNote.text}</p>
          <div className="flex items-center justify-end gap-3 mt-2 text-xs">
            <button
              onClick={() => { setReminder(dueNote.id, toLocalInput(Date.now() + 10 * 60_000)); setDueNote(null) }}
              className="text-gray-400 hover:text-white"
            >Snooze 10m</button>
            <button onClick={() => setDueNote(null)} className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium">Dismiss</button>
          </div>
        </div>
      )}
    </aside>
  )
}
