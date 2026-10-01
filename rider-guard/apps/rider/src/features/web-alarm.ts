export type AlarmState = 'off' | 'preparing' | 'ready' | 'playing' | 'blocked' | 'unavailable';
type Repeater = { every: (fn: () => void) => unknown; cancel: (id: unknown) => void };

/** Browser-only audio; no claim of background, muted-device, or native alarm support. */
export class WebAlarm {
  private context: AudioContext | null = null;
  private state: AlarmState = 'off';
  private enabled = false;
  private generation = 0;
  private interval: unknown = null;
  private tones = new Set<{ oscillator: OscillatorNode; gain: GainNode }>();
  private listeners = new Set<() => void>();
  private create: () => AudioContext | null;
  private repeater: Repeater;

  constructor(create: () => AudioContext | null, repeater: Repeater = { every: fn => setInterval(fn, 2800), cancel: id => clearInterval(id as ReturnType<typeof setInterval>) }) {
    this.create = create;
    this.repeater = repeater;
  }

  getState = (): AlarmState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(state: AlarmState) {
    if (this.state === state) return;
    this.state = state;
    this.listeners.forEach(listener => listener());
  }

  /** Call directly from a user click so browsers can grant audio playback. */
  async prepare(testTone = true): Promise<boolean> {
    this.stop();
    const generation = ++this.generation;
    this.update('preparing');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.context || this.context.state === 'closed') this.context = this.create();
      const context = this.context;
      if (!context) { this.update('unavailable'); return false; }
      context.onstatechange = () => {
        if (context !== this.context || context.state === 'running' || !this.enabled) return;
        this.stop();
        this.update('blocked');
      };
      await Promise.race([
        context.resume(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Audio resume timed out')), 3000); }),
      ]);
      if (generation !== this.generation) return false;
      if (context.state !== 'running') throw new Error('Audio suspended');
      this.enabled = true;
      this.update('ready');
      if (testTone) this.beep();
      return true;
    } catch {
      if (generation === this.generation) { this.stop(); this.enabled = false; this.update('blocked'); }
      return false;
    } finally { if (timeout) clearTimeout(timeout); }
  }

  private beep() {
    const context = this.context;
    if (!context || context.state !== 'running') { this.stop(); this.update('blocked'); return; }
    for (let n = 0; n < 3; n++) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const tone = { oscillator, gain };
      this.tones.add(tone);
      oscillator.type = 'sine';
      oscillator.frequency.value = n === 1 ? 1046 : 880;
      const start = context.currentTime + n * 0.25;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
      gain.gain.linearRampToValueAtTime(0, start + 0.18);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.tones.delete(tone); };
      oscillator.start(start);
      oscillator.stop(start + 0.2);
    }
  }

  start(): boolean {
    if (!this.enabled) return false;
    if (this.state === 'playing') return true;
    if (this.context?.state !== 'running') { this.update('blocked'); return false; }
    try {
      this.beep();
      this.update('playing');
      this.interval = this.repeater.every(() => {
        try { this.beep(); } catch { this.stop(); this.update('blocked'); }
      });
      return true;
    } catch { this.stop(); this.update('blocked'); return false; }
  }

  stop = () => {
    ++this.generation;
    if (this.interval !== null) this.repeater.cancel(this.interval);
    this.interval = null;
    for (const { oscillator, gain } of this.tones) {
      oscillator.onended = null;
      try { oscillator.stop(); } catch { /* Already ended. */ }
      oscillator.disconnect(); gain.disconnect();
    }
    this.tones.clear();
    this.update(this.enabled && this.context?.state === 'running' ? 'ready' : 'off');
  };

  disable() { this.enabled = false; this.stop(); }
}

export const webAlarm = new WebAlarm(() => {
  if (typeof window === 'undefined') return null;
  const Audio = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Audio ? new Audio() : null;
});
