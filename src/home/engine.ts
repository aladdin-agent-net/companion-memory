import type {MemoryEngine, ExtractResult} from '../engine.js';
import {assertId, assertInput, assertTimestamp, assertUnitInterval, MemoryError} from '../errors.js';
import type {ChatTurn} from '../types.js';
import {clampImportance, describeEpisode, formatAgo, relativeRange, type RelativeRange} from './episodes.js';
import {assessAction, DEFAULT_SAFETY_POLICY, EMBODIED_MEMORY_RULES, type ActionRequest, type MemoryEvidence, type SafetyDecision, type SafetyPolicy} from './safety.js';
import {
  DEFAULT_SPEAKER_POLICY,
  memoryAccessFor,
  resolveSpeaker,
  type IdentitySignal,
  type SpeakerPolicy,
  type SpeakerResolution,
} from './speaker.js';
import {
  currentLocation,
  DEFAULT_SPATIAL_POLICY,
  habitualLocation,
  parsePlacementStatement,
  placePath,
  resolveObject,
  resolvePlace,
  type HabitualLocation,
  type LocationBelief,
  type SpatialPolicy,
} from './spatial.js';
import type {HomeStore, MemberInput, ObjectInput} from './store.js';
import {
  EPISODE_KINDS,
  SAFETY_TAGS,
  type Episode,
  type EpisodeData,
  type EpisodeKind,
  type EpisodeQuery,
  type HomeKey,
  type Member,
  type ObjectEntity,
  type Place,
  type PlaceKind,
  type Provenance,
  type SafetyTag,
} from './types.js';

const PLACE_KINDS: PlaceKind[] = ['home', 'floor', 'room', 'area', 'furniture', 'container'];
const ROLES = ['owner', 'adult', 'child', 'guest', 'caregiver'] as const;

/** Inputs from perception, speech and robot task systems. */
export type Observation =
  | {
      type: 'object_seen';
      object: {id?: string; label?: string; category?: string};
      place: {id?: string; label?: string};
      at: number;
      confidence: number;
      sensor?: string;
      sensorId?: string;
    }
  | {
      type: 'placement_told';
      speaker: SpeakerResolution;
      objectLabel: string;
      placeLabel: string;
      at: number;
    }
  | {
      type: 'activity';
      label: string;
      kind?: EpisodeKind;
      summary?: string;
      actorIds?: string[];
      placeId?: string;
      objectIds?: string[];
      startedAt: number;
      endedAt?: number;
      confidence?: number;
      importance?: number;
      sensor?: string;
      data?: EpisodeData;
    }
  | {type: 'person_seen'; signals: IdentitySignal[]; placeId?: string; at: number; sensor?: string}
  | {
      type: 'utterance';
      text: string;
      signals: IdentitySignal[];
      at: number;
      /** Conversation so far (ending with this utterance) for fact extraction. */
      turns?: ChatTurn[];
      userTurn?: number;
      threadId?: string;
    };

export type IngestResult =
  | {type: 'object_seen'; objectId: string; placeId: string; createdObject: boolean}
  | {type: 'placement_told'; objectId: string; placeId: string}
  | {type: 'activity'; episode: Episode}
  | {type: 'person_seen'; speaker: SpeakerResolution; episode: Episode | null}
  | {
      type: 'utterance';
      speaker: SpeakerResolution;
      placement: {objectId: string; placeId: string} | null;
      extract: ExtractResult | null;
      /** Why a placement in the text was not stored. */
      placementSkipped?: 'not_permitted' | 'unknown_object' | 'unknown_place';
    };

export type WhereIsAnswer =
  | {status: 'unknown_object'; answer: string}
  /** The object is sensitive and the speaker may not learn where it is. */
  | {status: 'withheld'; object: ObjectEntity; answer: string}
  | {status: 'never_seen'; object: ObjectEntity; answer: string}
  | {
      status: 'found';
      object: ObjectEntity;
      current: LocationBelief & {path: string};
      usual: (HabitualLocation & {path: string}) | null;
      /** Pass to `assessAction` if the robot acts on this location. */
      evidence: MemoryEvidence;
      answer: string;
    };

export type HomeMemoryOptions = {
  homeId: string;
  /** The agent id used for per-member conversational memory in the core engine. */
  robotId: string;
  /** Name the robot goes by in conversation; used for fact extraction. Defaults to `robotId`. */
  robotName?: string;
  store: HomeStore;
  /** Optional core engine for per-member and household facts. */
  memory?: MemoryEngine;
  now?: () => number;
  /** Home's offset from UTC in minutes (480 = UTC+8), used for "today" / "yesterday". */
  utcOffsetMinutes?: number;
  speakerPolicy?: SpeakerPolicy;
  spatialPolicy?: Partial<SpatialPolicy>;
  safetyPolicy?: Partial<SafetyPolicy>;
  /** Create objects the first time perception reports an unknown label. Default true. */
  autoCreateObjects?: boolean;
  /** Consecutive presence sightings closer than this extend one episode. Default 600 s. */
  presenceMergeSec?: number;
  /**
   * Locations of objects with these tags are not disclosed to children, guests or unidentified speakers.
   * Default: medication, hazardous, child_restricted, valuable.
   */
  restrictedDisclosureTags?: SafetyTag[];
};

const slug = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'object';

export function createHomeMemory(options: HomeMemoryOptions) {
  assertId(options.homeId, 'homeId');
  assertId(options.robotId, 'robotId');
  const {store, memory, robotId} = options;
  const key: HomeKey = {homeId: options.homeId};
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const tz = options.utcOffsetMinutes ?? 0;
  const speakerPolicy = options.speakerPolicy ?? DEFAULT_SPEAKER_POLICY;
  const spatialPolicy: SpatialPolicy = {...DEFAULT_SPATIAL_POLICY, ...options.spatialPolicy};
  const safetyPolicy: SafetyPolicy = {...DEFAULT_SAFETY_POLICY, ...options.safetyPolicy};
  const autoCreate = options.autoCreateObjects ?? true;
  const presenceMergeSec = options.presenceMergeSec ?? 600;
  const restrictedDisclosure = new Set<SafetyTag>(options.restrictedDisclosureTags ?? ['medication', 'hazardous', 'child_restricted', 'valuable']);
  const householdKey = {userId: `household:${options.homeId}`, agentId: robotId};
  const memberKey = (memberId: string) => ({userId: memberId, agentId: robotId});

  // ---------- members ----------
  async function upsertMember(input: MemberInput): Promise<Member> {
    assertId(input.id, 'member.id');
    assertInput(typeof input.displayName === 'string' && input.displayName.trim(), 'member.displayName is required');
    assertInput((ROLES as readonly string[]).includes(input.role), `member.role must be one of ${ROLES.join(', ')}`);
    assertInput(Array.isArray(input.aliases), 'member.aliases must be an array');
    return store.upsertMember(key, {...input, displayName: input.displayName.trim(), aliases: input.aliases.map(a => a.trim()).filter(Boolean)});
  }

  async function identify(signals: IdentitySignal[]): Promise<SpeakerResolution> {
    return resolveSpeaker(await store.listMembers(key), signals, speakerPolicy);
  }

  /** Delete everything the home and the core engine remember about one member. */
  async function forgetMember(memberId: string): Promise<void> {
    assertId(memberId, 'memberId');
    await store.forgetMember(key, memberId);
    if (memory) await memory.clear(memberKey(memberId));
  }

  // ---------- places & objects ----------
  async function upsertPlace(place: Place): Promise<Place> {
    assertId(place.id, 'place.id');
    assertInput(typeof place.name === 'string' && place.name.trim(), 'place.name is required');
    assertInput(PLACE_KINDS.includes(place.kind), `place.kind must be one of ${PLACE_KINDS.join(', ')}`);
    assertInput(Array.isArray(place.aliases), 'place.aliases must be an array');
    if (place.parentId) {
      const places = await store.listPlaces(key);
      const byId = new Map(places.map(p => [p.id, p]));
      if (!byId.has(place.parentId)) throw new MemoryError('unknown_place', `parent place ${place.parentId} does not exist`);
      for (let cur: Place | undefined = byId.get(place.parentId), hops = 0; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined, hops++) {
        if (cur.id === place.id || hops > 64) throw new MemoryError('invalid_input', 'place hierarchy would contain a cycle');
      }
    }
    return store.upsertPlace(key, {...place, name: place.name.trim()});
  }

  async function upsertObject(input: ObjectInput): Promise<ObjectEntity> {
    assertId(input.id, 'object.id');
    assertInput(typeof input.name === 'string' && input.name.trim(), 'object.name is required');
    assertInput(Array.isArray(input.aliases), 'object.aliases must be an array');
    assertInput(
      Array.isArray(input.safetyTags) && input.safetyTags.every(t => (SAFETY_TAGS as readonly string[]).includes(t)),
      `object.safetyTags must be a subset of ${SAFETY_TAGS.join(', ')}`,
    );
    return store.upsertObject(key, {...input, name: input.name.trim()});
  }

  async function findOrCreateObject(ref: {id?: string; label?: string; category?: string}): Promise<{object: ObjectEntity; created: boolean}> {
    const objects = await store.listObjects(key);
    if (ref.id) {
      const hit = objects.find(o => o.id === ref.id);
      if (hit) return {object: hit, created: false};
    }
    if (ref.label) {
      const exact = objects.find(o => [o.name, ...o.aliases].some(n => n.toLowerCase() === ref.label!.toLowerCase()));
      if (exact) return {object: exact, created: false};
    }
    if (!autoCreate) throw new MemoryError('unknown_object', `unknown object ${ref.id ?? ref.label}`);
    const name = ref.label?.trim() || ref.id!;
    let id = ref.id ?? slug(name);
    if (!ref.id && objects.some(o => o.id === id)) id = `${id}-${crypto.randomUUID().slice(0, 8)}`;
    const object = await upsertObject({id, name, aliases: [], safetyTags: [], ...(ref.category ? {category: ref.category} : {})});
    return {object, created: true};
  }

  async function findPlace(ref: {id?: string; label?: string}): Promise<Place> {
    const places = await store.listPlaces(key);
    const hit = ref.id ? places.find(p => p.id === ref.id) : ref.label ? resolvePlace(places, ref.label) : null;
    if (!hit) throw new MemoryError('unknown_place', `unknown place ${ref.id ?? ref.label ?? '(none)'}; register places from your map first`);
    return hit;
  }

  async function recordToldPlacement(speaker: SpeakerResolution, objectLabel: string, placeLabel: string, at: number) {
    if (!memoryAccessFor(speaker).householdWrite) {
      throw new MemoryError('permission_denied', 'only identified household members can tell the robot where things are');
    }
    const objects = await store.listObjects(key);
    const match = resolveObject(objects, objectLabel, {speakerId: speaker.memberId})[0];
    const object = match?.object ?? (await findOrCreateObject({label: objectLabel.replace(/^(?:my|the|our)\s+/i, '')})).object;
    const place = await findPlace({label: placeLabel});
    const provenance: Provenance = {kind: 'told', sourceId: speaker.memberId!, confidence: speaker.confidence, at};
    await store.addSighting(key, {objectId: object.id, placeId: place.id, at, provenance});
    return {objectId: object.id, placeId: place.id};
  }

  // ---------- episodes ----------
  async function recordEpisode(input: Omit<Episode, 'id' | 'importance' | 'provenance' | 'objectIds' | 'actorIds'> & {
    actorIds?: string[];
    objectIds?: string[];
    importance?: number;
    provenance?: Provenance;
  }): Promise<Episode> {
    assertInput((EPISODE_KINDS as readonly string[]).includes(input.kind), `episode.kind must be one of ${EPISODE_KINDS.join(', ')}`);
    assertInput(typeof input.label === 'string' && /^[\p{L}\p{N}_.:-]{1,80}$/u.test(input.label), 'episode.label must be 1–80 chars of letters, digits, _ . : -');
    assertTimestamp(input.startedAt, 'episode.startedAt');
    if (input.endedAt != null) {
      assertTimestamp(input.endedAt, 'episode.endedAt');
      assertInput(input.endedAt >= input.startedAt, 'episode.endedAt must be >= startedAt');
    }
    if (input.provenance) assertUnitInterval(input.provenance.confidence, 'episode.provenance.confidence');
    return store.addEpisode(key, {
      kind: input.kind,
      label: input.label,
      summary: (input.summary ?? '').slice(0, 500) || input.label.replace(/_/g, ' '),
      actorIds: input.actorIds ?? [],
      objectIds: input.objectIds ?? [],
      startedAt: input.startedAt,
      importance: clampImportance(input.importance),
      provenance: input.provenance ?? {kind: 'observed', confidence: 1, at: input.startedAt},
      ...(input.placeId ? {placeId: input.placeId} : {}),
      ...(input.endedAt != null ? {endedAt: input.endedAt} : {}),
      ...(input.data ? {data: input.data} : {}),
    });
  }

  async function episodes(query: EpisodeQuery & {range?: RelativeRange} = {}): Promise<Episode[]> {
    const {range, ...rest} = query;
    const window = range ? relativeRange(range, now(), tz) : {};
    return store.queryEpisodes(key, {...window, ...rest});
  }

  /** "When did we last mop the floor?" */
  async function lastTime(labelOrQuery: string | EpisodeQuery): Promise<Episode | null> {
    const q = typeof labelOrQuery === 'string' ? {labels: [labelOrQuery]} : labelOrQuery;
    return (await store.queryEpisodes(key, {...q, limit: 1, order: 'desc'}))[0] ?? null;
  }

  async function describe(list: Episode[]): Promise<string[]> {
    const [members, places] = await Promise.all([store.listMembers(key), store.listPlaces(key)]);
    return list.map(e => describeEpisode(e, {members, places, utcOffsetMinutes: tz}));
  }

  // ---------- ingest ----------
  async function ingest(obs: Observation): Promise<IngestResult> {
    switch (obs.type) {
      case 'object_seen': {
        assertTimestamp(obs.at, 'at');
        assertUnitInterval(obs.confidence, 'confidence');
        assertInput(obs.object.id || obs.object.label, 'object.id or object.label is required');
        const place = await findPlace(obs.place);
        const {object, created} = await findOrCreateObject(obs.object);
        await store.addSighting(key, {
          objectId: object.id,
          placeId: place.id,
          at: obs.at,
          provenance: {
            kind: 'observed',
            confidence: obs.confidence,
            at: obs.at,
            ...(obs.sensor ? {sensor: obs.sensor} : {}),
            ...(obs.sensorId ? {sourceId: obs.sensorId} : {}),
          },
        });
        return {type: 'object_seen', objectId: object.id, placeId: place.id, createdObject: created};
      }
      case 'placement_told': {
        assertTimestamp(obs.at, 'at');
        const res = await recordToldPlacement(obs.speaker, obs.objectLabel, obs.placeLabel, obs.at);
        return {type: 'placement_told', ...res};
      }
      case 'activity': {
        const confidence = obs.confidence ?? 1;
        assertUnitInterval(confidence, 'confidence');
        const episode = await recordEpisode({
          kind: obs.kind ?? 'activity',
          label: obs.label,
          summary: obs.summary ?? '',
          startedAt: obs.startedAt,
          ...(obs.endedAt != null ? {endedAt: obs.endedAt} : {}),
          ...(obs.actorIds ? {actorIds: obs.actorIds} : {}),
          ...(obs.objectIds ? {objectIds: obs.objectIds} : {}),
          ...(obs.placeId ? {placeId: obs.placeId} : {}),
          ...(obs.importance != null ? {importance: obs.importance} : {}),
          ...(obs.data ? {data: obs.data} : {}),
          provenance: {kind: 'observed', confidence, at: obs.startedAt, ...(obs.sensor ? {sensor: obs.sensor} : {})},
        });
        return {type: 'activity', episode};
      }
      case 'person_seen': {
        assertTimestamp(obs.at, 'at');
        const speaker = await identify(obs.signals);
        if (speaker.status !== 'identified') return {type: 'person_seen', speaker, episode: null};
        const last = (await store.queryEpisodes(key, {labels: ['present'], actorId: speaker.memberId!, limit: 1}))[0];
        if (last && last.placeId === obs.placeId && obs.at - (last.endedAt ?? last.startedAt) <= presenceMergeSec && obs.at >= last.startedAt) {
          await store.updateEpisode(key, last.id, {endedAt: obs.at});
          return {type: 'person_seen', speaker, episode: {...last, endedAt: obs.at}};
        }
        const member = (await store.listMembers(key)).find(m => m.id === speaker.memberId);
        const episode = await recordEpisode({
          kind: 'presence',
          label: 'present',
          summary: `${member?.displayName ?? speaker.memberId} was seen`,
          actorIds: [speaker.memberId!],
          startedAt: obs.at,
          endedAt: obs.at,
          importance: 0.1,
          ...(obs.placeId ? {placeId: obs.placeId} : {}),
          provenance: {kind: 'observed', confidence: speaker.confidence, at: obs.at, ...(obs.sensor ? {sensor: obs.sensor} : {})},
        });
        return {type: 'person_seen', speaker, episode};
      }
      case 'utterance': {
        assertTimestamp(obs.at, 'at');
        assertInput(typeof obs.text === 'string', 'text is required');
        const speaker = await identify(obs.signals);
        let placement: {objectId: string; placeId: string} | null = null;
        let placementSkipped: 'not_permitted' | 'unknown_object' | 'unknown_place' | undefined;
        const parsed = parsePlacementStatement(obs.text);
        if (parsed) {
          try {
            placement = await recordToldPlacement(speaker, parsed.objectLabel, parsed.placeLabel, obs.at);
          } catch (error) {
            if (!(error instanceof MemoryError)) throw error;
            placementSkipped =
              error.code === 'permission_denied' ? 'not_permitted'
              : error.code === 'unknown_place' ? 'unknown_place'
              : 'unknown_object';
          }
        }
        let extract: ExtractResult | null = null;
        if (memory && obs.turns?.length && obs.userTurn && memoryAccessFor(speaker).personal === 'read_write') {
          const member = (await store.listMembers(key)).find(m => m.id === speaker.memberId);
          extract = await memory.extract({
            key: memberKey(speaker.memberId!),
            characterName: options.robotName ?? robotId,
            ...(member ? {userName: member.displayName} : {}),
            turns: obs.turns,
            userTurn: obs.userTurn,
            ...(obs.threadId ? {threadId: obs.threadId} : {}),
          });
        }
        return {type: 'utterance', speaker, placement, extract, ...(placementSkipped ? {placementSkipped} : {})};
      }
    }
  }

  // ---------- spatial queries ----------
  /**
   * Where is something? Pass `speaker` whenever a person asked, so sensitive locations are withheld
   * from children, guests and unidentified people. Omit it only for the robot's own planning.
   */
  async function whereIs(query: string, opts: {speaker?: SpeakerResolution} = {}): Promise<WhereIsAnswer> {
    const [objects, places] = await Promise.all([store.listObjects(key), store.listPlaces(key)]);
    const match = resolveObject(objects, query, {speakerId: opts.speaker?.memberId ?? null})[0];
    if (!match) return {status: 'unknown_object', answer: `I don't know any object called "${query}".`};
    const object = match.object;
    if (opts.speaker && object.safetyTags.some(t => restrictedDisclosure.has(t))) {
      const s = opts.speaker;
      const trusted = s.status === 'identified' && (s.role === 'owner' || s.role === 'adult' || s.role === 'caregiver');
      if (!trusted) return {status: 'withheld', object, answer: `I can't share where the ${object.name} is. Please ask an adult in the household.`};
    }
    const t = now();
    const sightings = await store.listSightings(key, object.id, {since: t - Math.max(spatialPolicy.habitWindowSec, 365 * 86400), limit: 500});
    const current = currentLocation(sightings, t, spatialPolicy);
    if (!current) return {status: 'never_seen', object, answer: `I have not seen the ${object.name} yet.`};
    const habit = habitualLocation(sightings, t, spatialPolicy);
    const path = placePath(places, current.placeId);
    const how = current.provenance.kind === 'observed' ? `seen${current.provenance.sensor ? ` by ${current.provenance.sensor}` : ''}` : current.provenance.kind;
    let answer = `The ${object.name} was last ${current.provenance.kind === 'told' ? 'reported' : 'seen'} in ${path} ${formatAgo(current.ageSec)} (${how}, confidence ${current.confidence}).`;
    if (current.confidence < 0.3) answer += ' It may have been moved since.';
    const usual = habit ? {...habit, path: placePath(places, habit.placeId)} : null;
    if (usual && usual.placeId !== current.placeId) answer += ` It is usually in ${usual.path}.`;
    const evidence: MemoryEvidence = {
      kind: 'location',
      description: `the ${object.name} is in ${path}`,
      provenance: {...current.provenance, confidence: current.confidence},
      safetyTags: object.safetyTags,
    };
    return {status: 'found', object, current: {...current, path}, usual, evidence, answer};
  }

  // ---------- household facts ----------
  async function addHouseholdFact(speaker: SpeakerResolution, content: string) {
    if (!memory) throw new MemoryError('invalid_input', 'a core memory engine is required for household facts');
    if (!memoryAccessFor(speaker).householdWrite) throw new MemoryError('permission_denied', 'speaker may not add household facts');
    return memory.addFact(householdKey, {scope: 'persona', content});
  }

  // ---------- safety ----------
  function checkAction(request: ActionRequest): SafetyDecision {
    assertId(request.action, 'action');
    return assessAction(request, now(), safetyPolicy);
  }

  // ---------- prompt context ----------
  /**
   * Context block for the robot's LLM, scoped to who is speaking:
   * identity, that member's personal memory, household facts, recent episodes, requested locations, rules.
   */
  async function buildContext(input: {speaker: SpeakerResolution; recent?: RelativeRange; maxEpisodes?: number; objectQueries?: string[]}): Promise<string> {
    const access = memoryAccessFor(input.speaker);
    const members = await store.listMembers(key);
    const sections: string[] = [];
    const who = members.find(m => m.id === input.speaker.memberId);
    sections.push(
      who ?
        `SPEAKER: ${who.displayName} (${who.role}), identified with confidence ${input.speaker.confidence}.`
      : `SPEAKER: not identified (${input.speaker.status}). Do not share personal information about household members.`,
    );
    if (memory && access.personal === 'read_write' && input.speaker.memberId) {
      const mk = memberKey(input.speaker.memberId);
      const snap = await memory.snapshot(mk);
      const hasMemory = snap.story.trim() || snap.pins.length || snap.facts.persona.length + snap.facts.character.length + snap.facts.side.length;
      if (hasMemory) sections.push(await memory.buildPrompt(mk, {includeRelationship: true}));
    }
    if (memory && access.householdRead) {
      const snap = await memory.snapshot(householdKey);
      const facts = snap.facts.persona.filter(f => !f.disabled);
      if (facts.length) sections.push(`HOUSEHOLD FACTS:\n${facts.map(f => `- ${f.content}`).join('\n')}`);
    }
    const recent = await episodes({range: input.recent ?? 'last_24h', limit: input.maxEpisodes ?? 10, kinds: ['activity', 'task', 'event']});
    if (recent.length) sections.push(`RECENT EVENTS:\n${(await describe(recent)).map(l => `- ${l}`).join('\n')}`);
    for (const q of input.objectQueries ?? []) {
      const res = await whereIs(q, {speaker: input.speaker});
      sections.push(`LOCATION (${q}): ${res.answer}`);
    }
    sections.push(EMBODIED_MEMORY_RULES);
    return sections.join('\n\n');
  }

  // ---------- retention ----------
  async function prune(opts: {sightingsMaxAgeDays?: number; episodesMaxAgeDays?: number; keepImportanceAtLeast?: number} = {}) {
    const t = now();
    return store.prune(key, {
      sightingsBefore: t - (opts.sightingsMaxAgeDays ?? 90) * 86400,
      episodesBefore: t - (opts.episodesMaxAgeDays ?? 365) * 86400,
      keepImportanceAtLeast: opts.keepImportanceAtLeast ?? 0.8,
    });
  }

  return {
    key,
    upsertMember,
    listMembers: () => store.listMembers(key),
    identify,
    forgetMember,
    upsertPlace,
    listPlaces: () => store.listPlaces(key),
    removePlace: (placeId: string) => store.removePlace(key, placeId),
    upsertObject,
    listObjects: () => store.listObjects(key),
    removeObject: (objectId: string) => store.removeObject(key, objectId),
    ingest,
    whereIs,
    recordEpisode,
    episodes,
    lastTime,
    describe,
    addHouseholdFact,
    checkAction,
    buildContext,
    prune,
    clearHome: async () => {
      await store.clearHome(key);
      if (memory) await memory.clear(householdKey);
    },
  };
}

export type HomeMemory = ReturnType<typeof createHomeMemory>;
