import type { PresentationAction, PresentationCommand } from '../../../../../packages/demo/presentation.ts';

/** Commands stay byte-for-byte stable until acknowledged, including after a lost response. */
export class PresentationOutbox {
  private sequence = 0;
  private queue: PresentationCommand[] = [];

  get pending() { return this.queue.length; }

  push(action: PresentationAction): PresentationCommand {
    const command = { seq: ++this.sequence, action };
    this.queue.push(command);
    return command;
  }

  batch(): PresentationCommand[] { return this.queue.slice(0, 100); }

  acknowledge(sequence: number) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.sequence) throw new Error('Invalid acknowledgement sequence');
    this.queue = this.queue.filter((c) => c.seq > sequence);
  }
}
