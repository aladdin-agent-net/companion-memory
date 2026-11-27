import {placePath} from './spatial.js';
import type {Episode, Member, Place} from './types.js';

export type RelativeRange = 'today' | 'yesterday' | 'last_24h' | 'this_week' | 'last_7_days' | 'last_30_days';

/**
 * Resolve a relative range to unix seconds in the home's local time.
 * `utcOffsetMinutes` is the home's offset (e.g. 480 for UTC+8). Weeks start on Monday.
 */
export function relativeRange(range: RelativeRange, now: number, utcOffsetMinutes = 0): {from: number; to: number} {
  const offset = utcOffsetMinutes * 60;
  const local = now + offset;
  const startOfToday = Math.floor(local / 86400) * 86400 - offset;
  switch (range) {
    case 'today':
      return {from: startOfToday, to: now};
    case 'yesterday':
      return {from: startOfToday - 86400, to: startOfToday - 1};
    case 'last_24h':
      return {from: now - 86400, to: now};
    case 'this_week': {
      const dayOfWeek = (new Date(local * 1000).getUTCDay() + 6) % 7; // Monday = 0
      return {from: startOfToday - dayOfWeek * 86400, to: now};
    }
    case 'last_7_days':
      return {from: now - 7 * 86400, to: now};
    case 'last_30_days':
      return {from: now - 30 * 86400, to: now};
  }
}

/** "2026-11-26 09:12" in the home's local time. */
export function formatLocalTime(at: number, utcOffsetMinutes = 0): string {
  return new Date((at + utcOffsetMinutes * 60) * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** "3 days ago", "2 hours ago", "just now". */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return 'just now';
  const units: Array<[number, string]> = [
    [86400 * 30, 'month'],
    [86400 * 7, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/** One line per episode for prompts and logs: "2026-11-26 09:12 · mop_floor · Kitchen · Robot: Mopped the kitchen". */
export function describeEpisode(e: Episode, ctx: {members: Member[]; places: Place[]; utcOffsetMinutes?: number}): string {
  const names = new Map(ctx.members.map(m => [m.id, m.displayName]));
  const actors = e.actorIds.map(id => names.get(id) ?? id).join(', ');
  const parts = [formatLocalTime(e.startedAt, ctx.utcOffsetMinutes), e.label];
  if (e.placeId) parts.push(placePath(ctx.places, e.placeId));
  return `${parts.join(' · ')} · ${actors ? `${actors}: ` : ''}${e.summary}`;
}

export function clampImportance(value: number | undefined, fallback = 0.3): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}
