import * as pty from 'node-pty'
import { randomUUID } from 'crypto'
import { typeInto, isExitCommand } from './exitCommand'
import { existsSync, readdirSync, realpathSync, statSync } from 'fs'
import { join } from 'path'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { liveSessionStore } from './liveSessionStore'
import { detectStatus } from './statusDetector'
import { extractPrUrl } from './prDetector'
import { getBackend, type BackendSpec } from './backends'
import { autoCompactEnv, getSettings } from './settingsStore'
import { claudeAuthEnv } from './claudeAuth'
import { localeEnv } from './localeEnv'

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

// Auto-confirm the workspace trust dialog matches on this stripped text, and
// PR-URL scanning needs the same ANSI-free view of each chunk — computed once
// per chunk and shared by both.
const ANSI_STRIP = /\x1b\[[0-9;]*[a-zA-Z]|\x1b[()][A-Z0-9]/g

export function claudeProjectDir(cwd: string, configDir?: string | null): string {
  // Claude Code resolves symlinks in cwd before naming its project dir
  // (e.g. macOS /tmp -> /private/tmp), so we must match that exactly.
  let real = cwd
  try { real = realpathSync(cwd) } catch {}
  const root = configDir || join(process.env.HOME!, '.claude')
  return join(root, 'projects', real.replace(/\//g, '-'))
}

// Find the .jsonl file Claude created for a session in cwd by looking for
// files whose birth time is >= sinceTime. Uses birth time (not mtime) so it
// can't be fooled by writes to older session files.
export function findSessionIdSince(cwd: string, sinceTime: number, configDir?: string | null): string | null {
  const projectDir = claudeProjectDir(cwd, configDir)
  if (!existsSync(projectDir)) return null

  let best: { uuid: string; t: number } | null = null
  for (const f of readdirSync(projectDir)) {
    if (!UUID_JSONL.test(f)) continue
    try {
      const { birthtimeMs } = statSync(join(projectDir, f))
      // Accept files born at or after sinceTime (1 s tolerance for event-loop lag)
      if (birthtimeMs >= sinceTime - 1000 && (!best || birthtimeMs > best.t)) {
        best = { uuid: f.replace('.jsonl', ''), t: birthtimeMs }
      }
    } catch {}
  }
  return best?.uuid ?? null
}

async function detectAndStoreSessionId(id: string, cwd: string, spawnTime: number, configDir: string | null | undefined, backend: BackendSpec) {
  // Claude writes its transcript at once; other CLIs (OpenCode) only create the session on the
  // first message, which may come minutes later
  const [tries, every] = backend.id === 'claude' ? [60, 500] : [300, 2000]
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, every))
    if (!ptyProcesses.has(id)) return
    // Claude's finder needs the configDir (which project dir to scan); other
    // backends provide their own detectSessionId (e.g. Copilot's session store).
    const uuid = backend.id === 'claude'
      ? findSessionIdSince(cwd, spawnTime, configDir)
      : backend.detectSessionId?.(cwd, spawnTime) ?? null
    if (uuid) {
      liveSessionStore.setClaudeSessionId(id, uuid)
      anySessionIdListeners.forEach(fn => fn(id, uuid))
      return
    }
  }
}

type OutputListener = (data: string) => void
type StatusListener = (status: 'thinking' | 'waiting' | 'idle') => void
type AnyStatusListener = (id: string, status: 'thinking' | 'waiting' | 'idle') => void
type AnyPrUrlListener = (id: string, prUrl: string) => void
type AnyRcUrlListener = (id: string, rcUrl: string) => void

const outputListeners = new Map<string, Set<OutputListener>>()
const statusListeners = new Map<string, Set<StatusListener>>()
// Unlike statusListeners (only populated for whichever session a connection
// has attached to), this fires for every session's status change regardless
// of attachment, so clients can track sessions they aren't currently viewing.
const anyStatusListeners = new Set<AnyStatusListener>()
const anyPrUrlListeners = new Set<AnyPrUrlListener>()
const anyRcUrlListeners = new Set<AnyRcUrlListener>()
const RC_URL_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/
const ptyProcesses = new Map<string, pty.IPty>()
const thinkingTimers = new Map<string, ReturnType<typeof setTimeout>>()
// "Waiting" must hold for WAITING_SETTLE_MS with no sign of work. Claude Code redraws
// its screen every second (spinner): between erase and redraw the frame shows the ❯
// prompt without the busy footer, which used to flip cards to "waiting" mid-turn.
const WAITING_SETTLE_MS = 1500
const waitingTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lastBusyAt = new Map<string, number>()
// Small rolling ANSI-stripped tail per session, scanned for a PR URL as
// output streams through — no extra file I/O beyond what's already flowing.
const prScanBuffers = new Map<string, string>()
const PR_SCAN_BUFFER_MAX = 300

// Headless terminal per session: mirrors the PTY's actual rendered screen state.
// Claude's CLI redraws in place via relative cursor movement rather than plain
// appended output, so reattach/status-detection must read the real current
// buffer instead of replaying or pattern-matching raw output chunks.
const headlessTerms = new Map<string, { term: HeadlessTerminal; serialize: SerializeAddon }>()
let lastCols = 120
let lastRows = 30

// Returns the plain-text lines around the cursor's current row, for status
// detection against the terminal's true current state (not a transient chunk).
function emitStatus(id: string, status: 'thinking' | 'waiting' | 'idle') {
  statusListeners.get(id)?.forEach(fn => fn(status))
  anyStatusListeners.forEach(fn => fn(id, status))
}

function emitRcUrl(id: string, rcUrl: string) {
  anyRcUrlListeners.forEach(fn => fn(id, rcUrl))
}

// Fires when a new session's conversation id is found, so browsers can update.
const anySessionIdListeners = new Set<(id: string, claudeSessionId: string) => void>()
export function onAnySessionId(fn: (id: string, claudeSessionId: string) => void) {
  anySessionIdListeners.add(fn)
  return () => anySessionIdListeners.delete(fn)
}

function emitPrUrl(id: string, prUrl: string) {
  anyPrUrlListeners.forEach(fn => fn(id, prUrl))
}

function bufferTail(term: HeadlessTerminal, maxLines = 8): string {
  const buf = term.buffer.active
  const cursorAbsY = buf.baseY + buf.cursorY
  const startY = Math.max(0, cursorAbsY - maxLines + 1)
  const lines: string[] = []
  for (let y = startY; y <= cursorAbsY; y++) {
    const line = buf.getLine(y)
    if (line) lines.push(line.translateToString(true))
  }
  return lines.join('\n')
}

// Last `n` rows of the visible screen (for TUIs whose status bar is at the bottom).
function bottomRows(term: HeadlessTerminal, n: number): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let y = buf.viewportY + term.rows - n; y < buf.viewportY + term.rows; y++) {
    const line = buf.getLine(y)
    if (line) lines.push(line.translateToString(true))
  }
  return lines.join('\n')
}

// The account has Fable 5.1 (API id `claude-fable-5-1`, with dashes). Two
// gotchas: the dotted form `claude-fable-5.1` is silently accepted but falls
// back to Opus 5, and CLI 2.1.241 doesn't yet recognize the dashed id — it
// rejects it unless CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 is
// set on the process env (see spawn env below).
const DEFAULT_MODEL = 'claude-opus-5-5'

// The Claude mobile app / claude.ai lists each Remote Control session by the
// name passed to `--remote-control <name>`. Keep it a clean single token-ish
// label (spaces are fine — it's its own argv element — but strip control chars
// and cap the length so the phone list stays readable).
function sanitizeRcName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60)
}

export function spawnSession(id: string, cwd: string, resumeId?: string, configDir?: string | null, model?: string | null, rcName?: string | null, backendId?: string | null, rc?: boolean) {
  const spawnTime = Date.now()
  const cleanRcName = rcName ? sanitizeRcName(rcName) : ''
  const backend = getBackend(backendId)
  const effectiveModel = model || DEFAULT_MODEL
  // The backend (Claude / Copilot / …) owns its own argv shape, binary, and
  // any model-specific env. Remote Control naming etc. is Claude-specific and
  // handled inside its spec. Remote Control is gated by the user's
  // ~/.claude/settings.json CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC flag — we
  // must NOT drop the user settings source to bypass it (it also carries all
  // skills/plugins; doing so blanked every skill).
  const sessionId = !resumeId && backend.id === 'claude' ? randomUUID() : undefined
  const args = backend.spawnArgs({ model: effectiveModel, cwd, resumeId, sessionId, rcName: cleanRcName || undefined, rc: !!rc, skipPermissions: getSettings().sessions.skipPermissions })

  const proc = pty.spawn(backend.bin, args, {
    name: 'xterm-color',
    cols: lastCols,
    rows: lastRows,
    cwd,
    env: {
      ...Object.fromEntries(
        ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'ANTHROPIC_API_KEY']
          .filter(k => process.env[k])
          .map(k => [k, process.env[k]!])
      ),
      ...localeEnv(),
      ...backend.env(effectiveModel),
      // Native auto-compact threshold (Settings ⚙). Claude-only env; read per spawn.
      ...(backend.id === 'claude' ? { ...autoCompactEnv(), ...claudeAuthEnv() } : {}),
      ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
    },
  })

  ptyProcesses.set(id, proc)
  liveSessionStore.setRcUrl(id, null)
  outputListeners.set(id, new Set())
  statusListeners.set(id, new Set())

  const headlessTerm = new HeadlessTerminal({ cols: lastCols, rows: lastRows, allowProposedApi: true, scrollback: 2000 })
  const serializeAddon = new SerializeAddon()
  headlessTerm.loadAddon(serializeAddon)
  headlessTerms.set(id, { term: headlessTerm, serialize: serializeAddon })

  // For new sessions, detect the session file Claude creates and persist its ID
  if (sessionId) { liveSessionStore.setClaudeSessionId(id, sessionId); anySessionIdListeners.forEach(fn => fn(id, sessionId)) }
  else if (!resumeId) detectAndStoreSessionId(id, cwd, spawnTime, configDir, backend)

  // Auto-confirm the workspace/folder trust dialog both CLIs show for a new
  // directory. Claude: "Yes, trust" is pre-selected, \r accepts it. Copilot:
  // "Do you trust the files in this folder?" with option 1 (Yes) pre-selected
  // and option 2 ("Yes, and remember…") below — we pick 2 (↓ then \r) so it
  // won't ask again for that folder. The prompt can span multiple PTY chunks,
  // so we match against a small rolling buffer, not a single chunk. Words are
  // separated by cursor-forward ANSI codes, so match on ANSI-stripped text.
  let trustConfirmed = false
  let trustScanBuf = ''
  prScanBuffers.set(id, '')

  proc.onData((data) => {
    lastOutputAt.set(id, Date.now())
    outputListeners.get(id)?.forEach(fn => fn(data))
    const stripped = data.replace(ANSI_STRIP, '')

    if (!trustConfirmed) {
      trustScanBuf = (trustScanBuf + stripped).slice(-2000)
      if (backend.id === 'claude' && /Enter/.test(trustScanBuf) && /confirm/.test(trustScanBuf)) {
        trustConfirmed = true
        // CLI ≥2.1.3xx preselects "No, exit"; older ones preselect "Yes". Read
        // the rendered screen once it settles and move to "Yes" only if needed.
        setTimeout(() => {
          const tail = bufferTail(headlessTerm, 12)
          if (/❯\s*No/.test(tail)) {
            proc.write('\x1b[B')
            setTimeout(() => proc.write('\r'), 500)
          } else {
            proc.write('\r')
          }
        }, 1000)
      } else if (backend.id !== 'claude' && /trust the files in this folder/i.test(trustScanBuf)) {
        trustConfirmed = true
        proc.write('\x1b[B') // ↓ to option 2 ("Yes, and remember this folder")
        setTimeout(() => proc.write('\r'), 60)
      }
    }

    // Rolling tail scan for a PR URL (e.g. from `gh pr create` output) — no
    // extra file I/O, reuses output already streaming through.
    const buf = ((prScanBuffers.get(id) ?? '') + stripped).slice(-PR_SCAN_BUFFER_MAX)
    prScanBuffers.set(id, buf)
    // Remote Control pairing link ("Continue here, on your phone, or at …")
    const rc = buf.match(RC_URL_RE)?.[0]
    if (rc && liveSessionStore.get(id)?.rcUrl !== rc) {
      liveSessionStore.setRcUrl(id, rc)
      emitRcUrl(id, rc)
    }
    const prUrl = extractPrUrl(buf)
    if (prUrl) {
      const session = liveSessionStore.get(id)
      if (session && session.prUrl !== prUrl) {
        liveSessionStore.setPrUrl(id, prUrl)
        emitPrUrl(id, prUrl)
      }
    }

    // headlessTerm.write() parses asynchronously — the buffer only reflects
    // this chunk once the callback fires, so status detection must happen there.
    headlessTerm.write(data, () => {
      if (!headlessTerms.has(id)) return
      // Copilot's status lives in the footer below the cursor, so read the
      // screen bottom for it; Claude's lives in the lines around the cursor.
      const readStatus = () => backend.id !== 'claude'
        ? detectStatus(bottomRows(headlessTerm, 3), backend.id)
        // Claude's footer (below the prompt) says "esc to interrupt" while busy
        : detectStatus(bufferTail(headlessTerm) + '\n' + bottomRows(headlessTerm, 3))
      const status = readStatus()
      const session = liveSessionStore.get(id)
      if (!session) return

      if (status === 'thinking') lastBusyAt.set(id, Date.now())

      if (status === 'waiting') {
        if (session.status === 'waiting' || waitingTimers.has(id)) return
        const settle = (delay: number) => waitingTimers.set(id, setTimeout(() => {
          waitingTimers.delete(id)
          const s = liveSessionStore.get(id)
          if (!s || s.status === 'waiting' || !headlessTerms.has(id)) return
          if (readStatus() !== 'waiting') return // busy again; the next waiting frame re-arms
          // A busy frame came in meanwhile: check again once it's WAITING_SETTLE_MS old
          const sinceBusy = Date.now() - (lastBusyAt.get(id) ?? 0)
          if (sinceBusy < WAITING_SETTLE_MS) { settle(WAITING_SETTLE_MS - sinceBusy); return }
          const t = thinkingTimers.get(id)
          if (t) { clearTimeout(t); thinkingTimers.delete(id) }
          liveSessionStore.setStatus(id, 'waiting')
          emitStatus(id, 'waiting')
        }, delay))
        settle(WAITING_SETTLE_MS)
      } else if (status === 'thinking' && session.status !== 'thinking') {
        // Debounce: a lone busy-looking frame shouldn't wake an idle/waiting card
        if (!thinkingTimers.has(id)) {
          thinkingTimers.set(id, setTimeout(() => {
            thinkingTimers.delete(id)
            const s = liveSessionStore.get(id)
            if (s && s.status !== 'thinking') {
              liveSessionStore.setStatus(id, 'thinking')
              emitStatus(id, 'thinking')
            }
          }, 800))
        }
      }
    })
  })

  proc.onExit(() => {
    // A re-spawn (restart / resume-with-new-model) registers a NEW proc under
    // the same id before this old one has exited. Only the current owner may
    // tear the id's state down, or the new session is orphaned on arrival.
    if (ptyProcesses.get(id) !== proc) return
    const byExit = exitRequested.delete(id)
    typedLine.delete(id)
    const t = thinkingTimers.get(id)
    if (t) { clearTimeout(t); thinkingTimers.delete(id) }
    const wt = waitingTimers.get(id)
    if (wt) { clearTimeout(wt); waitingTimers.delete(id) }
    liveSessionStore.setStatus(id, 'idle')
    emitStatus(id, 'idle')
    ptyProcesses.delete(id)
    outputListeners.delete(id)
    statusListeners.delete(id)
    headlessTerms.get(id)?.term.dispose()
    headlessTerms.delete(id)
    prScanBuffers.delete(id)
    if (byExit) exitCommandListeners.forEach(fn => fn(id))
  })
}

// Plain text of the bottom of a session's screen (for limit / prompt detection)
export function screenText(id: string, rows = 20): string {
  const h = headlessTerms.get(id)
  return h ? bottomRows(h.term, Math.min(rows, h.term.rows)) : ''
}

// When the session last printed anything
export const lastOutputAt = new Map<string, number>()

// The user's current input line per session, and sessions where they ran /exit
const typedLine = new Map<string, string>()
const exitRequested = new Set<string>()
const exitCommandListeners = new Set<(id: string) => void>()
// Fires when a session's Claude quits because the user ran /exit (not when the app stops it)
export function onExitCommand(fn: (id: string) => void) { exitCommandListeners.add(fn); return () => exitCommandListeners.delete(fn) }

export function writeToSession(id: string, data: string) {
  const { line, submitted } = typeInto(typedLine.get(id) ?? '', data)
  typedLine.set(id, line)
  if (submitted !== null) { if (isExitCommand(submitted)) exitRequested.add(id); else exitRequested.delete(id) }
  ptyProcesses.get(id)?.write(data)
}

// Startup screens that take keystrokes but are NOT the input prompt (folder
// trust, login, theme, etc.). Typing a prompt into them answers them wrongly.
export const STARTUP_DIALOG_RE = /trust this folder|Quick safety check|Enter to confirm|Do you trust|Select login method|Choose the text style|Press Enter to continue/i

export function onScreenDialog(id: string): boolean {
  const h = headlessTerms.get(id)
  return !!h && STARTUP_DIALOG_RE.test(bottomRows(h.term, 25))
}

export function isRunning(id: string): boolean { return ptyProcesses.has(id) }

// Sends `text` as the session's first prompt once it sits at the real input
// prompt; while a startup dialog is showing it waits for you to answer it.
// Resumes a stopped (or auto-slept) session; set by server.ts.
let waker: (id: string) => boolean = () => false
export function setWaker(fn: (id: string) => boolean) { waker = fn }

export function sendWhenReady(id: string, text: string, timeoutMs = 10 * 60_000) {
  if (!ptyProcesses.has(id) && !waker(id)) return
  const started = Date.now()
  let readySince = 0 // prompt must stay ready ~1s: TUIs report "waiting" before they finish drawing
  const tick = () => {
    if (!ptyProcesses.has(id) || Date.now() - started > timeoutMs) return
    if (liveSessionStore.get(id)?.status === 'waiting' && !onScreenDialog(id)) {
      readySince ||= Date.now()
      if (Date.now() - readySince >= 1000) { submitLine(id, text); return }
    } else readySince = 0
    setTimeout(tick, 250)
  }
  setTimeout(tick, 500)
}

// Types a line into the agent's prompt and submits it. Enter goes separately:
// sent in the same write, the TUI treats it as part of a paste and doesn't submit.
export function submitLine(id: string, text: string) {
  if (isExitCommand(text)) exitRequested.add(id) // /exit sent from Chat view
  ptyProcesses.get(id)?.write(text)
  setTimeout(() => ptyProcesses.get(id)?.write('\r'), 250)
}

export function resizeSession(id: string, cols: number, rows: number) {
  lastCols = cols
  lastRows = rows
  ptyProcesses.get(id)?.resize(cols, rows)
  headlessTerms.get(id)?.term.resize(cols, rows)
}

export function getLastKnownSize(): { cols: number; rows: number } {
  return { cols: lastCols, rows: lastRows }
}

export function killSession(id: string) {
  if (ptyProcesses.has(id)) { liveSessionStore.setStatus(id, 'idle'); emitStatus(id, 'idle') } // onExit skips it: the proc is gone by then
  const t = thinkingTimers.get(id)
  if (t) { clearTimeout(t); thinkingTimers.delete(id) }
  ptyProcesses.get(id)?.kill()
  ptyProcesses.delete(id)
  outputListeners.delete(id)
  statusListeners.delete(id)
  headlessTerms.get(id)?.term.dispose()
  headlessTerms.delete(id)
  prScanBuffers.delete(id)
}

export function onOutput(id: string, fn: OutputListener) {
  outputListeners.get(id)?.add(fn)
  return () => outputListeners.get(id)?.delete(fn)
}

export function onStatusChange(id: string, fn: StatusListener) {
  statusListeners.get(id)?.add(fn)
  return () => statusListeners.get(id)?.delete(fn)
}

export function onAnyStatusChange(fn: AnyStatusListener) {
  anyStatusListeners.add(fn)
  return () => anyStatusListeners.delete(fn)
}

export function onAnyRcUrlChange(fn: AnyRcUrlListener) {
  anyRcUrlListeners.add(fn)
  return () => anyRcUrlListeners.delete(fn)
}

export function onAnyPrUrlChange(fn: AnyPrUrlListener) {
  anyPrUrlListeners.add(fn)
  return () => anyPrUrlListeners.delete(fn)
}

// Full ANSI reconstruction of the session's actual current screen state, for
// sending on reattach — not a replay of raw output history.
export function getSerializedScreen(id: string): string {
  return headlessTerms.get(id)?.serialize.serialize() ?? ''
}
