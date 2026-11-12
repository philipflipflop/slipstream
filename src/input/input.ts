/**
 * Unified pilot input. Keyboard keys ramp like an analog axis so the
 * controls feel like a yoke, not a light switch. Touch (mobile) writes
 * directly into the same structure via setTouchAxes/setTouchThrottle, and
 * a connected gamepad is polled each frame (mapping in gamepad.ts).
 */
import type { ControlInputs } from '../aircraft/flightModel';
import { clamp } from '../core/math';
import { readPad, PadFrame } from './gamepad';

type SimEvent =
  | 'camera' | 'pause' | 'gear' | 'flaps' | 'map' | 'reset'
  | 'autopilot' | 'airbrake' | 'hud' | 'enginecut' | 'ils' | 'approach'
  | 'nav' | 'navzoomin' | 'navzoomout';

export class InputManager {
  readonly controls: ControlInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0,
    gearDown: true, brakes: false, airbrake: false, engineCut: false,
  };

  invertY = false;
  sensitivity = 1;

  private keys = new Set<string>();
  private listeners = new Map<SimEvent, Array<() => void>>();
  private touchAxes: { x: number; y: number } | null = null;
  private touchYaw = 0;
  private touchBrakes = false;
  private touchThrottle: number | null = null;
  private flapsStep = 0; // 0..3
  private flapsDir = 1;  // single-button (touch) cycle direction
  private padPrev: boolean[] = [];
  private padStick = false;
  /** id of the pad last seen — set once so main can announce it */
  padName: string | null = null;
  onPadConnected: (name: string) => void = () => {};

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.code;
      this.keys.add(k);
      switch (k) {
        case 'KeyG': this.toggleGear(); break;
        case 'KeyF': this.cycleFlaps(1); break;
        case 'KeyV': this.cycleFlaps(-1); break;
        case 'KeyC': this.emit('camera'); break;
        case 'KeyR': this.emit('reset'); break;
        case 'KeyT': this.emit('autopilot'); break;
        case 'KeyB': this.emit('airbrake'); break;
        case 'KeyX': this.emit('enginecut'); break;
        case 'KeyI': this.emit('ils'); break;
        case 'KeyL': this.emit('approach'); break;
        case 'KeyH': this.emit('hud'); break;
        case 'KeyM': this.emit('map'); break;
        case 'KeyN': this.emit('nav'); break;
        case 'Comma': this.emit('navzoomout'); break;
        case 'Period': this.emit('navzoomin'); break;
        case 'Escape': case 'KeyP': this.emit('pause'); break;
        case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5':
        case 'Digit6': case 'Digit7': case 'Digit8': case 'Digit9':
          this.controls.throttle = (Number(k.slice(5)) ) / 9; break;
        case 'Digit0': this.controls.throttle = 0; break;
        case 'Space': e.preventDefault(); break;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  on(ev: SimEvent, fn: () => void): void {
    const arr = this.listeners.get(ev) ?? [];
    arr.push(fn);
    this.listeners.set(ev, arr);
  }

  private emit(ev: SimEvent): void {
    for (const fn of this.listeners.get(ev) ?? []) fn();
  }

  toggleGear(): void {
    this.controls.gearDown = !this.controls.gearDown;
    this.emit('gear');
  }

  cycleFlaps(dir: number): void {
    this.flapsStep = clamp(this.flapsStep + dir, 0, 3);
    this.controls.flaps = this.flapsStep / 3;
    this.emit('flaps');
  }

  /** One-button flap cycle: 0-1-2-3-2-1-0 so a single stop can be taken
   *  back out without resetting and re-cycling through the whole range. */
  pingPongFlaps(): void {
    if (this.flapsStep >= 3) this.flapsDir = -1;
    else if (this.flapsStep <= 0) this.flapsDir = 1;
    this.cycleFlaps(this.flapsDir);
  }

  /** Preset the flap lever (0..3) — e.g. when a flight starts on final. */
  setFlapsStep(step: number): void {
    this.flapsStep = clamp(Math.round(step), 0, 3);
    this.flapsDir = this.flapsStep >= 3 ? -1 : 1;
    this.controls.flaps = this.flapsStep / 3;
  }

  /** Aircraft without flaps (helicopter): snap any cycled state back to 0. */
  resetFlaps(): void {
    this.flapsStep = 0;
    this.flapsDir = 1;
    this.controls.flaps = 0;
  }

  setTouchAxes(x: number, y: number): void { this.touchAxes = { x, y }; }
  clearTouchAxes(): void { this.touchAxes = null; }
  setTouchYaw(v: number): void { this.touchYaw = v; }
  setTouchThrottle(v: number | null): void { this.touchThrottle = v; }
  setTouchBrakes(b: boolean): void { this.touchBrakes = b; }

  /** First connected gamepad's state this frame (null without one). */
  private pollPad(): PadFrame | null {
    const getPads = (navigator as Navigator & { getGamepads?: () => (Gamepad | null)[] }).getGamepads;
    if (!getPads) return null;
    let pads: (Gamepad | null)[];
    try {
      pads = getPads.call(navigator);
    } catch {
      return null; // blocked by permissions policy (embedded frames)
    }
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (this.padName !== p.id) {
        this.padName = p.id;
        this.padPrev.length = 0;
        this.onPadConnected(p.id);
      }
      return readPad(p.axes, p.buttons, p.mapping === 'standard', this.padPrev);
    }
    this.padName = null;
    return null;
  }

  /** Ramp axes toward targets; call once per frame. */
  update(dt: number): void {
    const c = this.controls;
    const k = this.keys;
    const pad = this.pollPad();
    this.padStick = !!pad && pad.stick;
    if (pad) {
      for (const a of pad.actions) {
        if (a === 'gear') this.toggleGear();
        else if (a === 'flapsDown') this.cycleFlaps(1);
        else if (a === 'flapsUp') this.cycleFlaps(-1);
        else this.emit(a);
      }
    }

    const axis = (cur: number, target: number): number => {
      const rate = target !== 0 ? 4.2 : 5.5;
      const d = target - cur;
      const maxStep = rate * dt;
      return cur + clamp(d, -maxStep, maxStep);
    };

    let pT = (k.has('KeyW') || k.has('ArrowUp') ? -1 : 0) + (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let rT = (k.has('KeyA') || k.has('ArrowLeft') ? -1 : 0) + (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0);
    const yT = (k.has('KeyQ') ? -1 : 0) + (k.has('KeyE') ? 1 : 0) + this.touchYaw + (pad ? pad.yaw : 0);

    if (this.touchAxes) {
      rT = this.touchAxes.x;
      pT = this.touchAxes.y;
    } else if (pad && pad.stick) {
      rT = pad.roll;
      pT = pad.pitch;
    }
    if (this.invertY) pT = -pT;
    pT *= this.sensitivity;
    rT *= this.sensitivity;

    c.pitch = axis(c.pitch, clamp(pT, -1, 1));
    c.roll = axis(c.roll, clamp(rT, -1, 1));
    c.yaw = axis(c.yaw, clamp(yT, -1, 1));

    // throttle
    if (this.touchThrottle !== null) {
      c.throttle = this.touchThrottle;
    } else {
      if (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('Equal')) c.throttle += 0.45 * dt;
      if (k.has('ControlLeft') || k.has('ControlRight') || k.has('Minus')) c.throttle -= 0.45 * dt;
      if (pad) c.throttle += pad.throttleRate * 0.6 * dt;
      c.throttle = clamp(c.throttle, 0, 1);
    }

    c.brakes = k.has('Space') || this.touchBrakes || (!!pad && pad.brakes);
  }

  /** True when the pilot is actively deflecting pitch/roll (used to kick off the autopilot). */
  hasManualStick(): boolean {
    const k = this.keys;
    return (
      this.touchAxes !== null || this.padStick ||
      k.has('KeyW') || k.has('KeyS') || k.has('KeyA') || k.has('KeyD') ||
      k.has('ArrowUp') || k.has('ArrowDown') || k.has('ArrowLeft') || k.has('ArrowRight')
    );
  }

  toggleAirbrake(): boolean {
    this.controls.airbrake = !this.controls.airbrake;
    return this.controls.airbrake;
  }

  /** Wipe transient state when (re)starting a flight. */
  resetForFlight(): void {
    this.controls.pitch = 0;
    this.controls.roll = 0;
    this.controls.yaw = 0;
    this.controls.throttle = 0;
    this.controls.flaps = 0;
    this.controls.gearDown = true;
    this.controls.brakes = false;
    this.controls.airbrake = false;
    this.controls.engineCut = false;
    this.flapsStep = 0;
    this.flapsDir = 1;
    this.touchYaw = 0;
    this.touchAxes = null;
    this.touchThrottle = null;
    this.touchBrakes = false;
  }
}
