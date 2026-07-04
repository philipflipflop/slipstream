/**
 * Navigation display. Two modes sharing one renderer:
 *  - docked: small heading-up circular minimap (M toggles visibility)
 *  - expanded: large north-up planning chart (N toggles) with zoom, every
 *    runway drawn as an oriented strip, and click-to-build flight-plan
 *    waypoints with a leg readout panel (the "onboard computer").
 */
import { WorldGen, AirfieldDef, AIRPORTS, WATER_LEVEL } from '../world/heightfield';
import type { RingCourse } from '../world/rings';
import type { Route, Waypoint } from '../nav/route';
import { MS_TO_KT, RAD2DEG } from '../core/math';

const GRID = 52;          // terrain sample grid
const RANGES = [4500, 9000, 18000, 36000, 72000];

export class Minimap {
  visible = true;
  expanded = false;

  /** a click on the chart resolved to a waypoint (airfield-snapped) */
  onWaypoint: (wp: Waypoint) => void = () => {};
  onUndo: () => void = () => {};
  onClear: () => void = () => {};
  onEngage: () => void = () => {};
  onCloseNav: () => void = () => {};

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private wrap: HTMLDivElement;
  private panel: HTMLDivElement;
  private legList: HTMLDivElement;
  private engageBtn: HTMLButtonElement;
  private size = 168;
  private dpr = 1;
  private rangeIdx = 1;

  private samples = new Float32Array(GRID * GRID);
  private sampleRow = 0;
  private centerX = 0;
  private centerZ = 0;
  private sampleRange = 0;
  private fields: AirfieldDef[] = [];
  private fieldTimer = 0;
  private panelTimer = 0;
  private lastPx = 0;
  private lastPz = 0;
  // expanded-chart pan (world-space offset of the view from the aircraft):
  // the chart is drawn from the analytic heightfield, so the player can
  // scroll far beyond the streamed 3D world at zero rendering cost
  private panX = 0;
  private panZ = 0;
  private panPointer: number | null = null;
  private panMoved = false;
  private panLastX = 0;
  private panLastY = 0;

  constructor(private gen: WorldGen) {
    this.wrap = document.createElement('div');
    this.wrap.id = 'navwrap';
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'minimap';
    this.wrap.appendChild(this.canvas);

    // planning panel (visible only when expanded)
    this.panel = document.createElement('div');
    this.panel.id = 'navpanel';
    this.panel.innerHTML = `
      <div class="nav-title">FLIGHT COMPUTER</div>
      <div class="nav-hint">Click the chart to add waypoints (clicks near a runway snap to it).<br>Drag to scroll the chart — plan far beyond the horizon.</div>
      <div class="nav-legs"></div>
      <div class="nav-buttons">
        <button data-act="zoomout">−</button>
        <button data-act="zoomin">+</button>
        <button data-act="recenter">⌖ ACFT</button>
        <button data-act="undo">UNDO</button>
        <button data-act="clear">CLEAR</button>
      </div>
      <button class="nav-engage" data-act="engage">ENGAGE NAV</button>
      <button class="nav-close" data-act="close">CLOSE</button>
      <div class="nav-close-hint">N or ESC to close</div>
    `;
    this.legList = this.panel.querySelector('.nav-legs')!;
    this.engageBtn = this.panel.querySelector('.nav-engage')!;
    this.wrap.appendChild(this.panel);
    document.body.appendChild(this.wrap);

    this.ctx = this.canvas.getContext('2d')!;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.applySize();
    this.samples.fill(-100);

    this.panel.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).dataset?.act;
      if (act === 'zoomin') this.zoom(-1);
      else if (act === 'zoomout') this.zoom(1);
      else if (act === 'recenter') { this.panX = 0; this.panZ = 0; this.resample(); }
      else if (act === 'undo') this.onUndo();
      else if (act === 'clear') this.onClear();
      else if (act === 'engage') this.onEngage();
      else if (act === 'close') this.onCloseNav();
    });

    // tapping the dimmed backdrop closes the chart (touch has no ESC)
    this.wrap.addEventListener('pointerdown', (e) => {
      if (this.expanded && e.target === this.wrap) this.onCloseNav();
    });

    // drag = pan the chart; a tap (no meaningful drag) = add a waypoint
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.expanded || this.panPointer !== null) return;
      this.panPointer = e.pointerId;
      this.panMoved = false;
      this.panLastX = e.clientX;
      this.panLastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.panPointer) return;
      const dx = e.clientX - this.panLastX;
      const dy = e.clientY - this.panLastY;
      if (!this.panMoved && Math.hypot(dx, dy) < 6) return; // still a tap
      this.panMoved = true;
      const toMap = (this.size * 0.5) / this.range();
      this.panX -= dx / toMap;
      this.panZ -= dy / toMap;
      this.panLastX = e.clientX;
      this.panLastY = e.clientY;
    });
    const panEnd = (e: PointerEvent): void => {
      if (e.pointerId !== this.panPointer) return;
      this.panPointer = null;
      if (this.panMoved || e.type === 'pointercancel') return;
      // clean tap: resolve to a waypoint
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const c = this.size / 2;
      const toMap = (this.size * 0.5) / this.range();
      const wx = this.lastPx + this.panX + (mx - c) / toMap;
      const wz = this.lastPz + this.panZ + (my - c) / toMap;

      // snap to a runway when the click lands near its icon
      let snapped: AirfieldDef | null = null;
      let bestPx = 16; // pixels
      for (const ap of this.fields) {
        const d = Math.hypot((ap.x - wx) * toMap, (ap.z - wz) * toMap);
        if (d < bestPx) { bestPx = d; snapped = ap; }
      }
      if (snapped) {
        this.onWaypoint({
          x: snapped.x, z: snapped.z, name: snapped.name,
          airfield: {
            code: snapped.code, heading: snapped.heading,
            elev: snapped.elev, length: snapped.length,
          },
        });
      } else {
        this.onWaypoint({ x: wx, z: wz, name: '' });
      }
    };
    this.canvas.addEventListener('pointerup', panEnd);
    this.canvas.addEventListener('pointercancel', panEnd);
  }

  private range(): number { return RANGES[this.rangeIdx]; }

  zoom(dir: number): void {
    const next = Math.min(Math.max(this.rangeIdx + dir, 0), RANGES.length - 1);
    if (next !== this.rangeIdx) {
      this.rangeIdx = next;
      this.resample();
    }
  }

  private resample(): void {
    this.sampleRow = 0;
    this.samples.fill(-100);
    this.sampleRange = 0; // force recentre next update
  }

  private applySize(): void {
    const small = window.innerWidth < 880 || window.innerHeight < 520;
    this.size = this.expanded
      ? Math.min(window.innerWidth, window.innerHeight) * 0.72
      : small ? 118 : 168;
    this.canvas.width = Math.floor(this.size * this.dpr);
    this.canvas.height = Math.floor(this.size * this.dpr);
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
  }

  setExpanded(on: boolean): void {
    this.expanded = on;
    this.wrap.classList.toggle('expanded', on);
    this.panX = 0;
    this.panZ = 0;
    this.panPointer = null;
    this.applySize();
    this.resample();
    if (on && this.rangeIdx < 2) this.rangeIdx = 2; // open the chart wide
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.syncDisplay();
  }

  show(on: boolean): void {
    this.wrap.style.display = on && (this.visible || this.expanded) ? 'block' : 'none';
  }

  private syncDisplay(): void {
    this.wrap.style.display = this.visible || this.expanded ? 'block' : 'none';
  }

  update(px: number, pz: number, heading: number, rings: RingCourse, route: Route | null, gs = 0): void {
    if (!this.visible && !this.expanded) return;
    this.lastPx = px;
    this.lastPz = pz;
    const RANGE = this.range();

    // the view centre: the aircraft, offset by any chart pan
    const vx = px + (this.expanded ? this.panX : 0);
    const vz = pz + (this.expanded ? this.panZ : 0);

    // sample around a point LED ahead of the view along the track — at
    // 400 kt a lazily-trailing centre used to leave a black band hatching
    // in at the leading edge every ~20 s (pan overrides the lead)
    const panned = this.expanded && (this.panX !== 0 || this.panZ !== 0);
    const lead = panned ? 0 : Math.min(gs * 15, RANGE * 0.45);
    const lookX = vx + Math.sin(heading) * lead;
    const lookZ = vz - Math.cos(heading) * lead;

    // refresh a few sample rows per frame, re-centring before the view
    // can outrun the sampled square
    const stale = Math.hypot(lookX - this.centerX, lookZ - this.centerZ) > RANGE * 0.16 || this.sampleRange !== RANGE;
    if (stale || this.sampleRow > 0) {
      if (this.sampleRow === 0) {
        this.centerX = lookX;
        this.centerZ = lookZ;
        this.sampleRange = RANGE;
      }
      const rows = this.expanded ? 8 : 4;
      for (let r = 0; r < rows && this.sampleRow < GRID; r++, this.sampleRow++) {
        const j = this.sampleRow;
        const wz = this.centerZ - RANGE + (j / (GRID - 1)) * RANGE * 2;
        for (let i = 0; i < GRID; i++) {
          const wx = this.centerX - RANGE + (i / (GRID - 1)) * RANGE * 2;
          this.samples[j * GRID + i] = this.gen.heightAt(wx, wz);
        }
      }
      if (this.sampleRow >= GRID) this.sampleRow = 0;
    } else if (this.sampleRow === 0) {
      this.sampleRow = 1; // kick off the first fill
    }

    // refresh the airfield set every couple of seconds (scales with zoom,
    // follows the panned view so far-away strips appear while planning)
    if (--this.fieldTimer <= 0) {
      this.fieldTimer = 120;
      this.gen.airfieldsNear(vx, vz, Math.max(32000, RANGE * 1.4), this.fields);
      if (!this.fields.some((f) => f.major)) this.fields.push(AIRPORTS[0]);
    }

    this.draw(px, pz, vx, vz, heading, rings, route);

    // route panel refresh (4 Hz is plenty for text)
    if (this.expanded && --this.panelTimer <= 0) {
      this.panelTimer = 15;
      this.renderPanel(px, pz, gs, route);
    }
  }

  /* ------------------------------------------------------------ draw ---- */

  private draw(
    px: number, pz: number, vx: number, vz: number,
    heading: number, rings: RingCourse, route: Route | null,
  ): void {
    const ctx = this.ctx;
    const S = this.size;
    const c = S / 2;
    const RANGE = this.range();
    // expanded chart is north-up; docked map is heading-up
    const rot = this.expanded ? 0 : -heading;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);

    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, c - 2, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = this.expanded ? 'rgba(7, 13, 24, 0.92)' : 'rgba(7, 13, 24, 0.78)';
    ctx.fillRect(0, 0, S, S);

    ctx.translate(c, c);
    ctx.rotate(rot);

    // terrain blobs (sampled around a possibly stale centre — fine here)
    const cell = (S / GRID) * 1.45;
    const toMap = (S * 0.5) / RANGE;
    for (let j = 0; j < GRID; j++) {
      const wz = this.centerZ - this.sampleRange + (j / (GRID - 1)) * this.sampleRange * 2;
      for (let i = 0; i < GRID; i++) {
        const h = this.samples[j * GRID + i];
        if (h <= WATER_LEVEL) continue;
        const wx = this.centerX - this.sampleRange + (i / (GRID - 1)) * this.sampleRange * 2;
        const mx = (wx - vx) * toMap;
        const mz = (wz - vz) * toMap;
        if (mx * mx + mz * mz > c * c * 1.45) continue;
        if (h > 450) ctx.fillStyle = 'rgba(190, 200, 212, 0.85)';
        else if (h > 150) ctx.fillStyle = 'rgba(96, 112, 78, 0.85)';
        else ctx.fillStyle = 'rgba(58, 88, 52, 0.85)';
        ctx.fillRect(mx - cell / 2, mz - cell / 2, cell, cell);
      }
    }

    // runway strips, oriented to their true headings
    for (const ap of this.fields) {
      const mx = (ap.x - vx) * toMap;
      const mz = (ap.z - vz) * toMap;
      if (Math.hypot(mx, mz) > c - 8) continue;
      const len = Math.max(ap.length * toMap, 9);
      ctx.save();
      ctx.translate(mx, mz);
      ctx.rotate(ap.heading);
      ctx.fillStyle = '#e8eef7';
      ctx.fillRect(-1.7, -len / 2, 3.4, len);
      ctx.restore();
    }

    // flight-plan route
    if (route && !route.isEmpty) {
      ctx.strokeStyle = 'rgba(43, 217, 255, 0.85)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      let fx = (px - vx) * toMap;
      let fz = (pz - vz) * toMap; // the aircraft (off-centre when panned)
      ctx.moveTo(fx, fz);
      for (let i = route.active; i < route.waypoints.length; i++) {
        const wp = route.waypoints[i];
        fx = (wp.x - vx) * toMap;
        fz = (wp.z - vz) * toMap;
        ctx.lineTo(fx, fz);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      for (let i = 0; i < route.waypoints.length; i++) {
        const wp = route.waypoints[i];
        const mx = (wp.x - vx) * toMap;
        const mz = (wp.z - vz) * toMap;
        const activeWp = i === route.active;
        const passed = i < route.active;
        ctx.fillStyle = passed ? 'rgba(120,140,160,0.6)' : activeWp ? '#ffb340' : '#2bd9ff';
        ctx.save();
        ctx.translate(mx, mz);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-3.4, -3.4, 6.8, 6.8);
        ctx.restore();
        if (this.expanded) {
          ctx.fillStyle = 'rgba(232, 238, 247, 0.85)';
          ctx.font = `600 10px 'Chakra Petch', monospace`;
          ctx.textAlign = 'left';
          ctx.save();
          ctx.translate(mx + 7, mz - 6);
          ctx.rotate(-rot);
          ctx.fillText(wp.name || `WP${i + 1}`, 0, 0);
          ctx.restore();
        }
      }
    }

    // ring course
    if (rings.active) {
      for (let i = rings.current; i < rings.rings.length; i++) {
        const r = rings.rings[i];
        const mx = (r.pos.x - vx) * toMap;
        const mz = (r.pos.z - vz) * toMap;
        ctx.fillStyle = i === rings.current ? '#ffb340' : 'rgba(43, 217, 255, 0.55)';
        ctx.beginPath();
        ctx.arc(mx, mz, i === rings.current ? 3.4 : 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // airport beacons — beyond range they clamp to the rim with a pointer
    for (const ap of this.fields) {
      let mx = (ap.x - vx) * toMap;
      let mz = (ap.z - vz) * toMap;
      const dist = Math.hypot(mx, mz);
      const maxR = c - 13;
      const offMap = dist > maxR;
      let ux = 0;
      let uz = 0;
      if (offMap && dist > 0) {
        ux = mx / dist;
        uz = mz / dist;
        mx = ux * maxR;
        mz = uz * maxR;
      }
      const color = ap.major ? '#ffb340' : '#7dffa8';

      if (offMap) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(mx + ux * 9, mz + uz * 9);
        ctx.lineTo(mx - uz * 4.5, mz + ux * 4.5);
        ctx.lineTo(mx + uz * 4.5, mz - ux * 4.5);
        ctx.closePath();
        ctx.fill();
      }
      // beacon disc with a runway-direction bar through it
      ctx.fillStyle = 'rgba(7, 13, 24, 0.9)';
      ctx.beginPath();
      ctx.arc(mx, mz, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      // the bar shows which way the runway runs even from the rim
      ctx.save();
      ctx.translate(mx, mz);
      ctx.rotate(ap.heading);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(0, 9);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = color;
      ctx.font = `700 8px 'Chakra Petch', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.translate(mx, mz);
      ctx.rotate(-rot); // keep the letter upright
      ctx.fillText(ap.code, 0, 0.5);
      ctx.restore();
    }

    ctx.restore();

    // rim
    ctx.strokeStyle = 'rgba(125, 255, 168, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c, c, c - 2, 0, Math.PI * 2);
    ctx.stroke();

    // player marker: chevron at the aircraft's chart position (off-centre
    // when panned; clamped to the rim with a pointer when scrolled away)
    {
      const toMap2 = (S * 0.5) / RANGE;
      let ox = (px - vx) * toMap2;
      let oz = (pz - vz) * toMap2;
      const d = Math.hypot(ox, oz);
      const maxR = c - 12;
      const off = d > maxR;
      if (off) { ox = (ox / d) * maxR; oz = (oz / d) * maxR; }
      ctx.save();
      ctx.translate(c + ox, c + oz);
      if (this.expanded) ctx.rotate(heading); // north-up chart: rotate the chevron
      ctx.fillStyle = '#ffb340';
      ctx.globalAlpha = off ? 0.6 : 1;
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // north tick + range readout
    const na = rot - Math.PI / 2;
    ctx.fillStyle = 'rgba(125, 255, 168, 0.95)';
    ctx.font = `700 10px 'Chakra Petch', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', c + Math.cos(na) * (c - 11), c + Math.sin(na) * (c - 11));
    ctx.font = `600 9px 'Chakra Petch', monospace`;
    ctx.fillStyle = 'rgba(125, 255, 168, 0.7)';
    ctx.textAlign = 'left';
    ctx.fillText(`${(RANGE / 1000).toFixed(0)} km`, 8, S - 10);
  }

  /* ----------------------------------------------------------- panel ---- */

  private renderPanel(px: number, pz: number, gs: number, route: Route | null): void {
    this.engageBtn.textContent = route?.engaged ? 'DISENGAGE NAV' : 'ENGAGE NAV';
    this.engageBtn.classList.toggle('armed', !!route?.engaged);

    if (!route || route.isEmpty) {
      this.legList.innerHTML = `<div class="nav-empty">NO FLIGHT PLAN</div>`;
      return;
    }
    const legs = route.legs(px, pz, gs);
    let total = 0;
    let totalEte = 0;
    let haveEte = true;
    let html = '';
    for (const leg of legs) {
      total += leg.distance;
      if (leg.eteSec === null) haveEte = false;
      else totalEte += leg.eteSec;
      const brg = String(Math.round(leg.bearing * RAD2DEG) % 360).padStart(3, '0');
      const km = (leg.distance / 1000).toFixed(1);
      const ete = leg.eteSec !== null ? fmtEte(leg.eteSec) : '--:--';
      html += `<div class="nav-leg"><span>${leg.to || 'WPT'}</span><span>${brg}°</span><span>${km} km</span><span>${ete}</span></div>`;
    }
    html += `<div class="nav-leg total"><span>TOTAL</span><span></span><span>${(total / 1000).toFixed(1)} km</span><span>${haveEte ? fmtEte(totalEte) : '--:--'}</span></div>`;
    if (gs > 2) {
      html += `<div class="nav-gs">GS ${Math.round(gs * MS_TO_KT)} KT</div>`;
    }
    this.legList.innerHTML = html;
  }
}

function fmtEte(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m >= 100) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
