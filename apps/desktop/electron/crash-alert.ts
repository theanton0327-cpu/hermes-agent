/**
 * Renderer/startup crash visibility — `logs/errors.log` + the existing alert
 * channel.
 *
 * WHY THIS EXISTS (2026-09-21 incident)
 * -------------------------------------
 * The installer renamed the whole `hermes-agent` tree aside
 * (`$InstallDir.broken-<stamp>`) while the desktop app was still running, then
 * failed to reach GitHub and left a half-installed tree. The running renderer
 * survived the rename and then died on its first lazy import:
 *
 *   [renderer console:main] TypeError: Failed to fetch dynamically imported
 *   module: …/app.asar.unpacked/dist/assets/settings-CAEmhRvA.js
 *   [renderer crash:main] [error-boundary:root]
 *
 * Both lines landed in `logs/desktop.log` — an append-only forensic file
 * nobody watches — and the 04:30 upgrade chain and the Feishu push chain were
 * found dead hours later. Nothing pushed the failure to a human.
 *
 * WHAT THIS ADDS
 * --------------
 * Hooks only. Every existing crash path in `main.ts` keeps its current
 * behaviour; each one additionally calls `report()`:
 *
 *   1. `logs/errors.log` — the same file `hermes_logging` (WARNING+) writes,
 *      so a desktop-side fault lands next to the Python ones a `hermes logs
 *      errors` reader already looks at. One ISO-8601 line per event, with the
 *      missing paths spelled out.
 *   2. The EXISTING alert channel — `hermes send --to feishu …`, i.e. the
 *      configured Feishu bot (`plugins/platforms/feishu/adapter.py`'s
 *      standalone sender via `hermes_cli/send_cmd.py`). No new webhook client,
 *      no new credentials: it reuses whatever the user already configured.
 *
 * Both are best-effort and must never make a crash worse: every filesystem and
 * spawn failure is swallowed. Alerts are deduped by fingerprint and capped per
 * app run, because a renderer crash loop would otherwise page a human once per
 * reload.
 *
 * The module is injectable (fs/spawn/clock) so it is unit-testable without
 * booting Electron or writing to the real log directory.
 */

export type CrashKind =
  | 'renderer-crashed'
  | 'renderer-load-failed'
  | 'renderer-gone'
  | 'bundle-torn'
  | 'startup-failed'

export interface CrashContext {
  kind: CrashKind
  /** Which window surface: 'main', 'secondary', 'overlay', 'quick', … */
  label?: string | undefined
  /** Electron's `render-process-gone` reason, or a short cause. */
  reason?: string | undefined
  exitCode?: number | string | undefined
  /** Chromium load error code, e.g. -6 / ERR_FILE_NOT_FOUND. */
  errorCode?: number | string | undefined
  /** The URL or file that failed. */
  url?: string | undefined
  /** Module files the renderer will fetch but that are not on disk. */
  missingAssets?: string[] | undefined
  /** Free-form extra line for the log. */
  detail?: string | undefined
}

const KIND_LABEL: Record<CrashKind, string> = {
  'renderer-crashed': 'renderer crashed',
  'renderer-load-failed': 'renderer failed to load',
  'renderer-gone': 'renderer terminated',
  'bundle-torn': 'renderer bundle is torn',
  'startup-failed': 'desktop startup failed'
}

const MAX_ASSETS_LISTED = 10

function clamp(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max)
}

/** One-line summary, used as the head of both the log line and the alert. */
export function summarizeCrash(ctx: CrashContext): string {
  const parts = [`${KIND_LABEL[ctx.kind] || ctx.kind}${ctx.label ? ` [${clamp(ctx.label, 32)}]` : ''}`]

  if (ctx.reason) {
    parts.push(`reason=${clamp(ctx.reason, 64)}`)
  }

  if (ctx.exitCode !== undefined && ctx.exitCode !== null && ctx.exitCode !== '') {
    parts.push(`exitCode=${clamp(ctx.exitCode, 16)}`)
  }

  if (ctx.errorCode !== undefined && ctx.errorCode !== null && ctx.errorCode !== '') {
    parts.push(`code=${clamp(ctx.errorCode, 32)}`)
  }

  return parts.join(' ')
}

/**
 * The `logs/errors.log` line. ISO-8601 UTC, matching the Python loggers
 * (`hermes_logging`), so `hermes logs errors` interleaves both writers
 * chronologically. Missing paths are spelled out — that is the one piece of
 * information the incident needed and `desktop.log` buried in a console dump.
 */
export function formatCrashAlertLine(ctx: CrashContext, now: Date = new Date()): string {
  const lines = [`${now.toISOString()} [desktop] ${summarizeCrash(ctx)}`]

  if (ctx.url) {
    lines.push(`  url: ${clamp(ctx.url, 400)}`)
  }

  const missing = ctx.missingAssets ?? []

  if (missing.length > 0) {
    lines.push(`  ${missing.length} module file(s) missing:`)

    for (const ref of missing.slice(0, MAX_ASSETS_LISTED)) {
      lines.push(`    - ${clamp(ref, 300)}`)
    }

    if (missing.length > MAX_ASSETS_LISTED) {
      lines.push(`    … and ${missing.length - MAX_ASSETS_LISTED} more`)
    }
  }

  if (ctx.detail) {
    lines.push(`  ${clamp(ctx.detail, 600)}`)
  }

  return lines.join('\n')
}

/** The push message. Deliberately short — a phone notification, not a dump. */
export function formatCrashAlertMessage(ctx: CrashContext, host: string): string {
  return [`[Hermes desktop] ${summarizeCrash(ctx)}`, host, ...formatCrashAlertLine(ctx).split('\n').slice(1)].join('\n')
}

export interface ErrorsLogDeps {
  file: string
  appendFile: (file: string, data: string) => void
  mkdirSync: (dir: string, options: { recursive: true }) => unknown
  statSync?: ((file: string) => { size: number }) | undefined
  renameSync?: ((from: string, to: string) => void) | undefined
  dirname: (file: string) => string
  maxBytes?: number | undefined
}

/**
 * Append-only sink for `logs/errors.log`, bounded the same way desktop.log is:
 * a renderer crash loop must not fill the disk. Past `maxBytes` the file is
 * rolled to `<file>.1` once (replacing any previous `.1`) instead of growing
 * forever. All failures are swallowed — logging must never take down a crash
 * path.
 */
export function createErrorsLogSink(deps: ErrorsLogDeps): (line: string) => void {
  const maxBytes = deps.maxBytes ?? 5 * 1024 * 1024
  let rolled = false

  return (line: string) => {
    const text = String(line ?? '').trim()

    if (!text) {
      return
    }

    try {
      deps.mkdirSync(deps.dirname(deps.file), { recursive: true })

      if (!rolled && deps.statSync && deps.renameSync) {
        rolled = true

        try {
          if (deps.statSync(deps.file).size > maxBytes) {
            deps.renameSync(deps.file, `${deps.file}.1`)
          }
        } catch {
          // No file yet (first write) or rename refused — append regardless.
        }
      }

      deps.appendFile(deps.file, `${text}\n`)
    } catch {
      // Logging must never crash the desktop shell.
    }
  }
}

export interface CrashAlerterDeps {
  write: (line: string) => void
  /** Fire the push. Must not throw; callers pass a best-effort spawner. */
  notify: (message: string) => void
  host?: string | undefined
  /** Max pushes per app run. A crash loop must not page a human every reload. */
  maxAlerts?: number | undefined
  now?: (() => Date) | undefined
}

export interface CrashAlerter {
  report: (ctx: CrashContext) => void
  /** Fingerprints already pushed — exposed for tests. */
  readonly sent: ReadonlySet<string>
}

/** Identity of a failure for dedupe: same kind + same missing set = same fault. */
export function crashFingerprint(ctx: CrashContext): string {
  const missing = [...(ctx.missingAssets ?? [])].sort().slice(0, 3).join(',')
  const reason = ctx.reason || ctx.errorCode || ''

  return `${ctx.kind}|${ctx.label || ''}|${reason}|${missing}`
}

/**
 * Report a renderer/startup failure to `errors.log` AND the alert channel.
 *
 * The log write is unconditional and uncapped (a forensic file wants every
 * event); only the push is deduped and capped, so a crash loop still leaves a
 * complete trail on disk while a human gets one notification.
 */
export function createCrashAlerter(deps: CrashAlerterDeps): CrashAlerter {
  const maxAlerts = deps.maxAlerts ?? 3
  const host = deps.host || 'unknown-host'
  const now = deps.now ?? (() => new Date())
  const sent = new Set<string>()

  const report = (ctx: CrashContext): void => {
    try {
      deps.write(formatCrashAlertLine(ctx, now()))
    } catch {
      // never let logging break a crash path
    }

    const fingerprint = crashFingerprint(ctx)

    if (sent.has(fingerprint) || sent.size >= maxAlerts) {
      return
    }

    sent.add(fingerprint)

    try {
      deps.notify(formatCrashAlertMessage(ctx, host))
    } catch {
      // best-effort push
    }
  }

  return { report, sent }
}
