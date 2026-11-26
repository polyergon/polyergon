// Locale for spawned agents. Under the installer's launchd agent the server has
// no LANG at all (Terminal and iTerm set it, launchd does not), so sessions ran
// with no locale. Tools then treat text as Mac Roman: Claude Code's copy goes
// through pbcopy, and a copied non-breaking space (UTF-8 C2 A0) lands on the
// clipboard as "¬†". Pass the user's locale through, or default to UTF-8.
const LOCALE_VARS = ['LANG', 'LC_ALL', 'LC_CTYPE'] as const

export function localeEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const set = Object.fromEntries(LOCALE_VARS.filter(k => env[k]).map(k => [k, env[k]!]))
  return Object.keys(set).length ? set : { LANG: 'en_US.UTF-8' }
}
