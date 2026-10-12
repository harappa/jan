import { memo, useCallback, useMemo, useRef, useState } from 'react'
import type { ToolUIPart } from 'ai'
import { toast } from 'sonner'
import {
  IconAlertTriangle,
  IconBrandPython,
  IconFile,
} from '@tabler/icons-react'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Button } from '@/components/ui/button'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { messageOf, parsePythonOutput, savePythonFile } from '@/lib/pythonTool'
import { isToolRunning, type ToolCallBar } from '@/lib/toolPresentation'
import { cn, formatBytes } from '@/lib/utils'
import { Caret } from './ToolBar'

/** Code longer than this folds until the user expands it. */
const FOLD_AFTER_LINES = 15

/** A signal, timeout or limit stopped the run: it did not finish by itself. */
const STOPPED_NOTE = /^\[(terminated by signal|timed out|stopped:)/

/** The program printed more than the result keeps: only its end is shown. */
const isTruncationNote = (note: string) => note.startsWith('[output truncated')

const outputText = (output: unknown): string =>
  typeof output === 'string'
    ? output
    : typeof (output as { content?: unknown })?.content === 'string'
      ? (output as { content: string }).content
      : ''

const formatSize = (bytes: number) =>
  formatBytes(bytes, { decimals: (_, unit) => (unit === 'B' ? 0 : 1) })

const Block = ({ children }: { children: React.ReactNode }) => (
  <pre className="max-h-56 overflow-auto whitespace-pre-wrap wrap-break-word text-muted-foreground">
    {children}
  </pre>
)

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <p className="mb-0.5 select-none font-sans text-[11px] uppercase tracking-wide text-muted-foreground/60">
    {children}
  </p>
)

const CodeBlock = ({ code, running }: { code: string; running: boolean }) => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const lines = useMemo(() => code.split('\n'), [code])
  const foldable = lines.length > FOLD_AFTER_LINES
  const shown =
    foldable && !expanded ? lines.slice(0, FOLD_AFTER_LINES).join('\n') : code

  return (
    <div>
      <SectionLabel>{t('tools:python.code')}</SectionLabel>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap wrap-break-word text-foreground">
        {shown}
        {running && <Caret />}
      </pre>
      {foldable && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="mt-0.5 cursor-pointer font-sans text-muted-foreground underline-offset-2 hover:underline"
        >
          {expanded
            ? t('tools:toolCall.showLess')
            : t('tools:toolCall.showMore')}
        </button>
      )}
    </div>
  )
}

type FilesProps = {
  files: { path: string; size: number }[]
  moreFiles: number
  threadId?: string
}

const FileList = ({ files, moreFiles, threadId }: FilesProps) => {
  const { t } = useTranslation()
  // The ref closes the window between a click and the re-render that disables
  // the button; the state is what the buttons render from.
  const inFlight = useRef(new Set<string>())
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set())

  const save = useCallback(
    async (path: string) => {
      if (!threadId || inFlight.current.has(path)) return
      inFlight.current.add(path)
      setSaving(new Set(inFlight.current))
      try {
        const saved = await savePythonFile(threadId, path)
        // null: the user closed the dialog, which needs no answer.
        if (typeof saved === 'string')
          toast.success(t('tools:python.saved', { path: saved }))
      } catch (error) {
        toast.error(t('tools:python.saveFailed', { reason: messageOf(error) }))
      } finally {
        inFlight.current.delete(path)
        setSaving(new Set(inFlight.current))
      }
    },
    [threadId, t]
  )

  return (
    <div>
      <SectionLabel>{t('tools:python.files')}</SectionLabel>
      <ul className="space-y-1">
        {files.map((file) => (
          <li key={file.path} className="flex items-center gap-2">
            <IconFile size={14} className="shrink-0 text-muted-foreground" />
            <span
              className="min-w-0 flex-1 truncate text-foreground"
              title={file.path}
            >
              {file.path}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground/70">
              {formatSize(file.size)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0 font-sans"
              disabled={!threadId || saving.has(file.path)}
              onClick={() => void save(file.path)}
            >
              {t('tools:python.saveAs')}
            </Button>
          </li>
        ))}
      </ul>
      {moreFiles > 0 && (
        <p className="mt-1 text-muted-foreground/70">
          {t('tools:python.moreFiles', { count: moreFiles })}
        </p>
      )}
    </div>
  )
}

export type PythonWidgetProps = {
  bar: Extract<ToolCallBar, { variant: 'python' }>
  state: ToolUIPart['state']
  output?: ToolUIPart['output']
  errorText?: string
}

/**
 * `python` rendered like the terminal: the code the model wrote, what it
 * printed, how it ended, and the files it left in the chat's workspace, each
 * with a button that opens the native "save as" dialog.
 *
 * The result is one string (see `parsePythonOutput`); the markers Rust adds to
 * it become the exit chip, the notes and the file list instead of staying in
 * the text. While the call runs there is no result, so the card shows the code
 * and a running state, and no file can be saved yet.
 */
export const PythonWidget = memo(
  ({ bar, state, output, errorText }: PythonWidgetProps) => {
    const { t } = useTranslation()
    const threadId = useThreads((s) => s.currentThreadId)
    const running = isToolRunning(state)
    const result = useMemo(
      () => (output ? parsePythonOutput(outputText(output)) : undefined),
      [output]
    )

    const body = result?.body || errorText || ''
    const notes = result?.notes ?? []
    const stopped = notes.some((note) => STOPPED_NOTE.test(note))
    const truncated = notes.some(isTruncationNote)
    const exitCode = result?.exitCode
    // A failure to set up the run has no exit code and no stop marker; it is
    // reported as `ERROR: ...` in the body.
    const failed =
      errorText !== undefined ||
      (exitCode !== undefined && exitCode !== 0) ||
      (result !== undefined &&
        exitCode === undefined &&
        !stopped &&
        body.startsWith('ERROR:'))

    return (
      <div className="overflow-hidden rounded-md border bg-card/60">
        <div className="flex items-center gap-1.5 border-b px-2 py-1 text-xs text-muted-foreground">
          <IconBrandPython size={14} className="shrink-0" />
          <span className="font-medium">{t('tools:python.title')}</span>
          {failed && (
            <span data-testid="python-status-error" className="shrink-0">
              <IconAlertTriangle
                size={13}
                aria-hidden="true"
                className="text-destructive"
              />
            </span>
          )}
          {(stopped || truncated || exitCode !== undefined) && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {truncated && (
                <span className="rounded bg-muted px-1.5 py-0.5">
                  {t('tools:python.truncated')}
                </span>
              )}
              {stopped && (
                <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">
                  {t('tools:toolCall.terminated')}
                </span>
              )}
              {exitCode !== undefined && (
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 font-mono',
                    // Neutral on success, as in the terminal: the default
                    // accent reads as a failure next to `exit 0`.
                    failed
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-muted text-muted-foreground'
                  )}
                >
                  {t('tools:toolCall.exitCode', { code: exitCode })}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="space-y-2 px-2 py-1.5 font-mono text-xs">
          <CodeBlock code={bar.code} running={running} />
          {running && (
            <div className="font-sans text-sm">
              <Shimmer duration={1}>{t('tools:toolCall.working')}</Shimmer>
            </div>
          )}
          {!running && body && (
            <div>
              <SectionLabel>{t('tools:python.output')}</SectionLabel>
              <Block>{body}</Block>
            </div>
          )}
          {!running &&
            notes.map((note, i) => (
              <p
                key={`${i}-${note}`}
                className="flex items-start gap-1.5 text-muted-foreground/70"
              >
                <IconAlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span className="min-w-0 wrap-break-word">{note}</span>
              </p>
            ))}
          {!running &&
            result &&
            (result.files.length > 0 || result.moreFiles > 0) && (
              <FileList
                files={result.files}
                moreFiles={result.moreFiles}
                threadId={threadId}
              />
            )}
        </div>
      </div>
    )
  }
)

PythonWidget.displayName = 'PythonWidget'
