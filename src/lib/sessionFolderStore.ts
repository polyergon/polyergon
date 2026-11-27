import { DATA_DIR } from './dataDir'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

// User folders for live sessions. Server-side (like session names) so every
// browser and hostname shows the same folders.
export interface SessionFolders {
  folders: { id: string; name: string; orgId?: string; collapsed?: boolean }[] // no orgId: older folder, org comes from its sessions
  assign: Record<string, string> // live session id -> folder id
}

const FILE = join(DATA_DIR, 'session-folders.json')

export function readFolders(file = FILE): SessionFolders {
  try {
    const d = JSON.parse(readFileSync(file, 'utf-8'))
    return { folders: Array.isArray(d.folders) ? d.folders : [], assign: d.assign && typeof d.assign === 'object' ? d.assign : {} }
  } catch { return { folders: [], assign: {} } }
}

export function writeFolders(data: SessionFolders, file = FILE): SessionFolders {
  const ids = new Set(data.folders.map(f => f.id))
  const clean: SessionFolders = {
    folders: data.folders.filter(f => f.id && typeof f.name === 'string').map(f => ({ id: f.id, name: f.name.trim() || 'Folder', ...(typeof f.orgId === 'string' ? { orgId: f.orgId } : {}), ...(f.collapsed ? { collapsed: true } : {}) })),
    assign: Object.fromEntries(Object.entries(data.assign).filter(([, f]) => ids.has(f))),
  }
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(clean))
  return clean
}
