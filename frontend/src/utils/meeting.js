// Meeting assistant (2.8, option 13): the parts of a live recording, the clock, the level meter and the order in
// which parts reach the engine. No React here, so it is tested with node --test (tests/meeting.test.mjs).

export const PART_MS = 15000; // a part every 15 s: a crash loses at most that, never more than a minute

/** 750 -> "00:12:30" */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** "[00:12:30]", the source of a task or decision in the meeting */
export function sourceLabel(time) {
  return time ? `[${time}]` : '';
}

/** The loudness of a block of samples from an AnalyserNode (getByteTimeDomainData: 128 is silence), 0..1. */
export function levelOf(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  // speech is around 0.05..0.3 RMS: a square root scale makes it fill the meter
  return Math.min(1, Math.sqrt(rms * 3));
}

/** The best format the browser records in: Opus in WebM (Chrome, Electron), else Ogg, else MP4 (Safari). */
export function pickMime(isTypeSupported) {
  const choices = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const c of choices) {
    try {
      if (isTypeSupported(c)) return c;
    } catch (_) { /* not this one */ }
  }
  return '';
}

/** Whether the sound of this PC can be recorded as well: only in the desktop app on Windows (loopback). */
export function systemAudioAvailable(desktop) {
  return Boolean(desktop && desktop.meeting && desktop.meeting.systemAudio);
}

/**
 * Sends the parts of a recording to the engine one after the other, in order. A part that cannot be sent (the
 * engine is busy, a short network hiccup between the window and the engine) stays in the queue and is sent again;
 * nothing is dropped. send(index, blob) returns a promise that rejects on failure.
 */
export class PartQueue {
  constructor(send, { retryMs = 2000, maxTries = 30, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.send = send;
    this.retryMs = retryMs;
    this.maxTries = maxTries;
    this.wait = wait;
    this.next = 0;
    this.queue = [];
    this.sent = 0;
    this.failed = false;
    this.running = null;
  }

  push(blob) {
    if (!blob || !blob.size) return -1;
    const index = this.next;
    this.next += 1;
    this.queue.push({ index, blob });
    this.kick();
    return index;
  }

  get pending() {
    return this.queue.length;
  }

  kick() {
    if (!this.running) {
      this.running = this.run().finally(() => { this.running = null; });
      this.running.catch(() => { /* flush() reports it; the parts stay in the queue */ });
    }
    return this.running;
  }

  async run() {
    while (this.queue.length) {
      const part = this.queue[0];
      let tries = 0;
      for (;;) {
        try {
          await this.send(part.index, part.blob);
          break;
        } catch (e) {
          tries += 1;
          if (tries >= this.maxTries) {
            this.failed = true;
            throw e;
          }
          await this.wait(this.retryMs);
        }
      }
      this.queue.shift();
      this.sent += 1;
    }
  }

  /** Resolves when every part has been sent (rejects if one could not be sent at all). */
  async flush() {
    while (this.queue.length || this.running) {
      await this.kick();
    }
  }
}

/** The name of the meeting's document, in the user's language: "Meeting 2026-11-28 14.05" */
export function meetingTitle(word, when = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${word} ${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}.${pad(when.getMinutes())}`;
}
