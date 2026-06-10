/**
 * Heading-up circular minimap: coarse terrain radar (sampled from the
 * analytic heightfield, refreshed a few rows per frame), runway strips,
 * Ring Rush gates and a north arrow. Toggle with M.
 */
import { WorldGen, AIRPORTS, WATER_LEVEL } from '../world/heightfield';
import type { RingCourse } from '../world/rings';

const GRID = 44;        // terrain sample grid
const RANGE = 9000;     // metres shown from centre to edge

export class Minimap {
  visible = true;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size = 168;
  private dpr = 1;

  private samples = new Float32Array(GRID * GRID); // terrain heights
  private sampleRow = 0;
  private centerX = 0;
  private centerZ = 0;

  constructor(private gen: WorldGen) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'minimap';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.size * this.dpr;
    this.canvas.height = this.size * this.dpr;
    this.samples.fill(-100);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.canvas.style.display = v ? 'block' : 'none';
  }

  show(on: boolean): void {
    this.canvas.style.display = on && this.visible ? 'block' : 'none';
  }

  update(px: number, pz: number, heading: number, rings: RingCourse): void {
    if (!this.visible) return;

    // refresh a few sample rows per frame, re-centring lazily
    if (Math.hypot(px - this.centerX, pz - this.centerZ) > RANGE * 0.22 || this.sampleRow > 0) {
      if (this.sampleRow === 0) {
        this.centerX = px;
        this.centerZ = pz;
      }
      const rows = 4;
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

    this.draw(px, pz, heading, rings);
  }

  private draw(px: number, pz: number, heading: number, rings: RingCourse): void {
    const ctx = this.ctx;
    const S = this.size;
    const c = S / 2;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);

    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, c - 2, 0, Math.PI * 2);
    ctx.clip();

    // base
    ctx.fillStyle = 'rgba(7, 13, 24, 0.78)';
    ctx.fillRect(0, 0, S, S);

    // rotate world so heading-up
    ctx.translate(c, c);
    ctx.rotate(-heading);

    // terrain blobs (sampled around a possibly stale centre — fine at this scale)
    const cell = (S / GRID) * 1.45;
    const toMap = RANGE > 0 ? (S * 0.5) / RANGE : 0;
    for (let j = 0; j < GRID; j++) {
      const wz = this.centerZ - RANGE + (j / (GRID - 1)) * RANGE * 2;
      for (let i = 0; i < GRID; i++) {
        const h = this.samples[j * GRID + i];
        if (h <= WATER_LEVEL) continue; // leave water as base colour
        const wx = this.centerX - RANGE + (i / (GRID - 1)) * RANGE * 2;
        const mx = (wx - px) * toMap;
        const mz = (wz - pz) * toMap;
        if (mx * mx + mz * mz > c * c * 1.45) continue;
        if (h > 450) ctx.fillStyle = 'rgba(190, 200, 212, 0.85)';
        else if (h > 150) ctx.fillStyle = 'rgba(96, 112, 78, 0.85)';
        else ctx.fillStyle = 'rgba(58, 88, 52, 0.85)';
        ctx.fillRect(mx - cell / 2, mz - cell / 2, cell, cell);
      }
    }

    // runway strips (only meaningful when in range)
    for (const ap of AIRPORTS) {
      const mx = (ap.x - px) * toMap;
      const mz = (ap.z - pz) * toMap;
      if (Math.hypot(mx, mz) > c - 10) continue;
      const len = Math.max(ap.length * toMap, 7);
      ctx.fillStyle = '#e8eef7';
      ctx.fillRect(mx - 1.6, mz - len / 2, 3.2, len);
    }

    // ring course
    if (rings.active) {
      for (let i = rings.current; i < rings.rings.length; i++) {
        const r = rings.rings[i];
        const mx = (r.pos.x - px) * toMap;
        const mz = (r.pos.z - pz) * toMap;
        ctx.fillStyle = i === rings.current ? '#ffb340' : 'rgba(43, 217, 255, 0.55)';
        ctx.beginPath();
        ctx.arc(mx, mz, i === rings.current ? 3.4 : 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // airport beacons — always visible; beyond range they clamp to the rim
    // with an outward pointer so you always know which way home is
    for (const ap of AIRPORTS) {
      let mx = (ap.x - px) * toMap;
      let mz = (ap.z - pz) * toMap;
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
        // outward pointer on the rim
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(mx + ux * 9, mz + uz * 9);
        ctx.lineTo(mx - uz * 4.5, mz + ux * 4.5);
        ctx.lineTo(mx + uz * 4.5, mz - ux * 4.5);
        ctx.closePath();
        ctx.fill();
      }
      // beacon disc with designator
      ctx.fillStyle = 'rgba(7, 13, 24, 0.9)';
      ctx.beginPath();
      ctx.arc(mx, mz, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = `700 8px 'Chakra Petch', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.translate(mx, mz);
      ctx.rotate(heading); // keep the letter upright in heading-up mode
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

    // player chevron (always centre, pointing up)
    ctx.fillStyle = '#ffb340';
    ctx.beginPath();
    ctx.moveTo(c, c - 7);
    ctx.lineTo(c + 5, c + 6);
    ctx.lineTo(c, c + 3);
    ctx.lineTo(c - 5, c + 6);
    ctx.closePath();
    ctx.fill();

    // north tick on the rim
    const na = -heading - Math.PI / 2;
    ctx.fillStyle = 'rgba(125, 255, 168, 0.95)';
    ctx.font = `700 10px 'Chakra Petch', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', c + Math.cos(na) * (c - 11), c + Math.sin(na) * (c - 11));
  }
}
