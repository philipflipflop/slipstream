/**
 * Flight-plan route: an ordered list of waypoints with leg geometry
 * (true heading, distance, ETE) and sequencing as the aircraft passes
 * each fix. Pure math — no DOM/three — so it is unit-testable.
 */
import { wrapAngle } from '../core/math';

export interface Waypoint {
  x: number;
  z: number;
  name: string;
  /** set when the waypoint is an airfield (enables runway info display) */
  airfield?: { code: string; heading: number; elev: number; length: number };
}

export interface LegInfo {
  from: string;
  to: string;
  distance: number;   // m
  bearing: number;    // rad, true, clockwise from north
  eteSec: number | null; // at the supplied groundspeed; null when GS ~ 0
}

/** True bearing (rad, clockwise from north, north = -Z) from a to b. */
export function bearingTo(ax: number, az: number, bx: number, bz: number): number {
  return Math.atan2(bx - ax, -(bz - az));
}

export function distanceTo(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(bx - ax, bz - az);
}

const CAPTURE_RADIUS = 1500; // m — generous fix passage detection

export class Route {
  waypoints: Waypoint[] = [];
  active = 0;          // index of the waypoint currently being flown to
  engaged = false;     // NAV mode: autopilot steered along the route

  get isEmpty(): boolean { return this.waypoints.length === 0; }
  get complete(): boolean { return this.active >= this.waypoints.length; }

  add(wp: Waypoint): void {
    this.waypoints.push(wp);
  }

  removeLast(): void {
    this.waypoints.pop();
    if (this.active > this.waypoints.length) this.active = this.waypoints.length;
  }

  clear(): void {
    this.waypoints.length = 0;
    this.active = 0;
    this.engaged = false;
  }

  /** Restart sequencing from the first fix (e.g. when engaging NAV). */
  arm(): void {
    this.active = 0;
  }

  target(): Waypoint | null {
    return this.complete ? null : this.waypoints[this.active];
  }

  /**
   * Advance sequencing when the aircraft passes the active fix.
   * Returns the waypoint just sequenced, or null.
   */
  sequence(px: number, pz: number): Waypoint | null {
    const t = this.target();
    if (!t) return null;
    if (distanceTo(px, pz, t.x, t.z) < CAPTURE_RADIUS) {
      this.active++;
      return t;
    }
    return null;
  }

  /** Desired track to the active fix (rad), or null when route is done. */
  desiredHeading(px: number, pz: number): number | null {
    const t = this.target();
    if (!t) return null;
    return wrapAngle(bearingTo(px, pz, t.x, t.z));
  }

  /**
   * Per-leg breakdown for the flight computer: current position → wp1 → …
   * Distances in metres, ETE at the given groundspeed.
   */
  legs(px: number, pz: number, gs: number): LegInfo[] {
    const out: LegInfo[] = [];
    let fx = px;
    let fz = pz;
    let fromName = 'PPOS';
    for (let i = this.active; i < this.waypoints.length; i++) {
      const wp = this.waypoints[i];
      const d = distanceTo(fx, fz, wp.x, wp.z);
      out.push({
        from: fromName,
        to: wp.name,
        distance: d,
        bearing: ((bearingTo(fx, fz, wp.x, wp.z) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
        eteSec: gs > 2 ? d / gs : null,
      });
      fx = wp.x;
      fz = wp.z;
      fromName = wp.name;
    }
    return out;
  }

  totalDistance(px: number, pz: number): number {
    let sum = 0;
    for (const leg of this.legs(px, pz, 0)) sum += leg.distance;
    return sum;
  }
}
