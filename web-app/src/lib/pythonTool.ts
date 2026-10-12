import {
  pythonStatus,
  pythonRun,
  pythonCancel,
  pythonSaveFile,
} from '@janhq/tauri-plugin-agent-tools-api'
import { getServiceHub } from '@/hooks/useServiceHub'

export const PYTHON_TOOL_NAME = 'python'

/**
 * What the model reads about the tool. Nothing that changes during a
 * conversation (attachment names, sizes) may appear here or in the system
 * section: either would change the prompt prefix and discard the cache. The
 * model finds attachments in each message's own attachment list.
 */
export const PYTHON_TOOL_DESCRIPTION = [
  "Run Python 3.15 code in an isolated sandbox on the user's computer and return its output.",
  'Use it for calculations, counting, parsing and transforming data, and reading attached files: anything a short program gets exactly right.',
  '- Only the Python standard library is available. You cannot install packages (no pip), and there is no network access: no HTTP requests, APIs or downloads.',
  '- Every call starts a fresh interpreter, so variables do not carry over. Files do: the working directory is a private workspace for this chat, and what you write there stays for later calls.',
  '- Files the user attached are read-only copies in the folder named by the JAN_INPUTS environment variable, under their attached names. Nothing else on the computer can be read.',
  '- To give the user a file, write it to the working directory; they can save it from the tool card. There is no display, so save charts and images to files.',
  '- Limits: the run stops after `timeout` seconds (default 30, at most 300), or when it writes more than 1 GB. Output is capped at 64 KB and the end is kept, so print summaries rather than large data.',
  '- The result ends with the exit code and the files the run created or changed.',
].join('\n')

export const PYTHON_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'The Python code to run.' },
    timeout: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description:
        'Seconds before the run is stopped (default 30, at most 300).',
    },
  },
  required: ['code'],
} as const

/** The `# Python` section of the system prompt. */
export const PYTHON_SYSTEM_SECTION = [
  '# Python',
  'You can run Python with the `python` tool. Use it whenever an answer depends on exact computation, on counting or transforming data, or on the contents of attached files, instead of working it out by hand. It runs offline in a sandbox with the standard library only.',
].join('\n')

export type PythonAvailability = { available: boolean; reason?: string }

let statusCache: Promise<PythonAvailability> | null = null

/**
 * Whether the python tool can run here. Asked once and kept for the app's
 * lifetime: the sandbox and the bundled runtime do not change while the app
 * runs. Never rejects; outside Tauri (web-only dev) the answer is "no".
 */
export function getPythonStatus(): Promise<PythonAvailability> {
  if (!statusCache) {
    statusCache = pythonStatus().then(
      (status): PythonAvailability =>
        status.available
          ? { available: true }
          : {
              available: false,
              ...(status.reason ? { reason: status.reason } : {}),
            },
      (error): PythonAvailability => ({
        available: false,
        reason: messageOf(error),
      })
    )
  }
  return statusCache
}

/**
 * A file the user attached, to be copied into the run as a read-only input:
 * a file on disk (`path`) or text the app already holds (`content`).
 */
export type PythonAttachment = {
  name: string
  path?: string
  content?: string
}

export type PythonResult = { content: string; isError: boolean }

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return String(error)
}

async function janDataFolder(): Promise<string> {
  const folder = await getServiceHub().app().getJanDataFolder()
  if (!folder) throw new Error('Jan data folder is unavailable')
  return folder
}

/**
 * Run `input.code` in the chat's sandbox. A failure to start (no data folder,
 * IPC error) comes back as an `ERROR:` result the model can read, like the
 * runtime's own setup errors, rather than as a throw.
 */
export async function executePython(
  threadId: string,
  input: { code: string; timeout?: number },
  attachments: PythonAttachment[]
): Promise<PythonResult> {
  try {
    const dataFolder = await janDataFolder()
    const timeout =
      typeof input.timeout === 'number' && Number.isFinite(input.timeout)
        ? input.timeout
        : undefined
    const result = await pythonRun(
      dataFolder,
      threadId,
      input.code,
      timeout,
      attachments
    )
    return { content: result.content, isError: result.isError }
  } catch (error) {
    return { content: `ERROR: ${messageOf(error)}`, isError: true }
  }
}

/** Stop the chat's run (the Stop button). Resolves to whether one was going. */
export async function cancelPython(threadId: string): Promise<boolean> {
  try {
    return await pythonCancel(threadId)
  } catch (error) {
    console.warn('Failed to cancel the python run:', error)
    return false
  }
}

/**
 * Save a file a run left in the workspace; Jan opens the native "save as"
 * dialog. Resolves to the saved path, or null when the user cancelled. Rejects
 * with the reason when the file cannot be saved.
 */
export async function savePythonFile(
  threadId: string,
  relativePath: string
): Promise<string | null> {
  return await pythonSaveFile(await janDataFolder(), threadId, relativePath)
}

export type ParsedPythonOutput = {
  /** What the program printed, without the result markers. */
  body: string
  exitCode?: number
  files: { path: string; size: number }[]
  /** Files the run changed that the list does not show. */
  moreFiles: number
  /** Timeout, stop, skipped-input and truncation lines, verbatim, in order. */
  notes: string[]
}

const EXIT_MARKER = /^\[exit (-?\d+)\]$/
// Greedy, so the size is read from the last " (<digits> bytes)]" even when the
// name itself contains spaces and parentheses.
const FILE_MARKER = /^\[file: (.+) \((\d+) bytes\)\]$/
const MORE_FILES_MARKER = /^\[files: (\d+) more not listed\]$/
const NOTE_MARKERS = [
  /^\[timed out after .*\]$/,
  /^\[stopped: .*\]$/,
  /^\[input skipped: .*\]$/,
  /^\[output truncated/,
]

const isMarker = (line: string): boolean =>
  EXIT_MARKER.test(line) ||
  FILE_MARKER.test(line) ||
  MORE_FILES_MARKER.test(line) ||
  NOTE_MARKERS.some((re) => re.test(line))

/**
 * Split a python result into the program's output and the markers Rust adds
 * after it (see `python::run::format_result`). The markers are one contiguous
 * run of lines at the very end, starting at `[exit N]`; the same text earlier
 * in the output is the program's own and stays in the body.
 */
export function parsePythonOutput(output: string): ParsedPythonOutput {
  const lines = output.split('\n').map((l) => l.replace(/\r$/, ''))

  let start = lines.length
  while (start > 0 && isMarker(lines[start - 1])) start--
  // The real exit marker is the last one in the run; anything before it was
  // printed by the program.
  for (let i = lines.length - 1; i >= start; i--) {
    if (EXIT_MARKER.test(lines[i])) {
      start = i
      break
    }
  }

  const parsed: ParsedPythonOutput = {
    body: '',
    files: [],
    moreFiles: 0,
    notes: [],
  }
  for (const line of lines.slice(start)) {
    const exit = EXIT_MARKER.exec(line)
    if (exit) {
      parsed.exitCode = Number(exit[1])
      continue
    }
    const file = FILE_MARKER.exec(line)
    if (file) {
      parsed.files.push({ path: file[1], size: Number(file[2]) })
      continue
    }
    const more = MORE_FILES_MARKER.exec(line)
    if (more) {
      parsed.moreFiles = Number(more[1])
      continue
    }
    parsed.notes.push(line)
  }

  let end = start
  while (end > 0 && lines[end - 1].trim() === '') end--
  parsed.body = lines.slice(0, end).join('\n')
  return parsed
}
