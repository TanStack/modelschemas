/**
 * D1's primary rejects further statements for about 10 seconds after
 * "too many resources" or the internal-error reset (issue #625, #635).
 */
import { errorMessage } from '#/server/errors.ts'

/**
 * How long to wait after D1 says its 10-second resource window is spent,
 * before retrying that provider once, and before the next provider (or
 * the same-as reconcile) touches the primary.
 */
export const D1_WINDOW_WAIT_MS = 10_000

/**
 * D1 overload, and the internal-error sibling that resets the same primary.
 * Either one means the next statement in the next few seconds fails too.
 */
export function d1WindowExhausted(message: string): boolean {
  const text = message.toLowerCase()
  if (!text.includes('d1')) return false
  return text.includes('overloaded') || text.includes('internal error')
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Run `work` once. A spent D1 window waits, then runs it once more.
 * Anything else, including a second spent window, throws to the caller.
 */
export async function retryOnceAfterD1Window<T>(
  job: 'models-poll' | 'spec-sync',
  providerId: string,
  work: () => Promise<T>,
  wait: (ms: number) => Promise<void>,
): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const message = errorMessage(error)
    if (!d1WindowExhausted(message)) throw error
    console.error(
      JSON.stringify({ job, providerId, error: message, retry: 'd1-window' }),
    )
    await wait(D1_WINDOW_WAIT_MS)
    return await work()
  }
}
