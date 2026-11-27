import {describe, expect, it} from 'vitest';
import {
  assessAction,
  currentLocation,
  formatAgo,
  habitualLocation,
  memoryAccessFor,
  parsePlacementStatement,
  placePath,
  relativeRange,
  resolveObject,
  resolvePlace,
  resolveSpeaker,
  UNKNOWN_SPEAKER,
  type Member,
  type ObjectEntity,
  type ObjectSighting,
  type Place,
  type SpeakerResolution,
} from '../src/index.js';

const member = (id: string, role: Member['role'], displayName: string, aliases: string[] = []): Member => ({
  id,
  role,
  displayName,
  aliases,
  createdAt: 0,
  updatedAt: 0,
});
const members = [member('dad', 'owner', 'Tom', ['Dad']), member('kid', 'child', 'Lily'), member('tom2', 'guest', 'Tom')];

describe('resolveSpeaker', () => {
  it('identifies a member when independent signals agree', () => {
    const r = resolveSpeaker(members, [
      {source: 'voice', memberId: 'kid', score: 0.7},
      {source: 'face', memberId: 'kid', score: 0.8},
    ]);
    expect(r).toMatchObject({status: 'identified', memberId: 'kid', role: 'child'});
    expect(r.confidence).toBeGreaterThan(0.85);
  });

  it('keeps a single weak signal unknown', () => {
    expect(resolveSpeaker(members, [{source: 'voice', memberId: 'kid', score: 0.6}]).status).toBe('unknown');
  });

  it('splits a shared name instead of trusting a self-introduction', () => {
    const r = resolveSpeaker(members, [{source: 'self_introduction', name: 'tom', score: 1}]);
    expect(r.status).toBe('unknown');
    expect(r.candidates.map(c => c.memberId).sort()).toEqual(['dad', 'tom2']);
  });

  it('reports ambiguity when two members score close', () => {
    const r = resolveSpeaker(members, [
      {source: 'voice', memberId: 'dad', score: 0.98},
      {source: 'face', memberId: 'tom2', score: 0.95},
    ]);
    expect(r.status).toBe('ambiguous');
    expect(r.memberId).toBeNull();
  });

  it('ignores unknown member ids and invalid scores', () => {
    expect(resolveSpeaker(members, [{source: 'device', memberId: 'ghost', score: 1}, {source: 'face', memberId: 'dad', score: Number.NaN}]).status).toBe('unknown');
  });

  it('gives unknown speakers household read-only access', () => {
    expect(memoryAccessFor(UNKNOWN_SPEAKER)).toEqual({personal: 'none', householdRead: true, householdWrite: false, administer: false});
    const owner: SpeakerResolution = {status: 'identified', memberId: 'dad', role: 'owner', confidence: 1, candidates: []};
    expect(memoryAccessFor(owner).administer).toBe(true);
  });
});

const places: Place[] = [
  {id: 'home', name: 'Home', kind: 'home', aliases: []},
  {id: 'kitchen', name: 'Kitchen', kind: 'room', parentId: 'home', aliases: []},
  {id: 'cab', name: 'Left cabinet', kind: 'furniture', parentId: 'kitchen', aliases: ['cupboard']},
  {id: 'hall', name: 'Hall table', kind: 'furniture', aliases: ['entry table']},
];
const objects: ObjectEntity[] = [
  {id: 'k1', name: 'Keys', aliases: ['car keys'], ownerId: 'dad', safetyTags: [], createdAt: 0, updatedAt: 0},
  {id: 'k2', name: 'Keys', aliases: [], ownerId: 'kid', safetyTags: [], createdAt: 0, updatedAt: 0},
  {id: 'mug', name: 'Blue mug', aliases: [], safetyTags: ['fragile'], createdAt: 0, updatedAt: 0},
];

describe('spatial resolution', () => {
  it('prefers the speaker’s own object for possessive queries', () => {
    expect(resolveObject(objects, 'my keys', {speakerId: 'kid'})[0]!.object.id).toBe('k2');
    expect(resolveObject(objects, 'my keys', {speakerId: 'dad'})[0]!.object.id).toBe('k1');
    expect(resolveObject(objects, 'the blue mug')[0]!.object.id).toBe('mug');
    expect(resolveObject(objects, 'umbrella')).toEqual([]);
  });

  it('resolves places by name or alias and renders paths', () => {
    expect(resolvePlace(places, 'the cupboard')?.id).toBe('cab');
    expect(resolvePlace(places, 'garage')).toBeNull();
    expect(placePath(places, 'cab')).toBe('Kitchen › Left cabinet');
  });

  it('survives parent cycles when rendering paths', () => {
    const cyclic: Place[] = [
      {id: 'a', name: 'A', kind: 'room', parentId: 'b', aliases: []},
      {id: 'b', name: 'B', kind: 'room', parentId: 'a', aliases: []},
    ];
    expect(placePath(cyclic, 'a')).toBe('B › A');
  });

  it('parses English placement statements', () => {
    expect(parsePlacementStatement('I put my keys on the hall table.')).toEqual({objectLabel: 'my keys', placeLabel: 'hall table'});
    expect(parsePlacementStatement('The vitamins are in the left cabinet')).toEqual({objectLabel: 'vitamins', placeLabel: 'left cabinet'});
    expect(parsePlacementStatement('How was your day?')).toBeNull();
  });
});

const sighting = (placeId: string, at: number, kind: 'observed' | 'told' = 'observed', confidence = 1): ObjectSighting => ({
  id: `${placeId}-${at}`,
  objectId: 'mug',
  placeId,
  at,
  provenance: {kind, confidence, at},
});

describe('location belief', () => {
  const day = 86400;
  it('decays confidence with age and weights reports below observations', () => {
    expect(currentLocation([sighting('cab', 0)], 0)!.confidence).toBe(1);
    expect(currentLocation([sighting('cab', 0)], 3 * day)!.confidence).toBe(0.5);
    expect(currentLocation([sighting('cab', 0, 'told')], 0)!.confidence).toBe(0.8);
    expect(currentLocation([], 0)).toBeNull();
  });

  it('uses the latest sighting regardless of input order', () => {
    expect(currentLocation([sighting('hall', 10), sighting('cab', 5)], 10)!.placeId).toBe('hall');
  });

  it('finds the habitual place only with enough history', () => {
    const hist = [sighting('cab', 1), sighting('cab', 2), sighting('cab', 3), sighting('hall', 4)];
    expect(habitualLocation(hist, 10)).toEqual({placeId: 'cab', share: 0.75, sightings: 4});
    expect(habitualLocation(hist.slice(0, 2), 10)).toBeNull();
  });
});

describe('time helpers', () => {
  // 2026-11-25 (Wednesday) 10:00 UTC
  const now = Date.UTC(2026, 10, 25, 10, 0, 0) / 1000;
  it('computes local day boundaries with a UTC offset', () => {
    const utc8 = relativeRange('today', now, 480);
    expect(new Date(utc8.from * 1000).toISOString()).toBe('2026-11-24T16:00:00.000Z');
    const yesterday = relativeRange('yesterday', now, 0);
    expect(yesterday.to - yesterday.from).toBe(86399);
    expect(new Date(relativeRange('this_week', now, 0).from * 1000).toISOString()).toBe('2026-11-23T00:00:00.000Z');
  });

  it('formats relative ages', () => {
    expect(formatAgo(30)).toBe('just now');
    expect(formatAgo(7200)).toBe('2 hours ago');
    expect(formatAgo(86400)).toBe('1 day ago');
  });
});

describe('assessAction', () => {
  const now = 1_000_000;
  const owner: SpeakerResolution = {status: 'identified', memberId: 'dad', role: 'owner', confidence: 0.95, candidates: []};
  const child: SpeakerResolution = {...owner, memberId: 'kid', role: 'child'};
  const fresh = (kind: 'observed' | 'told' = 'observed', confidence = 0.95, age = 60) => ({
    kind: 'location' as const,
    description: 'the mug is in Kitchen',
    provenance: {kind, confidence, at: now - age},
  });

  it('allows low-risk actions on fresh observed memory', () => {
    expect(assessAction({action: 'fetch_object', requester: owner, evidence: [fresh()]}, now).decision).toBe('allow');
  });

  it('asks to confirm stale or low-confidence memory', () => {
    const stale = assessAction({action: 'fetch_object', risk: 'medium', evidence: [fresh('observed', 0.95, 10 * 86400)]}, now);
    expect(stale.decision).toBe('confirm');
    expect(stale.reasons[0]).toContain('stale');
    expect(stale.confirmPrompt).toContain('the mug is in Kitchen');
  });

  it('always re-verifies medication and requires an adult', () => {
    const d = assessAction({action: 'fetch_object', requester: owner, objectTags: ['medication'], evidence: [fresh()]}, now);
    expect(d).toMatchObject({decision: 'confirm', risk: 'critical', confirmBy: 'adult'});
  });

  it('denies high-risk requests from children and unidentified people', () => {
    expect(assessAction({action: 'fetch_object', requester: child, objectTags: ['sharp'], evidence: [fresh()]}, now).decision).toBe('deny');
    expect(assessAction({action: 'open_door', risk: 'high', requester: UNKNOWN_SPEAKER, evidence: []}, now).decision).toBe('deny');
  });

  it('does not accept hearsay for high-risk actions', () => {
    const d = assessAction({action: 'fetch_object', risk: 'high', requester: owner, evidence: [fresh('told')]}, now);
    expect(d.decision).toBe('confirm');
    expect(d.reasons.join(' ')).toContain('not directly observed');
  });

  it('flags high-risk actions with no evidence', () => {
    expect(assessAction({action: 'move_furniture', risk: 'high', evidence: []}, now).decision).toBe('confirm');
  });
});
