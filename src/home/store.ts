import type {
  Episode,
  EpisodeQuery,
  HomeKey,
  Member,
  ObjectEntity,
  ObjectSighting,
  Place,
} from './types.js';

export type MemberInput = Omit<Member, 'createdAt' | 'updatedAt'>;
export type ObjectInput = Omit<ObjectEntity, 'createdAt' | 'updatedAt'>;

/**
 * Persistence for household memory. Implementations: `InMemoryHomeStore`, `SqlHomeStore`.
 * Upserts are keyed by the caller-provided id so robot systems can keep their own ids.
 */
export interface HomeStore {
  upsertMember(key: HomeKey, member: MemberInput): Promise<Member>;
  listMembers(key: HomeKey): Promise<Member[]>;

  upsertPlace(key: HomeKey, place: Place): Promise<Place>;
  listPlaces(key: HomeKey): Promise<Place[]>;
  removePlace(key: HomeKey, placeId: string): Promise<void>;

  upsertObject(key: HomeKey, object: ObjectInput): Promise<ObjectEntity>;
  listObjects(key: HomeKey): Promise<ObjectEntity[]>;
  removeObject(key: HomeKey, objectId: string): Promise<void>;

  addSighting(key: HomeKey, sighting: Omit<ObjectSighting, 'id'>): Promise<ObjectSighting>;
  /** Newest first. */
  listSightings(key: HomeKey, objectId: string, options?: {since?: number; limit?: number}): Promise<ObjectSighting[]>;

  addEpisode(key: HomeKey, episode: Omit<Episode, 'id'>): Promise<Episode>;
  updateEpisode(key: HomeKey, episodeId: string, patch: Partial<Pick<Episode, 'endedAt' | 'summary' | 'importance' | 'data'>>): Promise<void>;
  queryEpisodes(key: HomeKey, query: EpisodeQuery): Promise<Episode[]>;

  /** Retention: drop sightings older than `before`, and episodes older than `before` below `keepImportanceAtLeast`. */
  prune(key: HomeKey, options: {sightingsBefore?: number; episodesBefore?: number; keepImportanceAtLeast?: number}): Promise<{sightings: number; episodes: number}>;

  /**
   * Right-to-be-forgotten for one member: delete the member, sightings they reported,
   * episodes where they are the only actor; remove them from other episodes and object ownership.
   */
  forgetMember(key: HomeKey, memberId: string): Promise<void>;

  /** Delete everything for this home. */
  clearHome(key: HomeKey): Promise<void>;
}

export const DEFAULT_EPISODE_LIMIT = 50;
export const MAX_EPISODE_LIMIT = 500;

export function episodeLimit(query: EpisodeQuery): number {
  return Math.min(MAX_EPISODE_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_EPISODE_LIMIT)));
}

/** Shared in-process filter so both stores answer queries identically. */
export function matchesEpisodeQuery(e: Episode, q: EpisodeQuery): boolean {
  if (q.from != null && (e.endedAt ?? e.startedAt) < q.from) return false;
  if (q.to != null && e.startedAt > q.to) return false;
  if (q.kinds?.length && !q.kinds.includes(e.kind)) return false;
  if (q.labels?.length && !q.labels.includes(e.label)) return false;
  if (q.actorId && !e.actorIds.includes(q.actorId)) return false;
  if (q.placeId && e.placeId !== q.placeId) return false;
  if (q.objectId && !e.objectIds.includes(q.objectId)) return false;
  if (q.text && !e.summary.toLowerCase().includes(q.text.toLowerCase())) return false;
  return true;
}
