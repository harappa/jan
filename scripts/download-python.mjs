// Fetches the pinned python-build-standalone runtime that the python tool
// bundles, checks it against a SHA-256 pinned in this file, strips what a
// sandboxed interpreter does not need, and leaves it in
// src-tauri/resources/python/.
//
// Node built-ins only (Node >= 20), so it runs before `yarn install` too.
//
// Bumping the runtime: change RELEASE_TAG, PYTHON_VERSION and the table below
// from the release's SHA256SUMS, and verify the archives' provenance by hand
// (`gh attestation verify <archive> --repo astral-sh/python-build-standalone`).
// Provenance is deliberately not checked on every build: it needs `gh`.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RELEASE_TAG = '20261009'
const PYTHON_VERSION = '3.15.0'
// Also the name of the folder the app copies the runtime into, so the two
// cannot drift: the app reads `jan-runtime-id` and must see this exact string.
export const RUNTIME_ID = `${PYTHON_VERSION}+${RELEASE_TAG}`
const RELEASE_BASE = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}`

// From the release's SHA256SUMS. Keyed by `<process.platform>/<process.arch>`.
const TARGETS = {
  'win32/x64': {
    triple: 'x86_64-pc-windows-msvc',
    sha256: '195aeb879561118627db196e1b07704bd873c7fe80ac8068aaecb475f9db25a4',
  },
  'win32/arm64': {
    triple: 'aarch64-pc-windows-msvc',
    sha256: '95052a0841dd039cfbbf5205dcde9c0c97341c629cd28294ddd1af93bd1fb55f',
  },
  'linux/x64': {
    triple: 'x86_64-unknown-linux-gnu',
    sha256: '95ba085863806dacf0fd7119c590154bbcd3351099e55c0808a9c61603e320a8',
  },
  'linux/arm64': {
    triple: 'aarch64-unknown-linux-gnu',
    sha256: 'f02953d2c56c7eaa2fa3a21f2680a823b8748959c571ac149cd76b0fd1a1c33c',
  },
  'darwin/arm64': {
    triple: 'aarch64-apple-darwin',
    sha256: '3fb079450ee57075a790b94634206759501166e0a99de459cdad095f6c158d39',
  },
  'darwin/x64': {
    triple: 'x86_64-apple-darwin',
    sha256: '5b73d275ef59c742ae58a13130381ddf3451a5a96b2d802c8d5aa0741511baa7',
  },
}

function targetFor(platform, arch) {
  const target = TARGETS[`${platform}/${arch}`]
  if (!target) throw new Error(`Unsupported platform: ${platform}/${arch}`)
  return target
}

export function assetFor(platform, arch) {
  const { triple } = targetFor(platform, arch)
  return `cpython-${RUNTIME_ID}-${triple}-install_only.tar.gz`
}

export function sha256For(platform, arch) {
  return targetFor(platform, arch).sha256
}

export async function verifySha256(filePath, expected) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  const actual = hash.digest('hex')
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${filePath}: expected ${expected}, got ${actual}`
    )
  }
}

// Paths are relative to the extracted archive root and use `/`; the archive
// holds a single top-level `python/`. Each pattern matches a directory itself
// as well as everything under it, so the walk can drop a whole tree at once.
const STRIP = [
  // Debug symbols: 94 MB of the 161 MB Windows tree.
  /\.pdb$/,
  // Test suites and the IDLE / Tk GUI, none of which a headless run imports.
  /^python\/Lib\/(test|idlelib|tkinter|ensurepip)(\/|$)/,
  /^python\/lib\/python3\.\d+\/(test|idlelib|tkinter|ensurepip)(\/|$)/,
  /^python\/(tcl|include|libs|Scripts)(\/|$)/,
  /^python\/lib\/(tcl|tk|itcl|thread)[^/]*(\/|$)/,
  /^python\/DLLs\/(_tkinter\.pyd|(tcl|tk)\d*t?\.dll)$/,
  // Unix launchers for the stripped pieces.
  /^python\/bin\/(idle3|pip)[^/]*$/,
]

export function shouldStrip(relPath) {
  return STRIP.some((re) => re.test(relPath))
}

function stripTree(root, rel = '') {
  const dir = rel ? join(root, rel) : root
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name
    if (shouldStrip(entryRel)) {
      rmSync(join(root, entryRel), { recursive: true, force: true })
    } else if (entry.isDirectory()) {
      stripTree(root, entryRel)
    }
  }
}

function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else if (entry.isFile()) total += statSync(p).size
  }
  return total
}

async function download(url, dest) {
  console.log(`Downloading ${url} to ${dest}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Failed to get '${url}' (${response.status})`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest))
}

function interpreterRelPath(platform) {
  return platform === 'win32' ? 'python/python.exe' : 'python/bin/python3'
}

export async function main({
  platform = process.platform,
  arch = process.arch,
  repoRoot = fileURLToPath(new URL('..', import.meta.url)),
} = {}) {
  if (process.env.SKIP_BINARIES) {
    console.log('Skipping python runtime download.')
    return
  }
  const asset = assetFor(platform, arch)
  const sha256 = sha256For(platform, arch)
  const outDir = join(repoRoot, 'src-tauri', 'resources', 'python')
  const idFile = join(outDir, 'jan-runtime-id')

  // jan-runtime-id is written last, so its presence means the tree is whole.
  if (
    existsSync(idFile) &&
    readFileSync(idFile, 'utf8').trim() === RUNTIME_ID &&
    existsSync(join(outDir, interpreterRelPath(platform)))
  ) {
    console.log(`python runtime ${RUNTIME_ID} already in place.`)
    return
  }

  // Same cache folder as download-bin.mjs (gitignored).
  const cacheDir = join(repoRoot, 'scripts', 'dist')
  mkdirSync(cacheDir, { recursive: true })
  const archivePath = join(cacheDir, asset)
  if (existsSync(archivePath)) {
    try {
      await verifySha256(archivePath, sha256)
    } catch (err) {
      console.log(
        `Cached archive is unusable (${err.message}); fetching again.`
      )
      rmSync(archivePath, { force: true })
    }
  }
  if (!existsSync(archivePath)) {
    const partial = `${archivePath}.part`
    try {
      await download(`${RELEASE_BASE}/${asset}`, partial)
      await verifySha256(partial, sha256)
    } catch (err) {
      rmSync(partial, { force: true })
      throw err
    }
    renameSync(partial, archivePath)
  }

  const stageName = `python-stage-${RUNTIME_ID}`
  const stageDir = join(cacheDir, stageName)
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  // Relative names with a cwd: GNU tar on Windows reads `D:\x` as host `D`,
  // and bsdtar does not know `--force-local` to switch that off.
  execFileSync('tar', ['-xzf', asset, '-C', stageName], {
    cwd: cacheDir,
    stdio: 'inherit',
  })

  stripTree(stageDir)
  if (!existsSync(join(stageDir, interpreterRelPath(platform)))) {
    throw new Error(
      `Interpreter ${interpreterRelPath(platform)} missing after extraction`
    )
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  renameSync(join(stageDir, 'python'), join(outDir, 'python'))
  writeFileSync(idFile, RUNTIME_ID)
  rmSync(stageDir, { recursive: true, force: true })

  const mib = (dirSize(join(outDir, 'python')) / (1024 * 1024)).toFixed(1)
  console.log(`python runtime ${RUNTIME_ID} ready (${mib} MiB stripped).`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
