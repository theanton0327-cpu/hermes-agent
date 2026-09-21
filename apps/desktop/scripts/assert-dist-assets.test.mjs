import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'

import { checkDistAssets, packagedDistDirs } from './assert-dist-assets.mjs'

// The real walker, so the test exercises the same graph the build guard uses.
const { missingRendererAssets, parseModuleAssetRefs } = await import('../electron/renderer-bundle.ts')
const walker = { missingRendererAssets, parseModuleAssetRefs, readFileSync: fs.readFileSync }

function makeDist() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-assert-dist-assets-'))
  const distDir = path.join(tempRoot, 'dist')
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true })
  return { tempRoot, distDir }
}

function writeIndex(distDir, refs) {
  const tags = refs
    .map(ref => `<link rel="modulepreload" crossorigin href="./${ref}">`)
    .join('\n    ')

  fs.writeFileSync(
    path.join(distDir, 'index.html'),
    `<!doctype html>\n<html><head>\n    ${tags}\n</head><body><div id="root"></div></body></html>`,
    'utf8'
  )
}

test('passes when every ref index.html declares exists', () => {
  const { tempRoot, distDir } = makeDist()
  try {
    fs.writeFileSync(path.join(distDir, 'assets', 'index-abc.js'), 'export const a = 1', 'utf8')
    writeIndex(distDir, ['assets/index-abc.js'])

    const result = checkDistAssets(distDir, walker)
    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.declared, ['assets/index-abc.js'])
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('reports the missing lazy chunk that dies after index.html preloads check out', () => {
  const { tempRoot, distDir } = makeDist()
  try {
    // The 2026-09-21 shape: index.html's own refs are present, and the chunk a
    // React.lazy() route fetches later is gone — the "Failed to fetch
    // dynamically imported module: …/assets/settings-CAEmhRvA.js" crash.
    // Only the lazy chunk is gone; the entry's own import is present.
    fs.writeFileSync(path.join(distDir, 'assets', 'sdk-CE2L1ZzP.js'), 'export const sdk = 1', 'utf8')

    // Byte-shape copied from a real vite/rolldown chunk: the filename table
    // lives inside the `__vite__mapDeps` definition, `./`-prefixed.
    fs.writeFileSync(
      path.join(distDir, 'assets', 'index-abc.js'),
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./sdk-CE2L1ZzP.js",' +
        '"./settings-CAEmhRvA.js"])))=>i.map(i=>d[i]);\n__vite__mapDeps([0,1]);',
      'utf8'
    )
    writeIndex(distDir, ['assets/index-abc.js'])

    const result = checkDistAssets(distDir, walker)
    assert.equal(result.ok, false)
    // Without renderer-manifest.json the walk falls back to the chunk graph,
    // which spells map-deps refs relative to the CHUNK's own dir — that is the
    // spelling the runtime loader reports too (see renderer-bundle.ts).
    assert.deepEqual(result.missing, ['settings-CAEmhRvA.js'])
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('a dist with no index.html is skipped, not failed (assert-dist-built owns that)', () => {
  const { tempRoot, distDir } = makeDist()
  try {
    const result = checkDistAssets(distDir, walker)
    assert.equal(result.ok, true)
    assert.equal(result.skipped, 'no index.html')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('packagedDistDirs finds release/*/resources/app.asar.unpacked/dist only when it has an index.html', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-assert-dist-assets-pkg-'))
  try {
    const withIndex = path.join(tempRoot, 'release', 'win-unpacked', 'resources', 'app.asar.unpacked', 'dist')
    const withoutIndex = path.join(tempRoot, 'release', 'linux-unpacked', 'resources', 'app.asar.unpacked', 'dist')
    fs.mkdirSync(withIndex, { recursive: true })
    fs.mkdirSync(withoutIndex, { recursive: true })
    fs.writeFileSync(path.join(withIndex, 'index.html'), '<!doctype html>', 'utf8')

    assert.deepEqual(packagedDistDirs(tempRoot), [withIndex])
    assert.deepEqual(packagedDistDirs(path.join(tempRoot, 'nope')), [])
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
