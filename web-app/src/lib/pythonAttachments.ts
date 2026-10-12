import type { UIMessage } from '@ai-sdk/react'
import { ExtensionTypeEnum, type VectorDBExtension } from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import type { PythonAttachment } from '@/lib/pythonTool'

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const recordsOf = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null
      )
    : []

/**
 * The files a user message carries, as the code can see them: PDFs sent as
 * they are (`native_files`, with a path on disk) and documents whose text went
 * into the message (`inline_file_contents`, no file; Jan writes them out as
 * `<name>.txt`). Images are not recorded in the metadata and are not passed.
 */
function attachmentsOfMessage(message: UIMessage): PythonAttachment[] {
  if (message.role !== 'user') return []
  const metadata = message.metadata as
    | { native_files?: unknown; inline_file_contents?: unknown }
    | undefined

  const found: PythonAttachment[] = []
  for (const file of recordsOf(metadata?.native_files)) {
    if (isNonEmptyString(file.name) && isNonEmptyString(file.path)) {
      found.push({ name: file.name, path: file.path })
    }
  }
  for (const file of recordsOf(metadata?.inline_file_contents)) {
    if (isNonEmptyString(file.name) && isNonEmptyString(file.content)) {
      found.push({ name: file.name, content: file.content })
    }
  }
  return found
}

/** The files attached to the chat itself (the vector database's list). */
async function attachmentsOfThread(
  threadId: string
): Promise<PythonAttachment[]> {
  try {
    const extension = ExtensionManager.getInstance().get<VectorDBExtension>(
      ExtensionTypeEnum.VectorDB
    )
    const files = (await extension?.listAttachments?.(threadId)) ?? []
    return files.flatMap((file) =>
      isNonEmptyString(file?.name) && isNonEmptyString(file?.path)
        ? [{ name: file.name, path: file.path }]
        : []
    )
  } catch (error) {
    // A run does not depend on the vector database: it just sees fewer files.
    console.warn('Failed to list the chat attachments for python:', error)
    return []
  }
}

/**
 * Every file the python tool may read for this chat, for `executePython`:
 * those the user's messages carry, then the chat's own attachments. A file on
 * disk that appears twice counts once (the first wins). Names are passed as
 * they are; Jan makes them safe and unique when it stages the copies.
 */
export async function collectPythonAttachments(
  threadId: string,
  messages: UIMessage[]
): Promise<PythonAttachment[]> {
  const all = [
    ...messages.flatMap(attachmentsOfMessage),
    ...(await attachmentsOfThread(threadId)),
  ]
  const seenPaths = new Set<string>()
  return all.filter((attachment) => {
    if (!attachment.path) return true
    if (seenPaths.has(attachment.path)) return false
    seenPaths.add(attachment.path)
    return true
  })
}
