/**
 * Score bands + palette tokens.
 *
 * Oura's published bands: 85-100 Optimal, 70-84 Good, 60-69 Fair, 0-59 Pay attention.
 * All hues are Okabe-Ito derived (CVD-safe) and every band carries a text label so
 * colour is never the only signal.
 */

export type BandId = 'optimal' | 'good' | 'fair' | 'attention';

export interface Band {
    id: BandId;
    label: string;
    /** Inclusive lower bound. */
    min: number;
    light: string;
    dark: string;
    /** Darker variant that keeps >= 4.5:1 as TEXT on light surfaces (fills use `light`). */
    lightText: string;
    /** Glyph paired with the colour (never colour alone). */
    glyph: string;
}

export const BANDS: readonly Band[] = [
    { id: 'optimal', label: 'Optimal', min: 85, light: '#009E73', dark: '#3FC9A2', lightText: '#007A59', glyph: '●' },
    { id: 'good', label: 'Good', min: 70, light: '#0072B2', dark: '#5AA9E6', lightText: '#0072B2', glyph: '◐' },
    { id: 'fair', label: 'Fair', min: 60, light: '#E69F00', dark: '#F2B84B', lightText: '#9A6400', glyph: '○' },
    { id: 'attention', label: 'Pay attention', min: 0, light: '#D55E00', dark: '#F07F3C', lightText: '#B24E00', glyph: '▲' },
] as const;

/** Band for a 0-100 score, or null when the score is missing. */
export function getBand(score: number | null | undefined): Band | null {
    if (score === null || score === undefined || !Number.isFinite(score)) return null;
    return BANDS.find(b => score >= b.min) ?? BANDS[BANDS.length - 1];
}

export function bandColor(band: Band | null, isDark: boolean): string {
    if (!band) return isDark ? '#6b7280' : '#9ca3af';
    return isDark ? band.dark : band.light;
}

/** Band colour safe for text (>= 4.5:1 on the theme's surfaces). */
export function bandTextColor(band: Band | null, isDark: boolean): string {
    if (!band) return isDark ? '#a1a1aa' : '#62626b';
    return isDark ? band.dark : band.lightText;
}

/** Colour for a score in the current theme (neutral grey when missing). */
export function scoreColor(score: number | null | undefined, isDark: boolean): string {
    return bandColor(getBand(score), isDark);
}

export function scoreLabel(score: number | null | undefined): string {
    return getBand(score)?.label ?? 'No score';
}

/** Hypnogram stage palette (Okabe-Ito). */
export const STAGE_COLORS = {
    deep: '#0072B2',
    light: '#56B4E9',
    rem: '#CC79A7',
    awake: '#E69F00',
} as const;

/** Okabe-Ito series palette for multi-line charts. */
export const SERIES_PALETTE = [
    '#0072B2', // blue
    '#D55E00', // vermillion
    '#009E73', // green
    '#CC79A7', // purple
    '#E69F00', // orange
    '#56B4E9', // sky
    '#F0E442', // yellow
] as const;

/** Neutral track/grid colours for charts. */
export const CHART_NEUTRAL = {
    trackDark: '#2a2a31',
    trackLight: '#e4e4e7',
    tickDark: '#a1a1aa',
    tickLight: '#62626b',
} as const;

/** Append an alpha (0-1) to a `#rrggbb` colour. */
export function withAlpha(hex: string, alpha: number): string {
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
    return `${hex}${a}`;
}
