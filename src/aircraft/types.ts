export type EngineKind = 'prop' | 'jet';

export interface AircraftSpec {
  id: string;
  name: string;
  reg: string;
  role: string;
  blurb: string;
  engine: EngineKind;

  /** 0..1 bars for the hangar UI */
  stats: { speed: number; agility: number; handling: number; climb: number };
  topSpeedKt: number;

  // --- physics ---
  mass: number;       // kg
  wingArea: number;   // m²
  aspect: number;     // wing aspect ratio
  cl0: number;        // lift coefficient at zero AoA
  clSlope: number;    // dCL/dα, per radian
  stallAoA: number;   // radians
  cd0: number;        // parasitic drag
  maxThrust: number;  // N at sea level, full throttle
  afterburner?: number; // thrust multiplier at 100% throttle
  propFalloff: number;  // 0..1, how much thrust fades toward vne (props high, jets low)

  pitchRate: number;  // rad/s authority
  rollRate: number;
  yawRate: number;
  stability: number;  // weathervane/static stability multiplier

  flapsCl: number;
  flapsCd: number;
  gearCd: number;
  retractableGear: boolean;
  gearHeight: number;   // CG height above ground on wheels, m
  groundPitch: number;  // resting pitch attitude on gear, radians (tail-draggers sit nose-high)
  vne: number;          // never-exceed, m/s

  // --- camera/visual ---
  chaseDist: number;
  chaseHeight: number;
  cockpit: { x: number; y: number; z: number };
}
