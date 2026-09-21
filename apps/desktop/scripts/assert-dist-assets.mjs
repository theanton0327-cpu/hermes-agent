/**
 * assert-dist-assets.mjs — build-time guard: every module file the renderer
 * generation *declares* must actually exist on disk.
 *
 * WHY THIS EXISTS (2026-09-21 incident)
 * -------------------------------------
 * The installer swaps the whole `hermes-agent` tree aside
 * (`$InstallDir.broken-<stamp>`) while the desktop app is still running, then
 * fails to reach GitHub and leaves a half-installed tree. The running app
 * survives the rename for a while and then dies on the first lazy import:
 *
 *   [renderer console:main] TypeError: Failed to fetch dynamically imported
 *   module: …/app.asar.unpacked/dist/assets/settings-CAEmhRvA.js
 *   [renderer crash:main] [error-boundary:root]
 *
 * `assert-dist-built.mjs` runs before this one and only proves *an* assets
 * directory with *some* .js file exists — an index.html and hashed chunks from
 * different generations pass that check and still white-screen. This one walks
 * the actual reference graph and names the missing files, so a torn bundle is
 * caught at build/packaging time instead of in the user's window.
 *
 * WHAT IT CHECKS
 * --------------
 * Reuses the runtime loader's own walk (`missingRendererAssets` in
 * electron/renderer-bundle.ts) so build-time and load-time can never disagree
 * on what "complete" means:
 *   1. index.html's `<script type="module">` / `<link rel="modulepreload">` refs
 *   2. every entry in `renderer-manifest.json`, when that manifest is paired
 *      with this index's generation (imports / dynamicImports / css / assets)
 *   3. the `__vite__mapDeps` lazy-chunk tables baked into each JS chunk — the
 *      `React.lazy()` routes that die AFTER index.html's own preloads check out
 *
 * It reports on both trees the packaged app can load from:
 *   * `apps/desktop/dist` — the canonical build output
 *   * `release/<platform>-unpacked/resources/app.asar.unpacked/dist` — the copy
 *     the packaged app actually fetches chunks from (`asarUnpack: ["dist/**"]`).
 *     A torn copy here is exactly what the running app loads.
 *
 * `renderer-bundle.ts` is imported directly: every Node line this package
 * supports (`engines`: ^22.22.0 || ^24.11.0 || >=26.0.0) strips TypeScript
 * types by default, and the module is dependency-free apart from node:fs /
 * node:path.
 *
 * Wired into the existing `postbuild` hook, so `build`, `pack` and `dist*`
 * all inherit it. Set HERMES_SKIP_PACKAGED_DIST_CHECK=1 to skip only the
 * packaged-tree pass (e.g. a release dir left by an unrelated interrupted
 * pack); the `dist/` pass always runs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { isMain } from './utils.mjs'

const SKIP_PACKAGED = process.env.HERMES_SKIP_PACKAGED_DIST_CHECK === '1'

/**
 * Pure check for one dist directory.
 *
 * Returns `{ ok: true, declared }` or `{ ok: false, missing, declared }`.
 * An unreadable or absent index.html is NOT this guard's failure:
 * `assert-dist-built.mjs` owns "there is no bundle at all", and duplicating it
 * here would only produce a second, differently-worded error for the same
 * cause. `missingRendererAssets` returns an empty list in that case, surfaced
 * here as `skipped`.
 */
export function checkDistAssets(distDir, deps) {
  const { missingRendererAssets, parseModuleAssetRefs, readFileSync } = deps
  const indexPath = join(distDir, 'index.html')

  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    return { ok: true, missing: [], declared: [], indexPath, skipped: 'no index.html' }
  }

  // index.html's own refs are the boot-critical set. Reported for context even
  // on a pass, and the only refs available when the manifest is absent.
  let declared = []

  try {
    declared = parseModuleAssetRefs(readFileSync(indexPath, 'utf8'))
  } catch {
    declared = []
  }

  const missing = missingRendererAssets(indexPath)

  return { ok: missing.length === 0, missing, declared, indexPath, skipped: null }
}

/** Packaged trees the running app can load from, in readdir order. */
export function packagedDistDirs(desktopRoot) {
  const releaseDir = join(desktopRoot, 'release')

  if (!existsSync(releaseDir) || !statSync(releaseDir).isDirectory()) {
    return []
  }

  const dirs = []

  for (const name of readdirSync(releaseDir)) {
    const dist = join(releaseDir, name, 'resources', 'app.asar.unpacked', 'dist')

    if (existsSync(join(dist, 'index.html'))) {
      dirs.push(dist)
    }
  }

  return dirs
}

async function loadWalker() {
  try {
    const mod = await import('../electron/renderer-bundle.ts')

    if (typeof mod.missingRendererAssets !== 'function' || typeof mod.parseModuleAssetRefs !== 'function') {
      throw new Error('renderer-bundle.ts is missing missingRendererAssets/parseModuleAssetRefs')
    }

    return {
      missingRendererAssets: mod.missingRendererAssets,
      // readFileSync here is node:fs, NOT renderer-bundle.ts's Electron
      // asar-aware default — irrelevant for a build-time path, and it keeps
      // this script importable under plain node.
      parseModuleAssetRefs: mod.parseModuleAssetRefs,
      readFileSync
    }
  } catch (error) {
    console.error(`\n✗ assert-dist-assets: cannot load the renderer-bundle walker: ${error?.message || error}`)
    console.error('  This guard reuses electron/renderer-bundle.ts so build-time and')
    console.error('  load-time agree on what "a complete renderer bundle" means.')
    console.error(`  Node ${process.version} must support TypeScript type stripping (Node >=22.18).`)
    console.error('  Refusing to pass silently — an unverified bundle is what this guard exists to stop.\n')
    process.exit(2)
  }
}

async function main() {
  const desktopRoot = resolve(import.meta.dirname, '..')
  const walker = await loadWalker()

  const targets = [{ label: 'dist', dir: join(desktopRoot, 'dist') }]

  if (!SKIP_PACKAGED) {
    for (const dir of packagedDistDirs(desktopRoot)) {
      targets.push({ label: 'packaged app.asar.unpacked', dir })
    }
  }

  let failed = false

  for (const target of targets) {
    const result = checkDistAssets(target.dir, walker)

    if (result.skipped) {
      console.log(`• assert-dist-assets: skipping ${target.label} (${result.skipped}) at ${target.dir}`)
      continue
    }

    if (result.ok) {
      console.log(
        `✓ assert-dist-assets: ${target.label} — ${result.declared.length} boot ref(s) + ` +
          `their lazy-chunk graph resolve to files on disk`
      )
      continue
    }

    failed = true

    console.error(`\n✗ assert-dist-assets: ${target.label} at ${target.dir} is TORN`)
    console.error(`  ${result.missing.length} module file(s) the renderer will fetch are missing:`)

    for (const ref of result.missing.slice(0, 25)) {
      console.error(`    - ${ref}`)
    }

    if (result.missing.length > 25) {
      console.error(`    … and ${result.missing.length - 25} more`)
    }
  }

  if (failed) {
    console.error('\n  index.html and its hashed chunks are ONE generation. A bundle that')
    console.error('  declares chunks it does not ship loads fine and then dies on the first')
    console.error('  lazy import ("Failed to fetch dynamically imported module") — a white')
    console.error('  screen no restart repairs.')
    console.error('  Re-run the build, then package again:')
    console.error(`    cd ${desktopRoot} && npm run build\n`)
    process.exit(1)
  }
}

if (isMain(import.meta.url)) {
  await main()
}

export default { checkDistAssets, packagedDistDirs }
