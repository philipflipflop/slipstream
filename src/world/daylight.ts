/**
 * Time-of-day presets. Everything visual reads its palette from here:
 * sky dome, sun/moon disc, scene lights, fog, water, clouds, city window
 * glow and the aircraft landing light. Applied at boot (changing time of
 * day reloads, same as changing worlds).
 */

export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';

export interface DaylightPreset {
  id: TimeOfDay;
  name: string;
  desc: string;
  /** direction TOWARD the light source (sun, or the moon at night) */
  sunDir: [number, number, number];
  zenith: number;
  horizon: number;       // horizon band = fog colour (seamless melt)
  groundGlow: number;    // below-horizon dome ≈ fog (≪1 makes the far shell's
                         // fogged edge visible as a colour step at altitude)
  discColor: number;     // sun/moon disc
  discBoost: number;     // disc brightness (moon is far dimmer than sun)
  glowColor: [number, number, number]; // haze around the disc
  glowAmt: number;
  sunColor: number;      // directional light
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  stars: number;         // 0..1 star field visibility
  windowGlow: number;    // 0..1 emissive city windows / tower beacons
  cloudTint: number;
  cloudOpacity: number;  // scale on the sprites' base opacity
  waterShallow: number;
  waterDeep: number;
  glint: [number, number, number]; // specular sparkle colour on water
  /** near-field wave-crest glitter (1 by day; ~0.1 at night or a black sea
   *  renders a glowing dot grid instead of moonlight) */
  glintNear: number;
  landingLight: boolean; // aircraft carry a working landing light
}

export const DAYLIGHTS: DaylightPreset[] = [
  {
    id: 'dawn',
    name: 'Dawn Patrol',
    desc: 'First light in the east, mist-pink haze',
    sunDir: [0.72, 0.1, -0.42],
    zenith: 0x46589e,
    horizon: 0xeec0a4,
    groundGlow: 0.96,
    discColor: 0xffd9a8,
    discBoost: 5,
    glowColor: [1.0, 0.5, 0.25],
    glowAmt: 0.65,
    sunColor: 0xffd2a0,
    sunIntensity: 1.7,
    hemiSky: 0xc9b3c9,
    hemiGround: 0x4c4650,
    hemiIntensity: 0.55,
    stars: 0.12,
    windowGlow: 0.45,
    cloudTint: 0xffd9c4,
    cloudOpacity: 0.9,
    waterShallow: 0x3a7f96,
    waterDeep: 0x0a2c46,
    glint: [1.0, 0.72, 0.5],
    glintNear: 0.55,
    landingLight: true,
  },
  {
    id: 'day',
    name: 'High Noon',
    desc: 'Clear blue, unlimited visibility',
    sunDir: [0.42, 0.46, -0.55],
    zenith: 0x2c63b8,
    horizon: 0xc6d3e0,
    groundGlow: 0.97,
    discColor: 0xfff2cc,
    discBoost: 6,
    glowColor: [1.0, 0.55, 0.22],
    glowAmt: 0.42,
    sunColor: 0xfff1d6,
    sunIntensity: 2.4,
    hemiSky: 0xbcd3f5,
    hemiGround: 0x57604c,
    hemiIntensity: 0.75,
    stars: 0,
    windowGlow: 0,
    cloudTint: 0xffffff,
    cloudOpacity: 1,
    waterShallow: 0x2e8c9e,
    waterDeep: 0x0a3550,
    glint: [1.0, 0.92, 0.75],
    glintNear: 1,
    landingLight: false,
  },
  {
    id: 'dusk',
    name: 'Golden Hour',
    desc: 'Low sun in the west, long amber light',
    sunDir: [-0.78, 0.13, 0.25],
    zenith: 0x2b3060,
    horizon: 0xdd8d5c,
    groundGlow: 0.95,
    discColor: 0xffb36b,
    discBoost: 5,
    glowColor: [1.0, 0.42, 0.18],
    glowAmt: 0.85,
    sunColor: 0xffb377,
    sunIntensity: 1.6,
    hemiSky: 0x9a86ab,
    hemiGround: 0x3c3438,
    hemiIntensity: 0.58,
    stars: 0.3,
    windowGlow: 0.85,
    cloudTint: 0xffb894,
    cloudOpacity: 0.85,
    waterShallow: 0x3b6f86,
    waterDeep: 0x0a2740,
    glint: [1.0, 0.6, 0.35],
    glintNear: 0.4,
    landingLight: true,
  },
  {
    id: 'night',
    name: 'Full Moon',
    desc: 'Starfield, moonlit water, city lights',
    sunDir: [0.35, 0.55, 0.35],
    zenith: 0x04070f,
    horizon: 0x0e1726,
    groundGlow: 0.96,
    discColor: 0xeef3ff,
    discBoost: 2.4,
    glowColor: [0.55, 0.65, 0.9],
    glowAmt: 0.3,
    sunColor: 0x93aede,
    sunIntensity: 0.6,
    hemiSky: 0x1c2a4a,
    hemiGround: 0x0b0e13,
    hemiIntensity: 0.4,
    stars: 1,
    windowGlow: 1,
    cloudTint: 0x2b3a5c,
    cloudOpacity: 0.5,
    waterShallow: 0x14384a,
    waterDeep: 0x040f1c,
    // restrained: full-strength sparkle over a near-black sea reads as a
    // glittering dot grid, not moonlight
    glint: [0.5, 0.6, 0.8],
    glintNear: 0.08,
    landingLight: true,
  },
];

export const daylightById = (id: string): DaylightPreset =>
  DAYLIGHTS.find((d) => d.id === id) ?? DAYLIGHTS[1];
