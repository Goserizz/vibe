/**
 * Completion notification sounds, synthesized with the Web Audio API so we
 * don't ship binary assets. Preference is stored in localStorage.
 */

export type NotifySoundId = 'none' | 'chime' | 'ping' | 'bell' | 'pop' | 'success';

export interface NotifySoundOption {
  id: NotifySoundId;
  label: string;
  hint: string;
}

export const NOTIFY_SOUNDS: NotifySoundOption[] = [
  { id: 'none', label: 'Off', hint: 'No sound when a turn finishes' },
  { id: 'chime', label: 'Chime', hint: 'Two soft ascending notes' },
  { id: 'ping', label: 'Ping', hint: 'Single clean tone' },
  { id: 'bell', label: 'Bell', hint: 'Gentle bell with harmonics' },
  { id: 'pop', label: 'Pop', hint: 'Short soft click' },
  { id: 'success', label: 'Success', hint: 'Major triad arpeggio' },
];

const STORAGE_KEY = 'vibe.notifySound';
const DEFAULT_SOUND: NotifySoundId = 'chime';

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  return audioCtx;
}

export function loadNotifySound(): NotifySoundId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && NOTIFY_SOUNDS.some((s) => s.id === raw)) return raw as NotifySoundId;
  } catch {
    /* ignore */
  }
  return DEFAULT_SOUND;
}

export function saveNotifySound(id: NotifySoundId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

function tone(
  ctx: AudioContext,
  freq: number,
  start: number,
  duration: number,
  opts: { type?: OscillatorType; gain?: number; attack?: number; release?: number } = {},
): void {
  const { type = 'sine', gain = 0.18, attack = 0.01, release = 0.12 } = opts;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration + release);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + release + 0.02);
}

function playChime(ctx: AudioContext): void {
  const t = ctx.currentTime;
  tone(ctx, 660, t, 0.12, { gain: 0.16 });
  tone(ctx, 880, t + 0.14, 0.22, { gain: 0.14 });
}

function playPing(ctx: AudioContext): void {
  const t = ctx.currentTime;
  tone(ctx, 920, t, 0.18, { gain: 0.15, release: 0.2 });
}

function playBell(ctx: AudioContext): void {
  const t = ctx.currentTime;
  tone(ctx, 523.25, t, 0.35, { gain: 0.12, release: 0.45 });
  tone(ctx, 659.25, t, 0.35, { gain: 0.08, release: 0.4 });
  tone(ctx, 783.99, t, 0.28, { gain: 0.05, release: 0.35 });
}

function playPop(ctx: AudioContext): void {
  const t = ctx.currentTime;
  tone(ctx, 420, t, 0.04, { type: 'triangle', gain: 0.14, attack: 0.005, release: 0.06 });
  tone(ctx, 180, t + 0.02, 0.05, { type: 'sine', gain: 0.08, attack: 0.005, release: 0.08 });
}

function playSuccess(ctx: AudioContext): void {
  const t = ctx.currentTime;
  tone(ctx, 523.25, t, 0.1, { gain: 0.12 });
  tone(ctx, 659.25, t + 0.1, 0.1, { gain: 0.12 });
  tone(ctx, 783.99, t + 0.2, 0.28, { gain: 0.14, release: 0.25 });
}

/** Play the chosen completion sound. Safe to call from any context; no-ops if Off or Audio unavailable. */
export function playNotifySound(id: NotifySoundId = loadNotifySound()): void {
  if (id === 'none') return;
  const ctx = getCtx();
  if (!ctx) return;

  const run = () => {
    switch (id) {
      case 'chime':
        playChime(ctx);
        break;
      case 'ping':
        playPing(ctx);
        break;
      case 'bell':
        playBell(ctx);
        break;
      case 'pop':
        playPop(ctx);
        break;
      case 'success':
        playSuccess(ctx);
        break;
    }
  };

  // Browsers may suspend AudioContext until a user gesture; resume then play.
  if (ctx.state === 'suspended') {
    void ctx.resume().then(run).catch(() => {
      /* autoplay blocked — ignore */
    });
  } else {
    run();
  }
}
