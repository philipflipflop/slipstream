/**
 * Mobile touch deck: left virtual stick (roll/pitch), right throttle
 * slider, rudder pedals, and action buttons. Pointer-event based so it
 * also works with pen/touch on hybrid laptops.
 */
import { InputManager } from './input';
import { clamp } from '../core/math';

export const isTouchDevice = (): boolean =>
  window.matchMedia('(pointer: coarse)').matches ||
  'ontouchstart' in window ||
  new URLSearchParams(location.search).has('touch'); // dev: force touch UI

export class TouchControls {
  root: HTMLDivElement;
  private input: InputManager;
  private stickZone!: HTMLDivElement;
  private nub!: HTMLDivElement;
  private throttleZone!: HTMLDivElement;
  private throttleFill!: HTMLDivElement;
  private throttleGrip!: HTMLDivElement;
  private gearBtn!: HTMLButtonElement;
  private flapBtn!: HTMLButtonElement;
  private apBtn!: HTMLButtonElement;
  private sbBtn!: HTMLButtonElement;
  private stickPointer: number | null = null;
  private throttlePointer: number | null = null;
  private throttleValue = 0;

  onCamera: () => void = () => {};
  onPause: () => void = () => {};
  onAutopilot: () => void = () => {};
  onAirbrake: () => void = () => {};
  onNav: () => void = () => {};

  constructor(input: InputManager) {
    this.input = input;
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.buildStick();
    this.buildThrottle();
    this.buildButtons();
    document.body.appendChild(this.root);
  }

  show(on: boolean): void {
    this.root.classList.toggle('show', on);
  }

  /** Sync annunciator-style button states from the sim. */
  syncState(
    gearDown: boolean,
    flaps: number,
    retractable: boolean,
    apOn = false,
    airbrakeOn = false,
    hasAirbrake = false,
  ): void {
    this.gearBtn.style.display = retractable ? 'grid' : 'none';
    this.gearBtn.classList.toggle('lit', gearDown);
    this.flapBtn.textContent = flaps > 0 ? `FLAP ${Math.round(flaps * 3)}` : 'FLAP';
    this.flapBtn.classList.toggle('lit', flaps > 0);
    this.apBtn.classList.toggle('lit', apOn);
    this.sbBtn.style.display = hasAirbrake ? 'grid' : 'none';
    this.sbBtn.classList.toggle('lit', airbrakeOn);
  }

  setThrottle(v: number): void {
    this.throttleValue = clamp(v, 0, 1);
    this.renderThrottle();
  }

  private buildStick(): void {
    this.stickZone = document.createElement('div');
    this.stickZone.className = 'stick-zone';
    this.stickZone.innerHTML = `<div class="stick-base"></div>`;
    this.nub = document.createElement('div');
    this.nub.className = 'stick-nub';
    this.stickZone.appendChild(this.nub);
    this.root.appendChild(this.stickZone);

    const zone = this.stickZone;
    const move = (e: PointerEvent): void => {
      const r = zone.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      let x = (e.clientX - cx) / (r.width * 0.42);
      let y = (e.clientY - cy) / (r.height * 0.42);
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      this.input.setTouchAxes(x, y);
      this.nub.style.transform = `translate(${x * r.width * 0.3}px, ${y * r.height * 0.3}px)`;
    };
    zone.addEventListener('pointerdown', (e) => {
      this.stickPointer = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      move(e);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickPointer) move(e);
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickPointer = null;
      this.input.clearTouchAxes();
      this.nub.style.transform = 'translate(0,0)';
    };
    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);
  }

  private buildThrottle(): void {
    this.throttleZone = document.createElement('div');
    this.throttleZone.className = 'throttle-zone';
    this.throttleFill = document.createElement('div');
    this.throttleFill.className = 'throttle-fill';
    this.throttleGrip = document.createElement('div');
    this.throttleGrip.className = 'throttle-grip';
    this.throttleZone.append(this.throttleFill, this.throttleGrip);
    this.root.appendChild(this.throttleZone);

    const zone = this.throttleZone;
    const move = (e: PointerEvent): void => {
      const r = zone.getBoundingClientRect();
      const v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      this.throttleValue = v;
      this.input.setTouchThrottle(v);
      this.renderThrottle();
    };
    zone.addEventListener('pointerdown', (e) => {
      this.throttlePointer = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      move(e);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.throttlePointer) move(e);
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId === this.throttlePointer) this.throttlePointer = null;
      // throttle stays where you left it (real levers do)
    };
    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);
    this.renderThrottle();
  }

  private renderThrottle(): void {
    const pct = this.throttleValue * 100;
    this.throttleFill.style.height = `${pct}%`;
    this.throttleGrip.style.bottom = `calc(${pct}% - ${this.throttleValue * 26}px)`;
  }

  private buildButtons(): void {
    const mk = (label: string, style: Partial<CSSStyleDeclaration>): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = 'tbtn';
      b.textContent = label;
      Object.assign(b.style, style);
      this.root.appendChild(b);
      return b;
    };

    const safeT = 'calc(12px + env(safe-area-inset-top, 0px))';
    this.gearBtn = mk('GEAR', { top: safeT, left: 'calc(12px + env(safe-area-inset-left, 0px))' });
    this.gearBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.input.toggleGear(); });

    this.flapBtn = mk('FLAP', { top: safeT, left: 'calc(82px + env(safe-area-inset-left, 0px))' });
    this.flapBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.input.pingPongFlaps(); // 0-1-2-3-2-1-0, no reset jump
    });

    const cam = mk('CAM', { top: safeT, left: 'calc(152px + env(safe-area-inset-left, 0px))' });
    cam.addEventListener('pointerdown', (e) => { e.preventDefault(); this.onCamera(); });

    this.apBtn = mk('AP', { top: safeT, left: 'calc(222px + env(safe-area-inset-left, 0px))' });
    this.apBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.onAutopilot(); });

    this.sbBtn = mk('SPBRK', { top: safeT, left: 'calc(292px + env(safe-area-inset-left, 0px))' });
    this.sbBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.onAirbrake(); });

    const nav = mk('NAV', { top: safeT, left: 'calc(362px + env(safe-area-inset-left, 0px))' });
    nav.addEventListener('pointerdown', (e) => { e.preventDefault(); this.onNav(); });

    // brake — hold, sits above the throttle
    const brk = mk('BRAKE', {
      bottom: 'calc(24px + env(safe-area-inset-bottom, 0px) + min(46vh, 250px) + 10px)',
      right: 'calc(14px + env(safe-area-inset-right, 0px))',
    });
    brk.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      brk.classList.add('held');
      this.input.setTouchBrakes(true);
    });
    const brkUp = (): void => {
      brk.classList.remove('held');
      this.input.setTouchBrakes(false);
    };
    brk.addEventListener('pointerup', brkUp);
    brk.addEventListener('pointercancel', brkUp);

    // rudder pedals
    const pedals = document.createElement('div');
    pedals.className = 'rudder-zone';
    this.root.appendChild(pedals);
    for (const dir of [-1, 1]) {
      const p = document.createElement('button');
      p.className = 'tbtn';
      p.textContent = dir < 0 ? '⟸ RUD' : 'RUD ⟹';
      pedals.appendChild(p);
      p.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        p.classList.add('held');
        this.input.setTouchYaw(dir);
      });
      const up = (): void => {
        p.classList.remove('held');
        this.input.setTouchYaw(0);
      };
      p.addEventListener('pointerup', up);
      p.addEventListener('pointercancel', up);
    }
  }
}
