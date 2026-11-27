/**
 * Household / embodied memory model.
 *
 * Everything is scoped by `homeId`. Per-member conversational memory (persona facts, story, pins)
 * stays in the core engine under key `{userId: memberId, agentId: robotId}`.
 * All timestamps are unix seconds.
 */

export type HomeKey = {homeId: string};

/**
 * Where a piece of memory came from. Safety decisions depend on this:
 * something a camera saw an hour ago is very different from something a child said last week.
 */
export type Provenance = {
  kind: 'observed' | 'told' | 'inferred' | 'configured';
  /** Member id for `told`, sensor / device id for `observed`. */
  sourceId?: string;
  /** e.g. camera, microphone, lidar, app, manual. */
  sensor?: string;
  /** 0–1. */
  confidence: number;
  at: number;
};

export type MemberRole = 'owner' | 'adult' | 'child' | 'guest' | 'caregiver';

export type Member = {
  id: string;
  displayName: string;
  role: MemberRole;
  /** Names the member may introduce themselves with ("Dad", "Tom"). */
  aliases: string[];
  createdAt: number;
  updatedAt: number;
};

export type PlaceKind = 'home' | 'floor' | 'room' | 'area' | 'furniture' | 'container';

export type Place = {
  id: string;
  name: string;
  kind: PlaceKind;
  parentId?: string;
  aliases: string[];
  /** Optional link to the robot's map frame (pose, zone id, ...). Opaque to this library. */
  mapRef?: string;
};

export const SAFETY_TAGS = [
  'medication',
  'allergen',
  'hazardous',
  'sharp',
  'child_restricted',
  'fragile',
  'valuable',
  'food',
] as const;
export type SafetyTag = (typeof SAFETY_TAGS)[number];

export type ObjectEntity = {
  id: string;
  name: string;
  category?: string;
  aliases: string[];
  /** Member who owns it ("my keys"). */
  ownerId?: string;
  safetyTags: SafetyTag[];
  createdAt: number;
  updatedAt: number;
};

/** One observation or report that an object was at a place. */
export type ObjectSighting = {
  id: string;
  objectId: string;
  placeId: string;
  at: number;
  provenance: Provenance;
};

export const EPISODE_KINDS = ['activity', 'task', 'conversation', 'presence', 'event'] as const;
export type EpisodeKind = (typeof EPISODE_KINDS)[number];

export type EpisodeData = Record<string, string | number | boolean>;

/** Something that happened, on a timeline. */
export type Episode = {
  id: string;
  kind: EpisodeKind;
  /** Canonical, machine-friendly label, e.g. `mop_floor`, `took_medication`, `arrived_home`. */
  label: string;
  summary: string;
  actorIds: string[];
  placeId?: string;
  objectIds: string[];
  startedAt: number;
  endedAt?: number;
  /** 0–1; important episodes survive retention pruning. */
  importance: number;
  provenance: Provenance;
  data?: EpisodeData;
};

export type EpisodeQuery = {
  from?: number;
  to?: number;
  kinds?: EpisodeKind[];
  labels?: string[];
  actorId?: string;
  placeId?: string;
  objectId?: string;
  /** Case-insensitive substring match on summary. */
  text?: string;
  /** Default 50, max 500. */
  limit?: number;
  /** Default newest first. */
  order?: 'asc' | 'desc';
};
