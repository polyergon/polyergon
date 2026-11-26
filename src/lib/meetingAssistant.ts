import { spawn } from 'child_process'
import type { MeetingNotes } from './meetingStore'
import { claudeAuthEnv } from './claudeAuth'
import { localeEnv } from './localeEnv'

const CALL_TIMEOUT_MS = 180_000

// One headless `claude -p` call (optionally resuming a conversation). Runs with
// permission prompts off so it can use web/file tools and MCP connectors.
// forkSession: resume a COPY of the conversation (new id); the original is untouched.
export function runClaude(prompt: string, opts: AssistantSpawnOpts & { resumeId?: string | null; timeoutMs?: number; forkSession?: boolean }): Promise<{ result: string; sessionId: string | null }> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.resumeId ? ['--resume', opts.resumeId, ...(opts.forkSession ? ['--fork-session'] : [])] : []),
    ]
    const env = {
      ...Object.fromEntries(
        ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM']
          .filter(k => process.env[k])
          .map(k => [k, process.env[k]!])
      ),
      ...localeEnv(),
      ...claudeAuthEnv(),
      ...(opts.configDir ? { CLAUDE_CONFIG_DIR: opts.configDir } : {}),
      ...opts.extraEnv,
    } as NodeJS.ProcessEnv
    const proc = spawn('claude', args, { cwd: opts.cwd, env })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-1000) })
    const killer = setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs ?? CALL_TIMEOUT_MS)
    proc.on('error', (e) => { clearTimeout(killer); reject(e) })
    proc.on('exit', (code) => {
      clearTimeout(killer)
      if (code !== 0) {
        reject(new Error(code === null ? 'Claude took too long and was stopped' : `claude -p exited ${code}: ${stderr.trim().slice(-300)}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: string; session_id?: string }
        resolve({ result: parsed.result ?? '', sessionId: parsed.session_id ?? null })
      } catch {
        reject(new Error(`unparseable claude output: ${stdout.slice(0, 200)}`))
      }
    })
    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

export interface AssistantSpawnOpts {
  cwd: string
  configDir: string | null
  model: string | null
  extraEnv?: Record<string, string>
}

export interface NotesTickResult {
  notes: MeetingNotes | null
  suggestion: string | null
}

const PREAMBLE = `You are a live meeting assistant. You receive transcript excerpts from an ongoing meeting as they happen (transcribed from audio — expect some transcription errors, and possibly mixed Hebrew/English). Your job across this conversation:
- Maintain structured meeting notes (topics discussed, decisions made, action items with owners when identifiable).
- Answer questions the user asks mid-meeting, concisely — they're in the meeting and need fast answers.
- Occasionally offer ONE genuinely useful proactive suggestion (an answer to a question someone raised, a factual correction, relevant context). Most updates need no suggestion — only include one when it truly helps.
Never invent transcript content. If the transcript is too sparse to conclude something, leave it out.`

// One persistent headless Claude conversation (claude -p / --resume) per
// meeting, under the meeting org's config dir + model. Calls are serialized —
// notes ticks, asks and the summary share one conversation and must not race.
export class MeetingAssistant {
  private opts: AssistantSpawnOpts
  private sessionId: string | null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(opts: AssistantSpawnOpts, existingSessionId: string | null = null) {
    this.opts = opts
    this.sessionId = existingSessionId
  }

  // Exposed so the manager can persist it and survive server restarts
  getSessionId(): string | null {
    return this.sessionId
  }

  onSessionId: ((id: string) => void) | null = null

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private async call(prompt: string): Promise<string> {
    const { result, sessionId } = await runClaude(prompt, { ...this.opts, resumeId: this.sessionId })
    if (sessionId) {
      this.sessionId = sessionId
      this.onSessionId?.(sessionId)
    }
    return result
  }

  private withPreamble(body: string): string {
    // The preamble only needs to be sent once; --resume keeps the context
    return this.sessionId ? body : `${PREAMBLE}\n\n${body}`
  }

  notesTick(transcriptDelta: string): Promise<NotesTickResult> {
    return this.enqueue(async () => {
      const prompt = this.withPreamble(
        `New transcript since the last update:\n---\n${transcriptDelta}\n---\n` +
        `Update your running notes for the whole meeting so far. Respond with ONLY a JSON object, no prose, no markdown fences:\n` +
        `{"notes": {"topics": string[], "decisions": string[], "actionItems": string[]}, "suggestion": string | null}`
      )
      const raw = await this.call(prompt)
      return parseNotesTick(raw)
    })
  }

  ask(question: string, transcriptDelta: string): Promise<string> {
    return this.enqueue(() => this.call(this.withPreamble(
      (transcriptDelta ? `New transcript since the last update:\n---\n${transcriptDelta}\n---\n` : '') +
      `The user asks (mid-meeting, answer concisely and directly): ${question}`
    )))
  }

  // Background material for the rest of the meeting. Returns the assistant's
  // one-line read of it; a line starting with FAILED means it couldn't load it.
  addContext(label: string, body: string, fetch: boolean): Promise<string> {
    return this.enqueue(() => this.call(this.withPreamble(fetch
      ? `The user added a source as background context for this meeting: ${body}\n` +
        `Load it now with your tools (web fetch, file read, or the matching MCP connector such as Slack, Notion, Google Drive or Gmail). ` +
        `Keep what you learn in mind for notes, answers and suggestions for the rest of the meeting. ` +
        `Reply with ONE short line saying what it is about, or "FAILED: <reason>" if you cannot load it.`
      : `The user added background context for this meeting (${label}):\n---\n${body}\n---\n` +
        `Keep it in mind for notes, answers and suggestions for the rest of the meeting. Reply with ONE short line saying what it is about.`
    )))
  }

  summarize(transcriptDelta: string): Promise<string> {
    return this.enqueue(() => this.call(this.withPreamble(
      (transcriptDelta ? `Final transcript segment:\n---\n${transcriptDelta}\n---\n` : '') +
      `The meeting has ended. Write a markdown recap of the ENTIRE meeting with sections: ## Summary (a few sentences), ## Decisions (bullets), ## Action Items (bullets with owners where known). Respond with only the markdown.`
    )))
  }
}

// Tolerates fenced or prose-wrapped JSON — extracts the outermost object
export function parseNotesTick(raw: string): NotesTickResult {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return { notes: null, suggestion: null }
  try {
    const obj = JSON.parse(raw.slice(start, end + 1))
    const n = obj.notes
    const notes: MeetingNotes | null = n && typeof n === 'object'
      ? {
          topics: Array.isArray(n.topics) ? n.topics.filter((x: unknown) => typeof x === 'string') : [],
          decisions: Array.isArray(n.decisions) ? n.decisions.filter((x: unknown) => typeof x === 'string') : [],
          actionItems: Array.isArray(n.actionItems) ? n.actionItems.filter((x: unknown) => typeof x === 'string') : [],
        }
      : null
    return { notes, suggestion: typeof obj.suggestion === 'string' && obj.suggestion.trim() ? obj.suggestion.trim() : null }
  } catch {
    return { notes: null, suggestion: null }
  }
}
