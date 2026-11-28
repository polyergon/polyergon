import { AUTO_PRESETS, DEFAULT_AUTO, presetOf, shipPlan } from '../pipelineView'

describe('Ship it presets', () => {
  it('default is Recommended; any preset round-trips; a mix is custom', () => {
    expect(presetOf(DEFAULT_AUTO)).toBe('recommended')
    for (const p of AUTO_PRESETS) expect(presetOf({ ...p.steps, postMerge: false })).toBe(p.id)
    expect(presetOf({ ...DEFAULT_AUTO, ci: false })).toBeNull()
  })
  it('plan follows the settings', () => {
    const plan = shipPlan({ ...DEFAULT_AUTO, merge: true }, { channel: 'reviews', maxRounds: 2, postMerge: false })
    expect(plan).toContain('Each PR is posted to #reviews for review.')
    expect(plan).toContain('Once approved and green, it merges.')
    expect(plan.some(l => l.includes('After the merge'))).toBe(false)
    expect(shipPlan(DEFAULT_AUTO, { channel: null, maxRounds: 3, postMerge: true })).toHaveLength(7)
  })
})
