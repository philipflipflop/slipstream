/**
 * Fully procedural WebAudio soundscape — no audio files.
 *   prop  : sawtooth firing tone + sub harmonic through a lowpass
 *   jet   : shaped noise with a rising bandpass + thin whine
 *   wind  : filtered noise that swells with airspeed
 * plus stall beeper, gear thunk, touchdown, crash, ring chime, UI ticks.
 */
import { clamp } from '../core/math';
import type { EngineKind } from '../aircraft/types';

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;

  private engineGain!: GainNode;
  private oscA!: OscillatorNode;
  private oscB!: OscillatorNode;
  private engineFilter!: BiquadFilterNode;
  private jetNoiseGain!: GainNode;
  private jetFilter!: BiquadFilterNode;
  private whine!: OscillatorNode;
  private whineGain!: GainNode;

  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;

  private stallOsc!: OscillatorNode;
  private stallGain!: GainNode;

  private noiseBuf!: AudioBuffer;
  private kind: EngineKind = 'prop';
  private mediaKick: HTMLAudioElement | null = null;

  muted = false;

  /**
   * iOS routes WebAudio through the *ringer* channel by default, so the
   * mute switch silences the sim even with the media volume up. Declaring
   * an audio session type (Safari 16.4+) moves us onto the media channel.
   * 'transient' is the type that MIXES with background audio (the spec's
   * "plays on top of playback audio") — 'playback' behaved like a video
   * app and stopped the user's music. If 'transient' isn't accepted, fall
   * back to 'playback' (mute switch beats music). Older WebKit keeps the
   * silent looping <audio> keepalive — note that element is itself media
   * playback and pauses music, which is why it's skipped when the modern
   * API exists.
   */
  private claimMediaRoute(): void {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) {
      try {
        nav.audioSession.type = 'transient';
        if (nav.audioSession.type !== 'transient') nav.audioSession.type = 'playback';
      } catch {
        try { nav.audioSession.type = 'playback'; } catch { /* leave default */ }
      }
      return;
    }
    if (!this.mediaKick) {
      const a = document.createElement('audio');
      a.loop = true;
      a.src = silentWavUrl();
      this.mediaKick = a;
    }
    void this.mediaKick.play().catch(() => {});
  }

  /** Must be called from a user gesture. */
  init(): void {
    this.claimMediaRoute();
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.master.connect(ctx.destination);

    // shared noise source material
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // --- engine: oscillators (prop voice) ---
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.master);

    this.oscA = ctx.createOscillator();
    this.oscA.type = 'sawtooth';
    this.oscA.frequency.value = 55;
    this.oscB = ctx.createOscillator();
    this.oscB.type = 'square';
    this.oscB.frequency.value = 27.5;
    const bGain = ctx.createGain();
    bGain.gain.value = 0.5;
    this.oscA.connect(this.engineFilter);
    this.oscB.connect(bGain).connect(this.engineFilter);
    this.oscA.start();
    this.oscB.start();

    // --- jet voice: noise through swept bandpass ---
    const jetSrc = ctx.createBufferSource();
    jetSrc.buffer = this.noiseBuf;
    jetSrc.loop = true;
    this.jetFilter = ctx.createBiquadFilter();
    this.jetFilter.type = 'bandpass';
    this.jetFilter.frequency.value = 320;
    this.jetFilter.Q.value = 0.8;
    this.jetNoiseGain = ctx.createGain();
    this.jetNoiseGain.gain.value = 0;
    jetSrc.connect(this.jetFilter).connect(this.jetNoiseGain).connect(this.master);
    jetSrc.start();

    this.whine = ctx.createOscillator();
    this.whine.type = 'triangle';
    this.whine.frequency.value = 2400;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain).connect(this.master);
    this.whine.start();

    // --- wind ---
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this.noiseBuf;
    windSrc.loop = true;
    windSrc.playbackRate.value = 0.6;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 400;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(this.windFilter).connect(this.windGain).connect(this.master);
    windSrc.start();

    // --- stall beeper ---
    this.stallOsc = ctx.createOscillator();
    this.stallOsc.type = 'square';
    this.stallOsc.frequency.value = 880;
    this.stallGain = ctx.createGain();
    this.stallGain.gain.value = 0;
    this.stallOsc.connect(this.stallGain).connect(this.master);
    this.stallOsc.start();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.value = m ? 0 : 0.7;
  }

  setEngineKind(kind: EngineKind): void {
    this.kind = kind;
  }

  /** Per-frame state drive. `nr` = rotor RPM and `horn` = low-rotor-RPM
   *  warning (helicopter only; planes leave the defaults). */
  update(
    throttle: number, thrustFrac: number, airspeed: number, stalled: boolean,
    time: number, nr = 1, horn = false,
  ): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;

    if (this.kind === 'prop') {
      const rpm = 0.14 + throttle * 0.86;
      const f = 38 + rpm * 92;
      this.oscA.frequency.setTargetAtTime(f + Math.sin(time * 13) * 1.6, t, 0.05);
      this.oscB.frequency.setTargetAtTime(f * 0.5, t, 0.05);
      this.engineFilter.frequency.setTargetAtTime(380 + rpm * 1500, t, 0.08);
      this.engineGain.gain.setTargetAtTime(0.07 + rpm * 0.17, t, 0.08);
      this.jetNoiseGain.gain.setTargetAtTime(0.012 + rpm * 0.025, t, 0.1); // a little engine wash
      this.jetFilter.frequency.setTargetAtTime(500, t, 0.1);
      this.whineGain.gain.setTargetAtTime(0, t, 0.1);
    } else if (this.kind === 'heli') {
      // blade chop rides the rotor (pitch AND volume sag as NR droops);
      // turbine hiss + gearbox whine ride engine torque and die on a cut
      const rotor = Math.max(nr, 0);
      const bite = (0.3 + throttle * 0.7) * Math.min(rotor * 1.1, 1);
      const f = (24 + bite * 5) * Math.max(rotor, 0.3);
      this.oscA.frequency.setTargetAtTime(f + Math.sin(time * 8.5) * 0.8, t, 0.05);
      this.oscB.frequency.setTargetAtTime(f * 1.5, t, 0.05);
      this.engineFilter.frequency.setTargetAtTime(240 + bite * 460, t, 0.1);
      this.engineGain.gain.setTargetAtTime((0.1 + bite * 0.15) * Math.min(rotor * 1.3, 1), t, 0.1);
      this.jetFilter.frequency.setTargetAtTime(950, t, 0.2);
      this.jetNoiseGain.gain.setTargetAtTime(0.02 + thrustFrac * 0.065, t, 0.15);
      this.whine.frequency.setTargetAtTime(2800 + thrustFrac * 500, t, 0.2);
      this.whineGain.gain.setTargetAtTime(0.002 + thrustFrac * 0.005, t, 0.2);
    } else {
      const spool = 0.12 + thrustFrac * 0.88;
      this.engineGain.gain.setTargetAtTime(0.0, t, 0.1);
      this.jetFilter.frequency.setTargetAtTime(220 + spool * 1400, t, 0.18);
      this.jetNoiseGain.gain.setTargetAtTime(0.05 + spool * 0.3, t, 0.15);
      this.whine.frequency.setTargetAtTime(1500 + spool * 2600, t, 0.15);
      this.whineGain.gain.setTargetAtTime(0.004 + spool * 0.012, t, 0.15);
    }

    const w = clamp(airspeed / 180, 0, 1.4);
    this.windGain.gain.setTargetAtTime(w * w * 0.34, t, 0.12);
    this.windFilter.frequency.setTargetAtTime(250 + w * 2400, t, 0.15);

    if (horn) {
      // low-rotor-RPM horn: steady low blare, unmistakably not the stall beeper
      this.stallOsc.frequency.setTargetAtTime(410, t, 0.02);
      this.stallGain.gain.setTargetAtTime(0.07, t, 0.03);
    } else {
      this.stallOsc.frequency.setTargetAtTime(880, t, 0.02);
      const beep = stalled ? (Math.sin(time * 22) > 0 ? 0.06 : 0) : 0;
      this.stallGain.gain.setTargetAtTime(beep, t, 0.015);
    }
  }

  private blip(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', sweep = 0): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (sweep !== 0) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private thumpNoise(dur: number, vol: number, cutoff: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  uiClick(): void { this.blip(1800, 0.06, 0.05, 'triangle', -600); }
  gearThunk(): void { this.thumpNoise(0.28, 0.3, 320); this.blip(140, 0.2, 0.12, 'sine', -60); }
  touchdown(): void { this.thumpNoise(0.4, 0.42, 240); }
  ringChime(): void { this.blip(1244, 0.5, 0.14, 'sine', 240); this.blip(932, 0.4, 0.1, 'sine', 0); }
  finishFanfare(): void {
    this.blip(784, 0.4, 0.12); this.blip(988, 0.5, 0.12);
    setTimeout(() => this.blip(1318, 0.8, 0.16), 160);
  }
  crashBoom(): void {
    this.thumpNoise(1.6, 0.8, 130);
    this.blip(60, 1.2, 0.4, 'sawtooth', -30);
  }
}

/** One second of 8 kHz mono silence as a blob URL (media-route keepalive). */
function silentWavUrl(): string {
  const n = 8000;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
