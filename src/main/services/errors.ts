import { ZodError } from 'zod'

/** Thrown when an edit was based on an older revision than what is stored. */
export class ConflictError extends Error {
  constructor(what: string) {
    super(`This ${what} was changed since you opened it. Reload and try again.`)
    this.name = 'ConflictError'
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what[0]!.toUpperCase()}${what.slice(1)} not found.`)
    this.name = 'NotFoundError'
  }
}

/** Applies an optimistic-concurrency UPDATE and turns "0 rows changed" into the right error. */
export function assertUpdated(changes: number, exists: boolean, what: string): void {
  if (changes > 0) return
  throw exists ? new ConflictError(what) : new NotFoundError(what)
}

/** A message that is safe to show the user: validation issues or the error's own message, never inputs. */
export function friendlyError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ')
  }
  if (err instanceof Error) return err.message
  return 'Unexpected error'
}
