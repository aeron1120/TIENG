import type { PresentationAction, PresentationCommand } from '../../../../../packages/demo/presentation.ts';

export type OutboxSnapshot = { sequence: number; queue: PresentationCommand[] };

function validAction(value: unknown): value is PresentationAction {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  const keys = (...allowed: string[]) => Object.keys(a).every((key) => key === 'type' || allowed.includes(key));
  const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;
  switch (a.type) {
    case 'play': return keys('driver') && text(a.driver, 128);
    case 'tick': return keys('dt') && typeof a.dt === 'number' && a.dt > 0 && a.dt <= 0.5;
    case 'reset': return keys('scenario', 'baseWall') && Number.isSafeInteger(a.baseWall) && (a.baseWall as number) >= 0 && (a.baseWall as number) <= 8640000000000000 - 86400000 && (a.scenario === undefined || ['full', 'normal', 'curb', 'stopped', 'gap'].includes(a.scenario as string));
    case 'autopilot':
    case 'slowmo': return keys('on') && typeof a.on === 'boolean';
    case 'sensor': return keys('lost') && typeof a.lost === 'boolean';
    case 'respond': return keys('response') && (a.response === 'ok' || a.response === 'help');
    case 'reassign': return keys('orderId', 'riderId') && text(a.orderId, 64) && text(a.riderId, 64);
    case 'pause':
    case 'skipWait':
    case 'ack':
    case 'call':
    case 'resolve': return keys();
    default: return false;
  }
}

/** Commands stay byte-for-byte stable until acknowledged, including after a lost response. */
export class PresentationOutbox {
  private sequence = 0;
  private queue: PresentationCommand[] = [];

  constructor(snapshot?: unknown) {
    if (snapshot === undefined) return;
    const saved = snapshot as OutboxSnapshot | null;
    if (!saved || !Number.isSafeInteger(saved.sequence) || saved.sequence < 0 || !Array.isArray(saved.queue)
      || saved.queue.length > 20000 || saved.queue.some((command, index) => !command || command.seq !== saved.sequence - saved.queue.length + index + 1 || command.seq < 1 || !validAction(command.action))) {
      throw new Error('Invalid outbox snapshot');
    }
    this.sequence = saved.sequence;
    this.queue = JSON.parse(JSON.stringify(saved.queue)) as PresentationCommand[];
  }

  get pending() { return this.queue.length; }

  push(action: PresentationAction): PresentationCommand {
    const command = { seq: ++this.sequence, action: { ...action } };
    this.queue.push(command);
    return command;
  }

  batch(): PresentationCommand[] { return this.queue.slice(0, 100); }

  snapshot(): OutboxSnapshot { return { sequence: this.sequence, queue: JSON.parse(JSON.stringify(this.queue)) as PresentationCommand[] }; }

  /** A read can be ahead after a received response was lost or another controller advanced. */
  reconcile(sequence: number) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid acknowledgement sequence');
    this.sequence = Math.max(this.sequence, sequence);
    this.acknowledge(sequence);
  }

  acknowledge(sequence: number) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.sequence) throw new Error('Invalid acknowledgement sequence');
    this.queue = this.queue.filter((c) => c.seq > sequence);
  }
}
