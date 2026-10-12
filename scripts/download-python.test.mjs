// Run with: node --test scripts/download-python.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createHash } from 'node:crypto'

import {
  RUNTIME_ID,
  assetFor,
  shouldStrip,
  verifySha256,
} from './download-python.mjs'

const PREFIX = 'cpython-3.15.0+20261009-'

describe('assetFor', () => {
  const cases = [
    ['win32', 'x64', 'x86_64-pc-windows-msvc'],
    ['win32', 'arm64', 'aarch64-pc-windows-msvc'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu'],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu'],
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
  ]
  for (const [platform, arch, triple] of cases) {
    it(`${platform}/${arch} -> ${triple}`, () => {
      assert.equal(
        assetFor(platform, arch),
        `${PREFIX}${triple}-install_only.tar.gz`
      )
    })
  }

  it('names the Windows x64 archive exactly', () => {
    assert.equal(
      assetFor('win32', 'x64'),
      'cpython-3.15.0+20261009-x86_64-pc-windows-msvc-install_only.tar.gz'
    )
  })

  it('rejects an unsupported platform or architecture', () => {
    assert.throws(() => assetFor('freebsd', 'x64'), /Unsupported/)
    assert.throws(() => assetFor('linux', 'ia32'), /Unsupported/)
    assert.throws(() => assetFor('win32', 'ia32'), /Unsupported/)
  })

  it('pins the runtime id', () => {
    assert.equal(RUNTIME_ID, '3.15.0+20261009')
  })
})

describe('verifySha256', () => {
  const dir = mkdtempSync(join(tmpdir(), 'download-python-test-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'blob.bin')
  const body = Buffer.from('jan python runtime')
  writeFileSync(file, body)
  const good = createHash('sha256').update(body).digest('hex')

  it('passes when the digest matches (case-insensitive)', async () => {
    await verifySha256(file, good)
    await verifySha256(file, good.toUpperCase())
  })

  it('fails with a SHA-256 mismatch otherwise', async () => {
    await assert.rejects(verifySha256(file, '0'.repeat(64)), /SHA-256 mismatch/)
  })
})

describe('shouldStrip', () => {
  const stripped = [
    'python/python.pdb',
    'python/DLLs/_ssl.pdb',
    'python/Lib/test/x.py',
    'python/Lib/test',
    'python/Lib/idlelib/x.py',
    'python/Lib/tkinter/x.py',
    'python/tcl/x',
    'python/include/x.h',
    'python/libs/x.lib',
    'python/Scripts/pip.exe',
    'python/Lib/ensurepip/x.py',
    // Unix layout
    'python/lib/python3.15/test/x.py',
    'python/lib/python3.15/idlelib/x.py',
    'python/lib/python3.15/tkinter/x.py',
    'python/lib/python3.15/ensurepip/x.py',
    'python/lib/tcl9.0/x',
    'python/lib/tk9.0/x',
    'python/bin/idle3',
    'python/bin/pip3',
  ]
  const kept = [
    'python/Lib/json/__init__.py',
    'python/python.exe',
    'python/DLLs/_ssl.pyd',
    'python/Lib/site-packages/README.txt',
    'python/lib/python3.15/json/__init__.py',
    'python/lib/python3.15/test_support_not.py',
    'python/lib/libpython3.15.so.1.0',
    'python/bin/python3',
    // names that merely start with a stripped directory's name
    'python/Lib/testing/x.py',
    'python/includes/x.h',
  ]
  for (const p of stripped) {
    it(`strips ${p}`, () => assert.equal(shouldStrip(p), true))
  }
  for (const p of kept) {
    it(`keeps ${p}`, () => assert.equal(shouldStrip(p), false))
  }
})
