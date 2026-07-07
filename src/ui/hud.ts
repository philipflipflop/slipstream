/**
 * Phosphor-green glass cockpit drawn on a 2D canvas over the 3D view:
 * attitude ladder, speed/altitude tapes, heading ribbon, VSI, throttle,
 * annunciators, stall flash, and Ring Rush guidance.
 */
import { clamp, MS_TO_KT, M_TO_FT, RAD2DEG, formatTime, wrapAngle } from '../core/math';

export interface HudData {
  airspeed: number;   // m/s (true airspeed)
  groundspeed: number; // m/s over the ground
  altitude: number;   // m ASL
  radarAlt: number;   // m AGL
  heading: number;    // rad
  pitch: number;      // rad
  roll: number;       // rad
  vs: number;         // m/s vertical
  throttle: number;   // 0..1
  gForce: number;
  flaps: number;
  gearDown: boolean;
  retractable: boolean;
  brakes: boolean;
  airbrake: boolean;
  autopilot: boolean;
  stalled: boolean;
  afterburner: boolean;
  vne: number;        // m/s
  wind: null | { fromDeg: number; kt: number };
  heli: null | {
    trq: number;      // engine torque 0..1 (0 with the engine cut)
    nr: number;       // rotor RPM, 1 = 100%
    vrs: boolean;     // vortex ring state caution
    lowRpm: boolean;  // rotor droop warning
    engineOut: boolean;
  };
  gun: null | { ammo: number; firing: boolean; hits: number; targets: number };
  ils: null | {
    name: string;
    ident: string;    // approach designator, e.g. "27L"
    dme: number;      // m to threshold
    locDev: number;   // rad, + = right of centreline (fly left)
    gsDev: number;    // rad, + = above the glide path (fly down)
    locFull: number;  // full-scale deflections (rad)
    gsFull: number;
  };
  nav: null | {
    name: string;
    distance: number;  // m to active waypoint
    bearing: number;   // rad, relative to nose
    eteSec: number | null;
  };
  race: null | {
    gate: number;
    total: number;
    time: number;
    best: number | null;
    bearing: number;  // rad, relative bearing to next gate (0 = dead ahead)
    elev: number;     // rad, relative elevation angle
    distance: number; // m
  };
}

const PHOS = '125, 255, 168';
const AMBER = '255, 179, 64';
const RED = '255, 93, 93';

export class Hud {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private time = 0;
  visible = false;
  mode: 'full' | 'min' | 'off' = 'full';

  cycleMode(): 'full' | 'min' | 'off' {
    this.mode = this.mode === 'full' ? 'min' : this.mode === 'min' ? 'off' : 'full';
    return this.mode;
  }

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'hud';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(d: HudData, dt: number): void {
    this.time += dt;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.visible) return;

    const w = this.w;
    const h = this.h;
    const s = clamp(Math.min(w, h) / 760, 0.62, 1.25);
    const cx = w / 2;
    const cy = h / 2;
    const compact = w < 760;

    ctx.lineWidth = Math.max(1.25, 1.6 * s);
    ctx.font = `600 ${Math.round(13 * s)}px 'Chakra Petch', monospace`;
    ctx.textBaseline = 'middle';

    if (this.mode === 'off') {
      // keep only safety-critical cues + the race clock
      this.annunciators(d, cx, cy, s, true);
      if (d.race) this.raceBlock(d, cx, s, compact);
      return;
    }

    const full = this.mode === 'full';
    if (full) this.attitude(d, cx, cy, s);
    this.speedTape(d, compact ? 10 : w * 0.13, cy, s, compact, full);
    this.altTape(d, compact ? w - 10 : w * 0.87, cy, s, compact, full);
    if (full) this.headingRibbon(d, cx, (compact ? 46 : 30) + this.safeTop(), s, compact);
    this.annunciators(d, cx, cy, s, false);
    if (d.gun) this.gunBlock(d, cx, cy, s);
    if (d.ils) this.ilsBlock(d, cx, cy, s, compact, full);
    if (d.race) this.raceBlock(d, cx, s, compact);
    else if (d.nav) this.navBlock(d, cx, s, compact);
  }

  /**
   * ILS guidance: classic deviation scales — localizer dots under the
   * attitude sphere, glideslope dots to its right — with the ident + DME
   * readout above the horizon. Diamonds go green inside half a dot.
   */
  private ilsBlock(d: HudData, cx: number, cy: number, s: number, compact: boolean, full: boolean): void {
    const ils = d.ils!;
    const ctx = this.ctx;
    const CYAN = 'rgba(43, 217, 255, 0.92)';

    // ident + range readout, under the annunciator row (clear of the gun
    // score line on armed aircraft)
    ctx.textAlign = 'center';
    ctx.fillStyle = CYAN;
    ctx.font = `700 ${Math.round(12.5 * s)}px 'Chakra Petch', monospace`;
    const km = ils.dme >= 1000 ? `${(ils.dme / 1000).toFixed(1)} km` : `${Math.round(ils.dme)} m`;
    ctx.fillText(`ILS ${ils.ident} · ${ils.name} · ${km}`, cx, cy + (d.gun ? 232 : 214) * s);
    ctx.font = `600 ${Math.round(13 * s)}px 'Chakra Petch', monospace`;
    if (!full) return; // minimal HUD keeps the readout, skips the needles

    const dot = (x: number, y: number): void => {
      ctx.beginPath();
      ctx.arc(x, y, 2.6 * s, 0, Math.PI * 2);
      ctx.stroke();
    };
    const diamond = (x: number, y: number, captured: boolean): void => {
      ctx.fillStyle = captured ? this.g(0.95) : CYAN;
      ctx.beginPath();
      ctx.moveTo(x, y - 6.5 * s);
      ctx.lineTo(x + 5.5 * s, y);
      ctx.lineTo(x, y + 6.5 * s);
      ctx.lineTo(x - 5.5 * s, y);
      ctx.closePath();
      ctx.fill();
    };
    ctx.strokeStyle = 'rgba(43, 217, 255, 0.55)';

    // localizer scale (needle mirrors the deviation: fly TOWARD the diamond)
    const ly = cy + 166 * s;
    const span = 44 * s; // full-scale deflection in px
    ctx.beginPath();
    ctx.moveTo(cx, ly - 6 * s);
    ctx.lineTo(cx, ly + 6 * s);
    ctx.stroke();
    for (const k of [-1, -0.5, 0.5, 1]) dot(cx + k * span, ly);
    const locK = clamp(-ils.locDev / ils.locFull, -1.15, 1.15);
    diamond(cx + locK * span, ly, Math.abs(ils.locDev) < ils.locFull * 0.25);

    // glideslope scale (diamond above centre = you are LOW, fly up to it)
    const gx = cx + (compact ? 150 : 188) * s;
    ctx.beginPath();
    ctx.moveTo(gx - 6 * s, cy);
    ctx.lineTo(gx + 6 * s, cy);
    ctx.stroke();
    for (const k of [-1, -0.5, 0.5, 1]) dot(gx, cy + k * span);
    const gsK = clamp(ils.gsDev / ils.gsFull, -1.15, 1.15);
    diamond(gx, cy + gsK * span, Math.abs(ils.gsDev) < ils.gsFull * 0.25);
    ctx.fillStyle = 'rgba(43, 217, 255, 0.6)';
    ctx.font = `600 ${Math.round(10 * s)}px 'Chakra Petch', monospace`;
    ctx.fillText('G/S', gx, cy - span - 14 * s);
    ctx.font = `600 ${Math.round(13 * s)}px 'Chakra Petch', monospace`;
  }

  /** Active flight-plan leg: waypoint, range, relative bearing arrow, ETE. */
  private navBlock(d: HudData, cx: number, s: number, compact: boolean): void {
    const nav = d.nav!;
    const ctx = this.ctx;
    const top = this.safeTop() + (compact ? 100 : 92) * s;

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(43, 217, 255, 0.92)';
    ctx.font = `700 ${Math.round(13 * s)}px 'Chakra Petch', monospace`;
    const km = nav.distance >= 1000 ? `${(nav.distance / 1000).toFixed(1)} km` : `${Math.round(nav.distance)} m`;
    const ete = nav.eteSec !== null
      ? ` · ${Math.floor(nav.eteSec / 60)}:${String(Math.floor(nav.eteSec % 60)).padStart(2, '0')}`
      : '';
    ctx.fillText(`NAV ▸ ${nav.name} · ${km}${ete}`, cx, top);

    // relative-bearing arrow, same idiom as the race guidance
    const ay = top + 24 * s;
    const bearing = wrapAngle(nav.bearing);
    ctx.save();
    ctx.translate(cx, ay);
    ctx.rotate(bearing);
    const onTrack = Math.abs(bearing) < 0.06;
    ctx.fillStyle = onTrack ? this.g(0.95) : 'rgba(43, 217, 255, 0.9)';
    ctx.beginPath();
    ctx.moveTo(0, -12 * s);
    ctx.lineTo(7 * s, 6 * s);
    ctx.lineTo(0, 1.5 * s);
    ctx.lineTo(-7 * s, 6 * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.font = `600 ${Math.round(13 * s)}px 'Chakra Petch', monospace`;
  }

  /** Cannon reticle + ammo/targets readout (gun-equipped aircraft only). */
  private gunBlock(d: HudData, cx: number, cy: number, s: number): void {
    const gun = d.gun!;
    const ctx = this.ctx;

    // boresight reticle: ring with stadia ticks, brightens while firing
    const r = 26 * s;
    ctx.strokeStyle = gun.firing ? `rgba(${AMBER},0.95)` : this.g(0.55);
    ctx.beginPath();
    ctx.arc(cx, cy - 38 * s, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      ctx.moveTo(cx + Math.cos(a) * (r - 6 * s), cy - 38 * s + Math.sin(a) * (r - 6 * s));
      ctx.lineTo(cx + Math.cos(a) * (r + 4 * s), cy - 38 * s + Math.sin(a) * (r + 4 * s));
    }
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(cx, cy - 38 * s, 1.6 * s, 0, Math.PI * 2);
    ctx.fill();

    // ammo + range score, bottom centre-left
    ctx.textAlign = 'center';
    ctx.fillStyle = gun.ammo > 40 ? this.g(0.9) : `rgba(${RED},0.95)`;
    ctx.fillText(`GUN ${gun.ammo}`, cx - 60 * s, cy + 214 * s);
    ctx.fillStyle = this.g(0.75);
    ctx.fillText(`TGT ${gun.hits}/${gun.targets}`, cx + 60 * s, cy + 214 * s);
  }

  private safeTop(): number {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--sat');
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  private g(alpha: number): string { return `rgba(${PHOS}, ${alpha})`; }

  private attitude(d: HudData, cx: number, cy: number, s: number): void {
    const ctx = this.ctx;
    const R = 150 * s;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    ctx.translate(cx, cy);
    ctx.rotate(-d.roll);
    const pxPerDeg = (R * 2) / 70;
    ctx.translate(0, d.pitch * RAD2DEG * pxPerDeg);

    // horizon
    ctx.strokeStyle = this.g(0.9);
    ctx.beginPath();
    ctx.moveTo(-R * 1.6, 0);
    ctx.lineTo(R * 1.6, 0);
    ctx.stroke();

    // pitch ladder
    ctx.fillStyle = this.g(0.85);
    ctx.textAlign = 'left';
    for (let deg = -60; deg <= 60; deg += 10) {
      if (deg === 0) continue;
      const y = -deg * pxPerDeg;
      const half = (deg % 30 === 0 ? 46 : 30) * s;
      ctx.strokeStyle = this.g(deg > 0 ? 0.8 : 0.5);
      ctx.beginPath();
      if (deg > 0) {
        ctx.moveTo(-half, y); ctx.lineTo(-12 * s, y);
        ctx.moveTo(12 * s, y); ctx.lineTo(half, y);
      } else {
        for (const sx of [-1, 1]) {
          for (let i = 0; i < 3; i++) {
            ctx.moveTo(sx * (12 + i * 13) * s, y);
            ctx.lineTo(sx * (12 + i * 13 + 8) * s, y);
          }
        }
      }
      ctx.stroke();
      ctx.fillText(`${Math.abs(deg)}`, half + 5 * s, y);
    }
    ctx.restore();

    // waterline (aircraft symbol)
    ctx.strokeStyle = `rgba(${AMBER}, 0.95)`;
    ctx.lineWidth = Math.max(2, 2.4 * s);
    ctx.beginPath();
    ctx.moveTo(cx - 46 * s, cy);
    ctx.lineTo(cx - 16 * s, cy);
    ctx.lineTo(cx - 8 * s, cy + 9 * s);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + 8 * s, cy + 9 * s);
    ctx.lineTo(cx + 16 * s, cy);
    ctx.lineTo(cx + 46 * s, cy);
    ctx.stroke();
    ctx.lineWidth = Math.max(1.25, 1.6 * s);

    // roll arc + pointer
    ctx.strokeStyle = this.g(0.6);
    ctx.beginPath();
    ctx.arc(cx, cy, R + 12 * s, Math.PI * 1.25, Math.PI * 1.75);
    ctx.stroke();
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const rad = -Math.PI / 2 + (a * Math.PI) / 180;
      const len = a % 30 === 0 ? 10 : 6;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(rad) * (R + 12 * s), cy + Math.sin(rad) * (R + 12 * s));
      ctx.lineTo(cx + Math.cos(rad) * (R + (12 + len) * s), cy + Math.sin(rad) * (R + (12 + len) * s));
      ctx.stroke();
    }
    const pr = -Math.PI / 2 - d.roll;
    ctx.fillStyle = `rgba(${AMBER}, 0.95)`;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(pr) * (R + 11 * s), cy + Math.sin(pr) * (R + 11 * s));
    ctx.lineTo(cx + Math.cos(pr + 0.045) * (R + 24 * s), cy + Math.sin(pr + 0.045) * (R + 24 * s));
    ctx.lineTo(cx + Math.cos(pr - 0.045) * (R + 24 * s), cy + Math.sin(pr - 0.045) * (R + 24 * s));
    ctx.closePath();
    ctx.fill();
  }

  private tapeBox(x: number, y: number, wBox: number, hBox: number, alignRight: boolean): void {
    const ctx = this.ctx;
    ctx.strokeStyle = this.g(0.9);
    ctx.fillStyle = 'rgba(7, 13, 24, 0.55)';
    const dir = alignRight ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(x, y - hBox / 2);
    ctx.lineTo(x + dir * wBox, y - hBox / 2);
    ctx.lineTo(x + dir * (wBox + 10), y);
    ctx.lineTo(x + dir * wBox, y + hBox / 2);
    ctx.lineTo(x, y + hBox / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  private speedTape(d: HudData, x: number, cy: number, s: number, compact: boolean, full: boolean): void {
    const ctx = this.ctx;
    const kt = d.airspeed * MS_TO_KT;
    const H = 280 * s;
    const pxPerKt = H / 100;

    if (full) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - 2, cy - H / 2, 80 * s, H);
      ctx.clip();
      ctx.textAlign = 'left';
      const vneKt = d.vne * MS_TO_KT;
      for (let v = Math.floor((kt - 55) / 10) * 10; v <= kt + 55; v += 10) {
        if (v < 0) continue;
        const y = cy + (kt - v) * pxPerKt;
        const danger = v >= vneKt;
        ctx.strokeStyle = danger ? `rgba(${RED},0.9)` : this.g(0.7);
        ctx.fillStyle = danger ? `rgba(${RED},0.9)` : this.g(0.8);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 10 * s, y);
        ctx.stroke();
        if (v % 20 === 0) ctx.fillText(`${v}`, x + 14 * s, y);
      }
      ctx.restore();
    }

    this.tapeBox(x - 2, cy, 64 * s, 30 * s, false);
    ctx.fillStyle = this.g(1);
    ctx.textAlign = 'left';
    ctx.font = `700 ${Math.round(17 * s)}px 'Chakra Petch', monospace`;
    ctx.fillText(`${Math.round(kt)}`, x + 8 * s, cy);
    ctx.font = `600 ${Math.round(11 * s)}px 'Chakra Petch', monospace`;
    ctx.fillStyle = this.g(0.6);
    ctx.fillText('KT', x + 4 * s, cy - H / 2 - 12 * s);

    // groundspeed readout just under the airspeed box
    ctx.fillStyle = this.g(0.85);
    ctx.fillText(`GS ${Math.round(d.groundspeed * MS_TO_KT)}`, x + 4 * s, cy + 26 * s);
    if (d.wind) {
      ctx.fillStyle = this.g(0.55);
      ctx.fillText(
        `W ${String(Math.round(d.wind.fromDeg)).padStart(3, '0')}°/${d.wind.kt}`,
        x + 4 * s, cy + 42 * s,
      );
    }

    if (!full) return;

    // throttle bar under the tape — helicopters get the torque gauge and a
    // rotor-RPM readout instead (pilots fly TRQ and NR, not a throttle bar)
    const ty = cy + H / 2 + 18 * s;
    const tw = 70 * s;
    ctx.strokeStyle = this.g(0.6);
    ctx.strokeRect(x, ty, tw, 8 * s);
    if (d.heli) {
      const hi = d.heli.trq > 0.85;
      ctx.fillStyle = hi ? `rgba(${AMBER},0.95)` : this.g(0.75);
      ctx.fillRect(x + 1, ty + 1, (tw - 2) * Math.min(d.heli.trq, 1), 8 * s - 2);
      ctx.fillStyle = d.heli.engineOut ? `rgba(${RED},0.9)` : this.g(0.6);
      ctx.fillText(d.heli.engineOut ? 'TRQ — ENG OUT' : `TRQ ${Math.round(d.heli.trq * 100)}%`, x, ty + 17 * s);
      const nrPct = Math.round(d.heli.nr * 100);
      ctx.fillStyle = d.heli.nr < 0.9 ? `rgba(${RED},0.95)`
        : d.heli.nr > 1.05 ? `rgba(${AMBER},0.95)` : this.g(0.85);
      ctx.fillText(`NR ${nrPct}%`, x, ty + 33 * s);
      if (!compact) {
        ctx.fillStyle = this.g(0.85);
        ctx.fillText(`G ${d.gForce.toFixed(1)}`, x, ty + 49 * s);
      }
      return;
    }
    ctx.fillStyle = d.afterburner ? `rgba(${AMBER},0.95)` : this.g(0.75);
    ctx.fillRect(x + 1, ty + 1, (tw - 2) * d.throttle, 8 * s - 2);
    ctx.fillStyle = this.g(0.6);
    ctx.fillText(d.afterburner ? 'THR AB' : 'THR', x, ty + 17 * s);

    if (!compact) {
      ctx.fillStyle = this.g(0.85);
      ctx.fillText(`G ${d.gForce.toFixed(1)}`, x, ty + 33 * s);
    }
  }

  private altTape(d: HudData, x: number, cy: number, s: number, compact: boolean, full: boolean): void {
    const ctx = this.ctx;
    const ft = d.altitude * M_TO_FT;
    const H = 280 * s;
    const pxPerFt = H / 1000;

    if (full) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - 78 * s, cy - H / 2, 80 * s, H);
      ctx.clip();
      ctx.textAlign = 'right';
      for (let v = Math.floor((ft - 550) / 100) * 100; v <= ft + 550; v += 100) {
        const y = cy + (v - ft) * -pxPerFt;
        ctx.strokeStyle = this.g(0.7);
        ctx.fillStyle = this.g(0.8);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 10 * s, y);
        ctx.stroke();
        if (v % 200 === 0) ctx.fillText(`${v}`, x - 14 * s, y);
      }
      ctx.restore();
    }

    this.tapeBox(x + 2, cy, 72 * s, 30 * s, true);
    ctx.fillStyle = this.g(1);
    ctx.textAlign = 'right';
    ctx.font = `700 ${Math.round(17 * s)}px 'Chakra Petch', monospace`;
    ctx.fillText(`${Math.round(ft)}`, x - 8 * s, cy);
    ctx.font = `600 ${Math.round(11 * s)}px 'Chakra Petch', monospace`;
    ctx.fillStyle = this.g(0.6);
    ctx.fillText('FT', x - 4 * s, cy - H / 2 - 12 * s);

    if (!full) return;

    // vertical speed (fpm, abbreviated)
    const fpm = d.vs * M_TO_FT * 60;
    ctx.fillStyle = this.g(0.85);
    ctx.fillText(`${fpm >= 0 ? '+' : ''}${(fpm / 100).toFixed(1)}`, x - 4 * s, cy + H / 2 + 16 * s);
    ctx.fillStyle = this.g(0.55);
    ctx.fillText('VS×100', x - 4 * s, cy + H / 2 + 31 * s);

    if (!compact && d.radarAlt < 300) {
      ctx.fillStyle = `rgba(${AMBER},0.9)`;
      ctx.fillText(`RA ${Math.max(0, Math.round(d.radarAlt * M_TO_FT))}`, x - 4 * s, cy + H / 2 + 48 * s);
    }
  }

  private headingRibbon(d: HudData, cx: number, top: number, s: number, compact: boolean): void {
    const ctx = this.ctx;
    const degHeading = ((d.heading * RAD2DEG) % 360 + 360) % 360;
    const W = (compact ? 230 : 330) * s;
    const pxPerDeg = W / 80;

    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - W / 2, top, W, 34 * s);
    ctx.clip();
    ctx.textAlign = 'center';
    const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let off = -45; off <= 45; off += 5) {
      let hdg = Math.round((degHeading + off) / 5) * 5;
      const x = cx + (hdg - degHeading) * pxPerDeg;
      hdg = ((hdg % 360) + 360) % 360;
      const major = hdg % 15 === 0;
      ctx.strokeStyle = this.g(0.7);
      ctx.beginPath();
      ctx.moveTo(x, top + 24 * s);
      ctx.lineTo(x, top + (major ? 14 : 19) * s);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = this.g(0.85);
        ctx.fillText(names[hdg] ?? `${hdg / 10 < 1 ? '0' : ''}${Math.round(hdg / 10)}`, x, top + 7 * s);
      }
    }
    ctx.restore();

    // current heading caret + box
    ctx.fillStyle = `rgba(${AMBER},0.95)`;
    ctx.beginPath();
    ctx.moveTo(cx, top + 26 * s);
    ctx.lineTo(cx - 6 * s, top + 34 * s);
    ctx.lineTo(cx + 6 * s, top + 34 * s);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = this.g(1);
    ctx.font = `700 ${Math.round(14 * s)}px 'Chakra Petch', monospace`;
    ctx.fillText(`${String(Math.round(degHeading)).padStart(3, '0')}°`, cx, top + 46 * s);
    ctx.font = `600 ${Math.round(13 * s)}px 'Chakra Petch', monospace`;
  }

  private annunciators(d: HudData, cx: number, cy: number, s: number, safetyOnly: boolean): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    const y0 = cy + 190 * s;
    if (!safetyOnly) {
      const items: Array<[string, string]> = [];
      if (d.heli?.engineOut) items.push(['ENG OUT', `rgba(${RED},0.95)`]);
      if (d.autopilot) items.push(['AP', `rgba(${AMBER},0.95)`]);
      if (d.retractable) items.push(d.gearDown ? ['GEAR ▼', this.g(0.9)] : ['GEAR ▲', this.g(0.45)]);
      if (d.flaps > 0.01) items.push([`FLAPS ${Math.round(d.flaps * 3)}`, this.g(0.9)]);
      if (d.airbrake) items.push(['SPD BRK', `rgba(${AMBER},0.95)`]);
      if (d.brakes) items.push(['BRAKES', `rgba(${AMBER},0.95)`]);
      const spread = 86 * s;
      items.forEach(([label, color], i) => {
        ctx.fillStyle = color;
        ctx.fillText(label, cx + (i - (items.length - 1) / 2) * spread, y0);
      });
    }

    if (d.stalled && Math.sin(this.time * 14) > -0.2) {
      ctx.fillStyle = `rgba(${RED},0.95)`;
      ctx.font = `700 ${Math.round(24 * s)}px 'Chakra Petch', monospace`;
      ctx.fillText('STALL', cx, cy - 110 * s);
      ctx.font = `600 ${Math.round(13 * s)}px 'Chakra Petch', monospace`;
    }

    // helicopter master cautions — safety-critical, shown in every HUD mode
    if (d.heli) {
      if (d.heli.lowRpm && Math.sin(this.time * 14) > -0.2) {
        ctx.fillStyle = `rgba(${RED},0.95)`;
        ctx.font = `700 ${Math.round(22 * s)}px 'Chakra Petch', monospace`;
        ctx.fillText('LOW ROTOR RPM', cx, cy - 110 * s);
        ctx.font = `600 ${Math.round(13 * s)}px 'Chakra Petch', monospace`;
      } else if (d.heli.vrs && Math.sin(this.time * 10) > -0.3) {
        ctx.fillStyle = `rgba(${AMBER},0.95)`;
        ctx.font = `700 ${Math.round(20 * s)}px 'Chakra Petch', monospace`;
        ctx.fillText('VORTEX RING — FLY FORWARD', cx, cy - 110 * s);
        ctx.font = `600 ${Math.round(13 * s)}px 'Chakra Petch', monospace`;
      }
    }
  }

  private raceBlock(d: HudData, cx: number, s: number, compact: boolean): void {
    const race = d.race!;
    const ctx = this.ctx;
    const top = this.safeTop() + (compact ? 100 : 92) * s;

    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(${AMBER},0.95)`;
    ctx.font = `700 ${Math.round(15 * s)}px 'Chakra Petch', monospace`;
    const km = race.distance >= 1000 ? `${(race.distance / 1000).toFixed(1)} km` : `${Math.round(race.distance)} m`;
    ctx.fillText(`GATE ${race.gate}/${race.total} · ${km}`, cx, top);
    ctx.fillStyle = this.g(0.95);
    ctx.fillText(formatTime(race.time), cx, top + 20 * s);
    if (race.best !== null) {
      ctx.fillStyle = this.g(0.55);
      ctx.font = `600 ${Math.round(11 * s)}px 'Chakra Petch', monospace`;
      ctx.fillText(`BEST ${formatTime(race.best)}`, cx, top + 37 * s);
    }

    // guidance arrow (rotates with relative bearing; flattens when on target)
    const ay = top + 64 * s;
    const bearing = wrapAngle(race.bearing);
    ctx.save();
    ctx.translate(cx, ay);
    ctx.rotate(bearing);
    const onTarget = Math.abs(bearing) < 0.08;
    ctx.strokeStyle = onTarget ? this.g(0.95) : `rgba(${AMBER},0.9)`;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(0, -16 * s);
    ctx.lineTo(9 * s, 8 * s);
    ctx.lineTo(0, 2 * s);
    ctx.lineTo(-9 * s, 8 * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // climb/descend hint
    if (Math.abs(race.elev) > 0.06) {
      ctx.fillStyle = this.g(0.7);
      ctx.font = `600 ${Math.round(11 * s)}px 'Chakra Petch', monospace`;
      ctx.fillText(race.elev > 0 ? '▲ CLIMB' : '▼ DESCEND', cx, ay + 26 * s);
    }
    ctx.font = `600 ${Math.round(13 * s)}px 'Chakra Petch', monospace`;
  }
}
