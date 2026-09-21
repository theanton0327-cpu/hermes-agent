/**
 * Outbound ops alert from the desktop shell.
 *
 * Reuses the EXISTING alert channel rather than adding a transport: spawning
 * `hermes send --to <target> <message>`, which routes through
 * `hermes_cli/send_cmd.py` → `tools/send_message_tool.py` → the configured
 * platform adapter (for Feishu: `plugins/platforms/feishu/adapter.py`'s
 * standalone sender). Whatever chat the user already wired up for alerts —
 * its credentials, its home channel — is what this uses. No new webhook URL,
 * no new secret, no new dependency.
 *
 * CANDIDATE ORDER MATTERS
 * -----------------------
 * The 2026-09-21 incident is exactly the case where the obvious path is gone:
 * the installer renamed the tree aside, so `<installRoot>/venv/Scripts/hermes.exe`
 * no longer exists by the time we want to report it. So the launcher is
 * resolved from several roots, newest-runtime first, then the Hermes-managed
 * bin dir, then plain PATH — and a missing candidate is skipped, never fatal.
 *
 * Best-effort by construction: this runs on crash paths. It never throws,
 * never blocks the caller, and gives up after `timeoutMs`.
 */

/** The slice of a spawned child this module uses — keeps callers free to hand
 *  in Electron's or node's `spawn` without matching its generic overloads. */
export interface OpsAlertChild {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown
  kill: () => unknown
  unref?: (() => unknown) | undefined
}

export interface OpsAlertSpawn {
  (file: string, args: string[], options: Record<string, unknown>): OpsAlertChild
}

export interface NotifyOpsDeps {
  spawn: OpsAlertSpawn
  /** Ordered launcher candidates; the first that exists is used. */
  candidates: string[]
  exists: (file: string) => boolean
  env?: Record<string, string | undefined> | undefined
  /** Platform target for `hermes send --to`. Default `feishu`. */
  target?: string | undefined
  timeoutMs?: number | undefined
}

/**
 * Launcher candidates for `hermes send`, in preference order.
 *
 * `installRoot` is the tree the running app belongs to. `hermesHome` is the
 * user's Hermes home (`%LOCALAPPDATA%\hermes`), which survives the tree swap —
 * its `bin/` shim is the fallback that still works when the install tree was
 * renamed out from under us.
 */
export function hermesSendCandidates(options: {
  installRoot?: string | undefined
  hermesHome?: string | undefined
  isWindows: boolean
  join: (...parts: string[]) => string
}): string[] {
  const { installRoot, hermesHome, isWindows, join } = options
  const exe = isWindows ? 'hermes.exe' : 'hermes'
  const out: string[] = []

  if (installRoot) {
    out.push(join(installRoot, 'venv', isWindows ? 'Scripts' : 'bin', exe))
  }

  if (hermesHome) {
    out.push(join(hermesHome, 'bin', exe))
  }

  // Last resort: let the OS resolve it from PATH. `spawn` with a bare name
  // goes through PATHEXT on Windows, so `hermes` finds hermes.cmd too.
  out.push('hermes')

  return out
}

/**
 * Fire the alert. Returns the launcher actually used, or null when none was
 * available / the spawn failed. Never throws.
 */
export function notifyOps(message: string, deps: NotifyOpsDeps): string | null {
  const text = String(message ?? '').trim()

  if (!text) {
    return null
  }

  const target = deps.target || 'feishu'
  const timeoutMs = deps.timeoutMs ?? 15000

  for (const candidate of deps.candidates) {
    // A bare name is a PATH lookup — `exists` cannot answer for it, so only
    // absolute candidates are probed.
    const absolute = candidate.includes('/') || candidate.includes('\\')

    if (absolute) {
      try {
        if (!deps.exists(candidate)) {
          continue
        }
      } catch {
        continue
      }
    }

    try {
      const child = deps.spawn(candidate, ['send', '--to', target, '--quiet', text], {
        // `windowsHide` keeps a console window from flashing on Windows; the
        // credential-bearing env is the caller's (HERMES_HOME/.env is where
        // the platform bot token lives).
        env: deps.env,
        stdio: 'ignore',
        windowsHide: true
      })

      child.on('error', () => {})
      child.unref?.()

      // Bounded: a wedged child must not accumulate across a crash loop.
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // already gone
        }
      }, timeoutMs)

      timer.unref?.()

      return candidate
    } catch {
      // try the next candidate
    }
  }

  return null
}
