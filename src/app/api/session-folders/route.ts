export const dynamic = 'force-dynamic' // never prerender: reads live local state
import { NextRequest, NextResponse } from 'next/server'
import { readFolders, writeFolders, type SessionFolders } from '@/lib/sessionFolderStore'

export async function GET() {
  return NextResponse.json(readFolders())
}

// Replaces the whole folder state (one user, the client holds the full copy).
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null) as SessionFolders | null
  if (!body || !Array.isArray(body.folders) || typeof body.assign !== 'object') return NextResponse.json({ error: 'folders and assign required' }, { status: 400 })
  return NextResponse.json(writeFolders(body))
}
