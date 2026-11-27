import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFolders, writeFolders } from '../sessionFolderStore'

describe('sessionFolderStore', () => {
  it('round-trips and drops assignments to deleted folders', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sf-')), 'f.json')
    expect(readFolders(file)).toEqual({ folders: [], assign: {} })
    writeFolders({ folders: [{ id: 'a', name: ' Work ', orgId: 'acme' }, { id: 'b', name: 'Old' }], assign: { s1: 'a', s2: 'gone' } }, file)
    expect(readFolders(file)).toEqual({ folders: [{ id: 'a', name: 'Work', orgId: 'acme' }, { id: 'b', name: 'Old' }], assign: { s1: 'a' } })
  })
})
