import { localeEnv } from '../localeEnv'

describe('localeEnv', () => {
  it('defaults to UTF-8 when no locale is set (launchd)', () => {
    expect(localeEnv({ PATH: '/usr/bin' })).toEqual({ LANG: 'en_US.UTF-8' })
  })

  it("keeps the user's locale when one is set", () => {
    expect(localeEnv({ LANG: 'he_IL.UTF-8' })).toEqual({ LANG: 'he_IL.UTF-8' })
    expect(localeEnv({ LC_ALL: 'de_DE.UTF-8', LC_CTYPE: 'UTF-8' })).toEqual({ LC_ALL: 'de_DE.UTF-8', LC_CTYPE: 'UTF-8' })
  })

  it('treats empty values as unset', () => {
    expect(localeEnv({ LANG: '' })).toEqual({ LANG: 'en_US.UTF-8' })
  })
})
