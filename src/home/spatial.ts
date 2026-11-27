import type {ObjectEntity, ObjectSighting, Place, Provenance} from './types.js';

const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const POSSESSIVE = /^(?:my|our|the|a|an|his|her|their)\s+/;

/** Light singularization so "keys" matches "key". */
const singular = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

function nameScore(query: string, names: string[]): number {
  const q = norm(query).replace(POSSESSIVE, '');
  if (!q) return 0;
  const qs = q.split(' ').map(singular).join(' ');
  let best = 0;
  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    const ns = n.split(' ').map(singular).join(' ');
    if (n === q || ns === qs) return 1;
    if (ns.includes(qs) || qs.includes(ns)) best = Math.max(best, 0.7);
    else {
      const qt = new Set(qs.split(' '));
      const nt = ns.split(' ');
      const shared = nt.filter(t => qt.has(t)).length;
      if (shared) best = Math.max(best, 0.5 * (shared / Math.max(qt.size, nt.length)));
    }
  }
  return best;
}

export type ObjectMatch = {object: ObjectEntity; score: number};

/**
 * Resolve "my keys" / "the blue mug" to known objects. Objects owned by the speaker win ties
 * when the query is possessive ("my ...").
 */
export function resolveObject(objects: ObjectEntity[], query: string, options: {speakerId?: string | null} = {}): ObjectMatch[] {
  const possessive = /^\s*my\s/i.test(query);
  return objects
    .map(object => {
      let score = nameScore(query, [object.name, ...object.aliases]);
      if (score > 0 && possessive && options.speakerId) {
        if (object.ownerId === options.speakerId) score += 0.2;
        else if (object.ownerId) score -= 0.3;
      }
      return {object, score: Math.max(0, Math.min(1.2, score))};
    })
    .filter(m => m.score >= 0.35)
    .sort((a, b) => b.score - a.score);
}

export function resolvePlace(places: Place[], query: string): Place | null {
  let best: Place | null = null;
  let bestScore = 0;
  for (const place of places) {
    const score = nameScore(query, [place.name, ...place.aliases]);
    if (score > bestScore) {
      best = place;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

/** "Kitchen › Left cabinet". Guards against parent cycles. */
export function placePath(places: Place[], placeId: string): string {
  const byId = new Map(places.map(p => [p.id, p]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(placeId);
  while (current && !seen.has(current.id) && current.kind !== 'home') {
    seen.add(current.id);
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return parts.join(' › ') || (byId.get(placeId)?.name ?? placeId);
}

export type SpatialPolicy = {
  /** Confidence halves every this many seconds since the observation (things get moved). */
  halfLifeSec: number;
  /** Multiplier for reports a person made, relative to direct observation. */
  toldWeight: number;
  /** Multiplier for inferred locations. */
  inferredWeight: number;
  /** Window for habitual-location statistics. */
  habitWindowSec: number;
  habitMinSightings: number;
  /** Share of sightings a place needs to count as "usually here". */
  habitMinShare: number;
};

export const DEFAULT_SPATIAL_POLICY: SpatialPolicy = {
  halfLifeSec: 3 * 24 * 3600,
  toldWeight: 0.8,
  inferredWeight: 0.5,
  habitWindowSec: 60 * 24 * 3600,
  habitMinSightings: 3,
  habitMinShare: 0.5,
};

export type LocationBelief = {
  placeId: string;
  /** Decayed confidence that the object is there right now, 0–1. */
  confidence: number;
  lastSeenAt: number;
  ageSec: number;
  provenance: Provenance;
};

function baseWeight(p: Provenance, policy: SpatialPolicy): number {
  switch (p.kind) {
    case 'observed':
    case 'configured':
      return 1;
    case 'told':
      return policy.toldWeight;
    case 'inferred':
      return policy.inferredWeight;
  }
}

/** Current belief from the latest sighting, decayed by age. `sightings` may be in any order. */
export function currentLocation(sightings: ObjectSighting[], now: number, policy: SpatialPolicy = DEFAULT_SPATIAL_POLICY): LocationBelief | null {
  const latest = [...sightings].sort((a, b) => b.at - a.at)[0];
  if (!latest) return null;
  const ageSec = Math.max(0, now - latest.at);
  const decay = Math.pow(0.5, ageSec / policy.halfLifeSec);
  const confidence = Math.round(latest.provenance.confidence * baseWeight(latest.provenance, policy) * decay * 1000) / 1000;
  return {placeId: latest.placeId, confidence, lastSeenAt: latest.at, ageSec, provenance: latest.provenance};
}

export type HabitualLocation = {placeId: string; share: number; sightings: number};

/** Where the object usually is ("cups are usually in the left cabinet"), from recent history. */
export function habitualLocation(sightings: ObjectSighting[], now: number, policy: SpatialPolicy = DEFAULT_SPATIAL_POLICY): HabitualLocation | null {
  const recent = sightings.filter(s => s.at >= now - policy.habitWindowSec);
  if (recent.length < policy.habitMinSightings) return null;
  const counts = new Map<string, number>();
  for (const s of recent) counts.set(s.placeId, (counts.get(s.placeId) ?? 0) + 1);
  const [placeId, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const share = count / recent.length;
  return share >= policy.habitMinShare ? {placeId, share: Math.round(share * 100) / 100, sightings: recent.length} : null;
}

/**
 * Parse simple English placement statements: "I put my keys on the hall table",
 * "the vitamins are in the kitchen drawer". Returns null when not a placement.
 * For other languages, do this in your NLU and call the ingest API with labels directly.
 */
export function parsePlacementStatement(text: string): {objectLabel: string; placeLabel: string} | null {
  const t = text.trim().replace(/[.!?]+$/, '');
  const patterns = [
    /\b(?:i|we)\s+(?:just\s+)?(?:put|left|placed|moved|keep|stored|hid)\s+(.+?)\s+(?:on|in|into|onto|under|inside|behind|next to|by|at)\s+(.+)$/i,
    /\b(?:the|my|our)\s+(.+?)\s+(?:is|are)\s+(?:now\s+)?(?:on|in|under|inside|behind|next to|by|at)\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1] && m[2]) {
      const objectLabel = m[1].trim();
      const placeLabel = m[2].replace(/^(?:the|my|our)\s+/i, '').trim();
      if (objectLabel && placeLabel && objectLabel.split(' ').length <= 6) return {objectLabel, placeLabel};
    }
  }
  return null;
}
