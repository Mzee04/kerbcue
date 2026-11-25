/** How long the "Tap again to confirm delivered" prompt waits for the second tap. */
export const deliveryConfirmMs = 4000

export interface PendingConfirm {
  jobId: string
  until: number
}

/**
 * Delivered needs two taps on the same job within a few seconds, so a stray
 * temple or ring tap can't close a delivery. Returns whether to send the update
 * and the prompt state to keep.
 */
export function deliveryTap(pending: PendingConfirm | undefined, jobId: string, now: number) {
  if (pending && pending.jobId === jobId && pending.until > now) {
    return { send: true, pending: undefined }
  }
  return { send: false, pending: { jobId, until: now + deliveryConfirmMs } }
}

export function isConfirming(pending: PendingConfirm | undefined, jobId: string, now: number): boolean {
  return !!pending && pending.jobId === jobId && pending.until > now
}
