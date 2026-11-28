'use client'
import { useState } from 'react'
import type { Pipeline, PipelineConfig, PrTrack, Suggestion } from '@/lib/pipelines'
import { DEFAULT_AUTO, stepOf, type AutoSteps, AUTO_PRESETS, presetOf, shipPlan } from '@/lib/pipelineView'
import type { SlackChannel } from '@/lib/slackBridge'
import { isRunning, pipelineSummary, shortPr, prSteps, preprSteps } from '@/lib/pipelineView'
import { SlackChannelPicker } from './SlackChannelPicker'

// Pick a preset in one click; the per-step switches (children) sit under "Customize".
export function AutoPresets({ auto, onPick, children }: { auto: AutoSteps; onPick: (steps: Partial<AutoSteps>) => void; children: React.ReactNode }) {
  const cur = presetOf(auto)
  const [open, setOpen] = useState(false)
  return (
    <div>
      <div className="flex rounded-lg border border-gray-700 overflow-hidden text-xs">
        {AUTO_PRESETS.map(p => (
          <button key={p.id} type="button" onClick={() => onPick(p.steps)} title={p.hint}
            className={`flex-1 px-2 py-1.5 ${cur === p.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-800'}`}>{p.label}</button>
        ))}
      </div>
      <p className="text-[11px] text-gray-500 mt-1.5">{cur ? AUTO_PRESETS.find(p => p.id === cur)!.hint : 'Custom: your own mix of steps.'}</p>
      <button type="button" onClick={() => setOpen(o => !o)} className="text-[11px] text-blue-400 hover:text-blue-300 mt-1">{open || !cur ? '▾' : '▸'} Customize steps</button>
      {(open || !cur) && <div className="mt-2">{children}</div>}
    </div>
  )
}

// "What will happen", in order, before you start.
export function ShipPlan({ lines }: { lines: string[] }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">What will happen</p>
      <ol className="text-xs text-gray-300 space-y-1 list-decimal pl-4">{lines.map(l => <li key={l}>{l}</li>)}</ol>
    </div>
  )
}

// A proposed message for the session. Only your click sends it.
export function SuggestionBox({ s, onSend, onDismiss }: { s: Suggestion; onSend: () => void; onDismiss: () => void }) {
  const title = s.kind === 'open-pr' ? 'Ready to open a PR?' : s.kind === 'review' ? 'New review feedback' : s.kind === 'merge' ? 'Approved and green: ready to merge' : s.kind === 'ready' ? 'Draft with green CI: mark it ready for review?' : s.kind === 'post-merge' ? 'Merged: run post-merge checks?' : 'CI is failing'
  return (
    <div className="mt-2 rounded-lg border border-amber-700/50 bg-amber-950/30 p-2.5">
      <p className="text-xs font-medium text-amber-200">{title}</p>
      {s.kind === 'ready'
        ? <p className="text-[11px] text-gray-400 mt-1">Polyergon marks it ready on GitHub, and your review requests go out.</p>
        : <><p className="text-[11px] text-gray-400 mt-1">Suggested message for the session:</p>
          <p className="text-xs text-gray-200 mt-0.5 italic">&ldquo;{s.text}&rdquo;</p></>}
      <div className="flex gap-2 mt-2">
        <button onClick={onSend} className="text-xs px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white">{s.kind === 'merge' ? 'Merge' : s.kind === 'ready' ? 'Mark ready' : 'Send to session'}</button>
        <button onClick={onDismiss} className="text-xs px-2 py-1 rounded-md text-gray-400 hover:text-white">Dismiss</button>
      </div>
    </div>
  )
}

export const REVIEW_ICON: Record<string, string> = { APPROVED: '✓', CHANGES_REQUESTED: '✗', COMMENTED: '💬', DISMISSED: '–', PENDING: '…' }
export const REVIEW_COLOR: Record<string, string> = { APPROVED: 'text-emerald-300', CHANGES_REQUESTED: 'text-red-300', COMMENTED: 'text-gray-300' }
export const TRACK_BADGE: Record<PrTrack['state'], [string, string]> = {
  'in-review': ['in review', 'bg-blue-500/15 text-blue-300'],
  working: ['session is fixing', 'bg-blue-500/15 text-blue-300'],
  verifying: ['post-merge checks', 'bg-blue-500/15 text-blue-300'],
  ready: ['ready to merge', 'bg-emerald-500/15 text-emerald-300'],
  done: ['done', 'bg-gray-700 text-gray-300'],
  'needs-you': ['needs you', 'bg-amber-500/15 text-amber-300'],
}

// PR opened → Slack → In review → Approved → Merged for one PR
function Stepper({ steps }: { steps: { label: string; done: boolean; current: boolean }[] }) {
  return (
    <div className="flex items-start my-3">
      {steps.map((s, i) => (
        <div key={s.label} className="flex-1 flex flex-col items-center text-center relative">
          {i > 0 && <span className={`absolute top-1.5 right-1/2 w-full h-0.5 ${s.done || s.current ? 'bg-blue-500/60' : 'bg-gray-700'}`} />}
          <span className={`relative z-10 w-3.5 h-3.5 rounded-full border-2 ${s.done ? 'bg-emerald-500 border-emerald-500' : s.current ? 'bg-gray-900 border-blue-400 animate-pulse' : 'bg-gray-900 border-gray-600'}`} />
          <span className={`text-[10px] mt-1 leading-tight ${s.done ? 'text-gray-300' : s.current ? 'text-blue-300' : 'text-gray-600'}`}>{s.label}</span>
        </div>
      ))}
    </div>
  )
}

export function PrCard({ t, slackSet, max, onSend, onDismiss, auto }: { t: PrTrack; slackSet: boolean; max: number; onSend?: () => void; onDismiss?: () => void; auto?: AutoSteps }) {
  const v = t.view
  const [label, cls] = t.view?.isDraft && t.state === 'in-review' ? ['draft', 'bg-gray-700 text-gray-300'] : TRACK_BADGE[t.state]
  return (
    <div className="rounded-lg border border-gray-800 p-3">
      <div className="flex items-center gap-2 min-w-0">
        <a href={t.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-gray-100 hover:underline truncate">{v?.title || shortPr(t.url)}</a>
        <span className={`ml-auto flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium ${cls}`}>{label}</span>
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <p className="text-[11px] text-gray-500"><a href={t.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{shortPr(t.url)} ↗</a>{v?.isDraft ? ' · draft' : ''} · review fixes {t.reviewRounds}/{max} · CI fixes {t.ciFixes}/{max}</p>
      </div>
      {t.suggestion && onSend && onDismiss && <SuggestionBox s={t.suggestion} onSend={onSend} onDismiss={onDismiss} />}
      {t.suggestion && auto && t.suggestion.kind !== 'open-pr' && auto[stepOf(t.suggestion.kind)] && (t.suggestion.kind === 'merge' ? (t.mergeAttempts ?? 0) < 1 : (t.suggestion.kind === 'review' ? t.reviewRounds : t.ciFixes) < max) &&
        <p className="text-[11px] text-amber-300/80 mt-1">Automatic: this goes to the session as soon as it&apos;s idle.</p>}
      <Stepper steps={prSteps(t, slackSet)} />
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">GitHub</p>
          {v ? (
            <ul className="space-y-0.5">
              {v.reviews.map(r => (
                <li key={r.login} className={`flex gap-1.5 ${REVIEW_COLOR[r.state] ?? 'text-gray-300'}`}><span className="w-3">{REVIEW_ICON[r.state] ?? '•'}</span>{r.login}<span className="text-gray-500 lowercase">{r.state.replace('_', ' ')}</span></li>
              ))}
              {v.requested.map(r => <li key={r} className="flex gap-1.5 text-gray-400"><span className="w-3">⏳</span>{r}<span className="text-gray-600">requested</span></li>)}
              {!v.reviews.length && !v.requested.length && <li className="text-gray-500">No reviewers yet</li>}
              <li className={`pt-0.5 ${v.checks === 'failing' ? 'text-red-300' : v.checks === 'passing' ? 'text-emerald-300' : 'text-gray-400'}`}>CI: {v.checks === 'none' ? 'no checks' : v.checks}</li>
            </ul>
          ) : <p className="text-gray-500">Loading…</p>}
        </div>
        <div>
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Slack{t.slack ? ` · #${t.slack.channel}` : ''}</p>
          {t.slack ? (
            <div className="space-y-1">
              {t.slack.reviewers?.length
                ? <p className="text-gray-200">👀 {t.slack.reviewers.join(', ')}</p>
                : <p className="text-gray-500">{t.slack.reviewers ? 'Nobody has claimed it yet' : 'Checking replies…'}</p>}
              {t.slack.replies?.slice(-2).map((r, i) => <p key={i} className="text-gray-400 line-clamp-2"><span className="text-gray-300">{r.user}:</span> {r.text}</p>)}
              {t.slack.permalink && <a href={t.slack.permalink} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Open thread</a>}
            </div>
          ) : <p className="text-gray-500">{slackSet ? 'Posting…' : 'No channel set'}</p>}
        </div>
      </div>
    </div>
  )
}

export const AUTO_ROWS: [keyof AutoSteps, string, string][] = [
  ['openPr', 'Open the PR', 'When the session has code to ship, ask it to commit, push and open a PR'],
  ['review', 'Fix review comments', 'When reviewers comment, ask the session to address them, push and reply'],
  ['ci', 'Fix failing CI', 'When CI fails, ask the session to fix it and push'],
  ['ready', 'Mark draft ready', 'When a draft PR\'s CI is green, take it out of draft so it goes to review (and your review requests go out)'],
  ['merge', 'Merge when approved', 'When approved and CI is green, ask the session to merge (tried once automatically)'],
  ['postMerge', 'Post-merge checks', 'After a PR merges, ask the session to check CI on main, the deploy and logs. It only checks; production changes still ask you'],
]

// Start a "Ship it" automation on a session, or watch / stop the running one.
export function AutomateDialog({ sessionName, pipeline, error, onStart, onStop, onAddPr, onAct, onDismiss, onSetAuto, onClose }: {
  sessionName: string
  pipeline: Pipeline | null
  error: string | null
  onStart: (config: PipelineConfig) => void
  onStop: (id: string) => void
  onAddPr: (id: string, url: string) => void
  onAct: (id: string, prUrl: string | null) => void
  onDismiss: (id: string, prUrl: string | null) => void
  onSetAuto: (id: string, auto: Partial<AutoSteps>) => void
  onClose: () => void
}) {
  const [channelText, setChannelText] = useState('')
  const [channel, setChannel] = useState<SlackChannel | null>(null)
  const [maxRounds, setMaxRounds] = useState(3)
  const [autoDraft, setAutoDraft] = useState<AutoSteps>(DEFAULT_AUTO)
  const auto: AutoSteps = pipeline ? { ...DEFAULT_AUTO, ...pipeline.config.auto } : autoDraft
  const setSteps = (steps: Partial<AutoSteps>) => pipeline && isRunning(pipeline) ? onSetAuto(pipeline.id, steps) : setAutoDraft(a => ({ ...a, ...steps }))
  const setAuto = (k: keyof AutoSteps, on: boolean) => setSteps({ [k]: on })
  const [prUrl, setPrUrl] = useState('')
  const running = isRunning(pipeline)
  const input = 'w-full bg-gray-800 border border-gray-700 focus:border-gray-500 rounded-md px-2.5 py-1.5 text-sm text-white outline-none placeholder-gray-500'

  function start() {
    const name = (channel?.name ?? channelText).replace(/^#/, '').trim()
    onStart({ slackChannel: name ? { id: channel?.id ?? '', name } : null, maxRounds, auto: autoDraft })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-gray-900 border border-gray-700 rounded-xl p-5 text-white" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold">⚡ Automate · Ship it</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close">✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-4 truncate">{sessionName}{pipeline ? ` · ${pipelineSummary(pipeline)}` : ''}</p>

        {pipeline && isRunning(pipeline) && pipeline.prs.length === 0 && (
          <div className="rounded-lg border border-gray-800 p-3 mb-4"><Stepper steps={preprSteps(pipeline)} /></div>
        )}
        {pipeline?.suggestion && <div className="mb-4"><SuggestionBox s={pipeline.suggestion} onSend={() => onAct(pipeline.id, null)} onDismiss={() => onDismiss(pipeline.id, null)} /></div>}
        {pipeline && pipeline.prs.length > 0 && (
          <div className="space-y-3 mb-4">
            {pipeline.prs.map(t => <PrCard key={t.url} t={t} slackSet={!!pipeline.config.slackChannel} max={pipeline.config.maxRounds}
              onSend={() => onAct(pipeline.id, t.url)} onDismiss={() => onDismiss(pipeline.id, t.url)} auto={auto} />)}
          </div>
        )}

        <div className="rounded-lg border border-gray-800 p-3 mb-4">
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">How much should it do on its own?</p>
          <AutoPresets auto={auto} onPick={setSteps}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {AUTO_ROWS.filter(([k]) => k !== 'postMerge').map(([k, label, hint]) => (
              <label key={k} className="flex items-center justify-between gap-2 text-xs" title={hint}>
                <span className="text-gray-300">{label}</span>
                <span className="flex rounded-md border border-gray-700 overflow-hidden flex-shrink-0">
                  <button type="button" onClick={() => setAuto(k, true)} className={`px-2 py-0.5 ${auto[k] ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-800'}`}>Automatic</button>
                  <button type="button" onClick={() => setAuto(k, false)} className={`px-2 py-0.5 ${!auto[k] ? 'bg-gray-700 text-white' : 'text-gray-400 hover:bg-gray-800'}`}>Ask me</button>
                </span>
              </label>
            ))}
          </div>
          </AutoPresets>
          <p className="text-[11px] text-gray-500 mt-2">Review and CI fixes stop after {pipeline?.config.maxRounds ?? maxRounds} rounds per PR, then ask you. Approving is always up to your reviewers.</p>
        </div>

        {running && pipeline && (
          <div className="flex gap-2 mb-4">
            <input value={prUrl} onChange={e => setPrUrl(e.target.value)} placeholder="Track another PR: https://github.com/org/repo/pull/123" className={input} />
            <button onClick={() => { onAddPr(pipeline.id, prUrl); setPrUrl('') }} disabled={!prUrl.trim()} className="text-xs px-3 rounded-md border border-gray-700 hover:bg-gray-800 disabled:opacity-40 flex-shrink-0">Add PR</button>
          </div>
        )}

        {pipeline && (
          <details className="mb-4" open={!pipeline.prs.length}>
            <summary className="text-xs text-gray-400 cursor-pointer mb-2">Activity log</summary>
            <ol className="text-xs space-y-1 bg-gray-950 border border-gray-800 rounded-md p-3 max-h-48 overflow-y-auto">
              {pipeline.log.map((l, i) => (
                <li key={i} className="flex gap-2"><span className="text-gray-600 tabular-nums flex-shrink-0">{new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span className="text-gray-300">{l.text}</span></li>
              ))}
            </ol>
          </details>
        )}

        {!running && (
          <>
            <div className="mb-4"><ShipPlan lines={shipPlan(auto, { channel: (channel?.name ?? channelText).replace(/^#/, '').trim() || null, maxRounds, postMerge: false })} /></div>
            <label className="block text-xs text-gray-400 mb-1">Slack channel for &quot;ready for review&quot; (optional)</label>
            <SlackChannelPicker value={channelText} onChange={(v, c) => { setChannelText(v); setChannel(c) }} className={input} />
            <p className="text-[11px] text-gray-500 mt-3">Automatic steps send their message to the session when it&apos;s idle. &quot;Ask me&quot; steps notify you and wait for your click. It posts to Slack on its own if you set a channel.</p>
          </>
        )}

        {error && <p className="text-xs text-red-400 mt-3">{error}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Close</button>
          {running
            ? <button onClick={() => onStop(pipeline!.id)} className="px-3 py-1.5 text-sm rounded-md bg-red-600 hover:bg-red-500">Stop automation</button>
            : <button onClick={start} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 hover:bg-blue-500">{pipeline ? 'Start again' : 'Start'}</button>}
        </div>
      </div>
    </div>
  )
}
