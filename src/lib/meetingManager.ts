import { meetingStore, Meeting, MeetingNotes, TranscriptSegment, ContextItem, ContextKind } from './meetingStore'
import { resolveContext } from './meetingContext'
import { randomUUID } from 'crypto'
import { type CaptureHandle, wavRms, SILENCE_RMS_THRESHOLD } from './audioCapture'
import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { transcribeChunk } from './transcriber'
import { MeetingAssistant } from './meetingAssistant'
import { getTranscriptionConfig } from './meetingConfig'
import { localWhisperProblem } from './localWhisper'
import { orgRegistry, DEFAULT_ORG_ID } from './orgRegistry'

const NOTES_TICK_MS = 90_000

function transcriptionProblem(): string | null {
  const c = getTranscriptionConfig()
  if (!c) return 'Transcription not configured: open Settings → Meetings and choose OpenAI, Azure OpenAI or Local Whisper.'
  return c.kind === 'local' ? localWhisperProblem() : null
}

export type MeetingEvent =
  | { type: 'meeting-status'; meeting: Meeting }
  | { type: 'meeting-transcript'; meetingId: string; segment: TranscriptSegment }
  | { type: 'meeting-notes'; meetingId: string; notes: MeetingNotes }
  | { type: 'meeting-suggestion'; meetingId: string; suggestion: string }
  | { type: 'meeting-answer'; meetingId: string; question: string; answer: string }
  | { type: 'meeting-error'; meetingId: string; message: string }
  | { type: 'meeting-context'; meetingId: string; items: ContextItem[] }

type Listener = (ev: MeetingEvent) => void

interface ActiveMeeting {
  meeting: Meeting
  capture: CaptureHandle
  assistant: MeetingAssistant
  chunkQueue: string[]
  transcribing: boolean
  silentChunks: number // in a row; warns once at a minute
  warnedNoConfig: boolean
  restarted: boolean
  lastAudioAt: number
  warnedNoAudio?: boolean
  notesTimer: ReturnType<typeof setInterval>
  // Transcript chars already sent to the assistant — deltas only from here on
  sentTranscriptChars: number
  transcriptText: string
}

function wavHeader(dataLen: number, rate: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(dataLen, 40)
  return h
}

class MeetingManager {
  private active = new Map<string, ActiveMeeting>()
  private listeners = new Set<Listener>()

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private emit(ev: MeetingEvent) {
    this.listeners.forEach(fn => fn(ev))
  }

  activeMeetings(): Meeting[] {
    return Array.from(this.active.values()).map(a => a.meeting)
  }

  // Audio recorded in the browser: 16 kHz mono 16-bit PCM, about 10s per chunk.
  addAudio(meetingId: string, base64Pcm: string) {
    const a = this.active.get(meetingId)
    if (!a) return
    const pcm = Buffer.from(base64Pcm, 'base64')
    if (!pcm.length || pcm.length > 4 * 1024 * 1024) return
    const dir = join(meetingStore.dir(meetingId), 'audio')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `b${Date.now()}.wav`)
    writeFileSync(file, Buffer.concat([wavHeader(pcm.length, 16000), pcm]))
    a.lastAudioAt = Date.now()
    this.enqueueChunk(meetingId, file)
  }

  start(title: string, orgId: string): Meeting | { error: string } {
    const notReady = transcriptionProblem()
    if (notReady) return { error: notReady }
    return this.begin(meetingStore.create(title, orgId || DEFAULT_ORG_ID))
  }

  // Continue an ended/interrupted meeting: same transcript, notes and assistant
  // conversation; new audio is appended. The summary is rewritten on stop.
  resume(meetingId: string): Meeting | { error: string } {
    const notReady = transcriptionProblem()
    if (notReady) return { error: notReady }
    const existing = meetingStore.get(meetingId)
    if (!existing) return { error: 'Meeting not found' }
    if (this.active.has(meetingId) || existing.status === 'recording') return { error: 'Meeting is already recording' }
    if (this.active.size > 0) return { error: 'Another meeting is recording. Stop it first.' }
    const meeting = meetingStore.update(meetingId, { status: 'recording', endedAt: null }) ?? existing
    return this.begin(meeting)
  }

  private begin(meeting: Meeting): Meeting {
    const org = orgRegistry.get(meeting.orgId)
    const assistant = new MeetingAssistant({
      cwd: meetingStore.dir(meeting.id),
      configDir: org?.configDir ?? null,
      model: org?.model ?? null,
    }, meeting.claudeSessionId)
    assistant.onSessionId = (sid) => {
      const updated = meetingStore.update(meeting.id, { claudeSessionId: sid })
      const a = this.active.get(meeting.id)
      if (a && updated) a.meeting = updated
    }

    // On resume, the earlier transcript was already sent to the assistant
    const priorText = meetingStore.readTranscript(meeting.id).map(s => s.text).join('\n')
    const active: ActiveMeeting = {
      meeting,
      assistant,
      chunkQueue: [],
      transcribing: false,
      silentChunks: 0,
      warnedNoConfig: false,
      restarted: false,
      sentTranscriptChars: priorText.length,
      transcriptText: priorText,
      capture: { stop: async () => {} }, // the browser records and sends chunks (addAudio)
      lastAudioAt: Date.now(),
      notesTimer: setInterval(() => this.notesTick(meeting.id), NOTES_TICK_MS),
    }
    this.active.set(meeting.id, active)
    this.emit({ type: 'meeting-status', meeting })
    return meeting
  }

  private enqueueChunk(meetingId: string, filePath: string) {
    const a = this.active.get(meetingId)
    if (!a) return
    a.chunkQueue.push(filePath)
    this.drainChunks(meetingId)
  }

  private async drainChunks(meetingId: string) {
    const a = this.active.get(meetingId)
    if (!a || a.transcribing) return
    a.transcribing = true
    try {
      const config = getTranscriptionConfig()
      while (a.chunkQueue.length > 0) {
        const filePath = a.chunkQueue.shift()!
        if (!config) {
          if (!a.warnedNoConfig) this.emit({ type: 'meeting-error', meetingId, message: 'Transcription is not set up, so nothing is transcribed. Set it up in Settings → Meetings.' })
          a.warnedNoConfig = true
          continue
        }
        try {
          if (wavRms(readFileSync(filePath)) < SILENCE_RMS_THRESHOLD) {
            if (++a.silentChunks === 6) this.emit({ type: 'meeting-error', meetingId, message: 'Only silence for a minute. Check the mic input volume (System Settings → Sound → Input). To capture people in a browser call, route the sound through BlackHole.' })
            continue
          }
          a.silentChunks = 0
        } catch {}
        try {
          // Last ~200 chars of transcript as context for language consistency
          const text = await transcribeChunk(filePath, config, a.transcriptText.slice(-200))
          if (text) {
            const segment: TranscriptSegment = { t: Date.now(), text }
            meetingStore.appendTranscript(meetingId, segment)
            a.transcriptText += (a.transcriptText ? '\n' : '') + text
            this.emit({ type: 'meeting-transcript', meetingId, segment })
          }
        } catch (e) {
          this.emit({ type: 'meeting-error', meetingId, message: `Transcription gap: ${e instanceof Error ? e.message : 'unknown error'}` })
        }
      }
    } finally {
      a.transcribing = false
    }
  }

  private transcriptDelta(a: ActiveMeeting): string {
    const delta = a.transcriptText.slice(a.sentTranscriptChars)
    a.sentTranscriptChars = a.transcriptText.length
    return delta
  }

  private async notesTick(meetingId: string) {
    const a = this.active.get(meetingId)
    if (!a) return
    // Audio comes from the Polyergon window: closed window = no audio
    if (Date.now() - a.lastAudioAt > 60_000 && !a.warnedNoAudio) {
      a.warnedNoAudio = true
      this.emit({ type: 'meeting-error', meetingId, message: 'No audio for a minute. Recording happens in the Polyergon window: keep it open, or stop and continue the meeting there.' })
    } else if (Date.now() - a.lastAudioAt < 60_000) a.warnedNoAudio = false
    const delta = a.transcriptText.slice(a.sentTranscriptChars)
    if (!delta.trim()) return // nobody said anything new — skip the call
    a.sentTranscriptChars = a.transcriptText.length
    try {
      const { notes, suggestion } = await a.assistant.notesTick(delta)
      if (notes) {
        meetingStore.saveNotes(meetingId, notes)
        this.emit({ type: 'meeting-notes', meetingId, notes })
      }
      if (suggestion) this.emit({ type: 'meeting-suggestion', meetingId, suggestion })
    } catch (e) {
      // Notes going stale is fine; next tick retries with a bigger delta
      this.emit({ type: 'meeting-error', meetingId, message: `Notes update failed (will retry): ${e instanceof Error ? e.message : 'unknown'}` })
      a.sentTranscriptChars -= delta.length // resend this delta next tick
    }
  }

  async ask(meetingId: string, question: string): Promise<void> {
    const a = this.active.get(meetingId)
    if (!a) {
      this.emit({ type: 'meeting-error', meetingId, message: 'Meeting is not active' })
      return
    }
    try {
      const answer = await a.assistant.ask(question, this.transcriptDelta(a))
      this.emit({ type: 'meeting-answer', meetingId, question, answer })
    } catch (e) {
      this.emit({ type: 'meeting-error', meetingId, message: `Ask failed: ${e instanceof Error ? e.message : 'unknown'}` })
    }
  }

  async addContext(meetingId: string, kind: ContextKind, value: string): Promise<void> {
    const a = this.active.get(meetingId)
    if (!a) {
      this.emit({ type: 'meeting-error', meetingId, message: 'Context can only be added while the meeting is recording' })
      return
    }
    const item: ContextItem = { id: randomUUID(), kind, label: value.trim().slice(0, 60) || kind, value, addedAt: Date.now(), status: 'loading', summary: null }
    const save = (patch: Partial<ContextItem>) => {
      const items = meetingStore.readContext(meetingId)
      const i = items.findIndex(x => x.id === item.id)
      if (i >= 0) items[i] = { ...items[i], ...patch }
      else items.push({ ...item, ...patch })
      meetingStore.saveContext(meetingId, items)
      this.emit({ type: 'meeting-context', meetingId, items })
    }
    save({})
    try {
      const resolved = await resolveContext(kind, value)
      save({ label: resolved.label })
      const reply = (await a.assistant.addContext(resolved.label, resolved.body, resolved.fetch)).trim().split('\n')[0]
      save(/^FAILED/i.test(reply) ? { status: 'failed', summary: reply.replace(/^FAILED:?\s*/i, '') } : { status: 'loaded', summary: reply })
    } catch (e) {
      save({ status: 'failed', summary: e instanceof Error ? e.message : 'unknown error' })
    }
  }

  async stop(meetingId: string): Promise<void> {
    const a = this.active.get(meetingId)
    if (!a) return
    clearInterval(a.notesTimer)
    // Graceful ffmpeg stop flushes the final chunks into the queue (the
    // meeting must still be in `active` for enqueueChunk to accept them)
    await a.capture.stop()
    this.drainChunks(meetingId)
    // Wait for the final chunks to transcribe, but cap it — a wedged transcribe
    // must never hang teardown forever (transcribeChunk itself now times out at
    // 30s/attempt, so ~45s is a generous ceiling past normal drain).
    const drainDeadline = Date.now() + 45_000
    while ((a.chunkQueue.length > 0 || a.transcribing) && Date.now() < drainDeadline) {
      await new Promise(r => setTimeout(r, 250))
    }
    this.active.delete(meetingId)

    let meeting = meetingStore.update(meetingId, { status: 'ended', endedAt: Date.now() }) ?? a.meeting
    this.emit({ type: 'meeting-status', meeting })

    try {
      const summary = await a.assistant.summarize(this.transcriptDelta(a))
      if (summary.trim()) meetingStore.saveSummary(meetingId, summary)
    } catch (e) {
      this.emit({ type: 'meeting-error', meetingId, message: `Summary failed: ${e instanceof Error ? e.message : 'unknown'}` })
    }
    meeting = meetingStore.get(meetingId) ?? meeting
    this.emit({ type: 'meeting-status', meeting })
  }
}

declare global { var __meetingManager: MeetingManager | undefined }
export const meetingManager: MeetingManager =
  global.__meetingManager ?? (global.__meetingManager = new MeetingManager())
