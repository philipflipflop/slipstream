/**
 * Unified pilot input. Keyboard keys ramp like an analog axis so the
 * controls feel like a yoke, not a light switch. Touch (mobile) writes
 * directly into the same structure via setTouchAxes/setTouchThrottle.
 */
import type { ControlInputs } from '../aircraft/flightModel';
import { clamp } from '../core/math';

type SimEvent =
  | 'camera' | 'pause' | 'gear' | 'flaps' | 'map' | 'reset'
  | 'autopilot' | 'airbrake' | 'hud';

export class InputManager {
  readonly controls: ControlInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0,
    gearDown: true, brakes: false, airbrake: false,
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
        case 'KeyH': this.emit('hud'); break;
        case 'KeyM': this.emit('map'); break;
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

  setTouchAxes(x: number, y: number): void { this.touchAxes = { x, y }; }
  clearTouchAxes(): void { this.touchAxes = null; }
  setTouchYaw(v: number): void { this.touchYaw = v; }
  setTouchThrottle(v: number | null): void { this.touchThrottle = v; }
  setTouchBrakes(b: boolean): void { this.touchBrakes = b; }

  /** Ramp axes toward targets; call once per frame. */
  update(dt: number): void {
    const c = this.controls;
    const k = this.keys;

    const axis = (cur: number, target: number): number => {
      const rate = target !== 0 ? 4.2 : 5.5;
      const d = target - cur;
      const maxStep = rate * dt;
      return cur + clamp(d, -maxStep, maxStep);
    };

    let pT = (k.has('KeyW') || k.has('ArrowUp') ? -1 : 0) + (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let rT = (k.has('KeyA') || k.has('ArrowLeft') ? -1 : 0) + (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0);
    const yT = (k.has('KeyQ') ? -1 : 0) + (k.has('KeyE') ? 1 : 0) + this.touchYaw;

    if (this.touchAxes) {
      rT = this.touchAxes.x;
      pT = this.touchAxes.y;
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
      c.throttle = clamp(c.throttle, 0, 1);
    }

    c.brakes = k.has('Space') || this.touchBrakes;
  }

  /** True when the pilot is actively deflecting pitch/roll (used to kick off the autopilot). */
  hasManualStick(): boolean {
    const k = this.keys;
    return (
      this.touchAxes !== null ||
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
    this.flapsStep = 0;
    this.touchYaw = 0;
    this.touchAxes = null;
    this.touchThrottle = null;
    this.touchBrakes = false;
  }
}
