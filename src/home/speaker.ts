import type {Member, MemberRole} from './types.js';

/**
 * One identity hint from an upstream system. This library does NOT do voice or face recognition;
 * it fuses the scores those models produce and decides whether the speaker is known well enough.
 */
export type IdentitySignal = {
  source: 'voice' | 'face' | 'device' | 'self_introduction' | 'manual';
  /** Candidate member id (voice/face/device models usually return this). */
  memberId?: string;
  /** Name as heard ("I'm Tom"); resolved against display names and aliases. */
  name?: string;
  /** Upstream model score, 0–1. */
  score: number;
};

export type SpeakerResolution = {
  status: 'identified' | 'ambiguous' | 'unknown';
  memberId: string | null;
  role: MemberRole | null;
  /** Fused confidence of the chosen (or best) candidate, 0–1. */
  confidence: number;
  candidates: Array<{memberId: string; confidence: number}>;
};

export type SpeakerPolicy = {
  /** Reliability multiplier per source before fusion. */
  sourceWeights: Record<IdentitySignal['source'], number>;
  /** Fused confidence needed to treat the speaker as identified. */
  threshold: number;
  /** Required lead over the second-best candidate. */
  margin: number;
};

export const DEFAULT_SPEAKER_POLICY: SpeakerPolicy = {
  sourceWeights: {manual: 1, device: 0.95, face: 0.9, voice: 0.8, self_introduction: 0.6},
  threshold: 0.75,
  margin: 0.15,
};

export const UNKNOWN_SPEAKER: SpeakerResolution = {status: 'unknown', memberId: null, role: null, confidence: 0, candidates: []};

const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();

/** Find members whose display name or alias matches `name` exactly (case-insensitive). */
export function findMembersByName(members: Member[], name: string): Member[] {
  const n = norm(name);
  if (!n) return [];
  return members.filter(m => norm(m.displayName) === n || m.aliases.some(a => norm(a) === n));
}

/**
 * Fuse identity signals with a weighted noisy-OR per candidate:
 * P(member) = 1 − Π(1 − weight_source × score). Independent agreeing signals raise confidence;
 * one weak signal alone stays below the threshold.
 */
export function resolveSpeaker(
  members: Member[],
  signals: IdentitySignal[],
  policy: SpeakerPolicy = DEFAULT_SPEAKER_POLICY,
): SpeakerResolution {
  const known = new Map(members.map(m => [m.id, m]));
  const miss = new Map<string, number>();

  for (const signal of signals) {
    if (!Number.isFinite(signal.score) || signal.score <= 0) continue;
    const score = Math.min(1, signal.score) * (policy.sourceWeights[signal.source] ?? 0);
    let ids: string[] = [];
    if (signal.memberId && known.has(signal.memberId)) ids = [signal.memberId];
    else if (signal.name) ids = findMembersByName(members, signal.name).map(m => m.id);
    // A name shared by several members is split, not credited fully to each.
    const share = ids.length > 1 ? score / ids.length : score;
    for (const id of ids) miss.set(id, (miss.get(id) ?? 1) * (1 - share));
  }

  const candidates = [...miss.entries()]
    .map(([memberId, m]) => ({memberId, confidence: Math.round((1 - m) * 1000) / 1000}))
    .sort((a, b) => b.confidence - a.confidence);
  const top = candidates[0];
  if (!top) return {...UNKNOWN_SPEAKER};
  const second = candidates[1]?.confidence ?? 0;
  const member = known.get(top.memberId)!;

  if (top.confidence < policy.threshold) {
    return {status: 'unknown', memberId: null, role: null, confidence: top.confidence, candidates};
  }
  if (top.confidence - second < policy.margin) {
    return {status: 'ambiguous', memberId: null, role: null, confidence: top.confidence, candidates};
  }
  return {status: 'identified', memberId: member.id, role: member.role, confidence: top.confidence, candidates};
}

/** Treat an explicit, already-authenticated member (e.g. logged into the companion app) as identified. */
export function identifiedAs(member: Member, confidence = 1): SpeakerResolution {
  return {status: 'identified', memberId: member.id, role: member.role, confidence, candidates: [{memberId: member.id, confidence}]};
}

export type MemoryAccess = {
  /** Read/write this member's personal memory (persona facts, story, pins). */
  personal: 'none' | 'read_write';
  /** Read household-shared facts. */
  householdRead: boolean;
  /** Add household facts, places and object locations by telling the robot. */
  householdWrite: boolean;
  /** Change members, places or safety tags. */
  administer: boolean;
};

/**
 * Default access rules. Unknown or ambiguous speakers get household read-only access and nothing personal,
 * so a visitor cannot read or overwrite a family member's memory by claiming their name.
 */
export function memoryAccessFor(speaker: SpeakerResolution): MemoryAccess {
  if (speaker.status !== 'identified' || !speaker.role) {
    return {personal: 'none', householdRead: true, householdWrite: false, administer: false};
  }
  switch (speaker.role) {
    case 'owner':
      return {personal: 'read_write', householdRead: true, householdWrite: true, administer: true};
    case 'adult':
    case 'caregiver':
      return {personal: 'read_write', householdRead: true, householdWrite: true, administer: false};
    case 'child':
      return {personal: 'read_write', householdRead: true, householdWrite: true, administer: false};
    case 'guest':
      return {personal: 'none', householdRead: true, householdWrite: false, administer: false};
  }
}
