import {DatabaseSync} from 'node:sqlite';
import {beforeEach, describe, expect, it} from 'vitest';
import {
  createHomeMemory,
  createMemoryEngine,
  fromNodeSqlite,
  InMemoryHomeStore,
  InMemoryStore,
  MemoryError,
  SqlHomeStore,
  SqlStore,
  type HomeMemory,
  type HomeStore,
  type MemoryStore,
  type SpeakerResolution,
} from '../src/index.js';

type Setup = (now: () => number) => Promise<{home: HomeStore; core: MemoryStore}>;

const setups: Array<[string, Setup]> = [
  ['in-memory', async now => ({home: new InMemoryHomeStore({now}), core: new InMemoryStore({now})})],
  [
    'sqlite',
    async now => {
      const driver = fromNodeSqlite(new DatabaseSync(':memory:'));
      const home = new SqlHomeStore(driver, {now});
      const core = new SqlStore(driver, {now});
      await home.migrate();
      await core.migrate();
      return {home, core};
    },
  ],
];

const DAY = 86400;
const T0 = Date.UTC(2026, 10, 25, 2, 0, 0) / 1000; // 10:00 in UTC+8

describe.each(setups)('home memory (%s)', (_name, setup) => {
  let clock = T0;
  const now = () => clock;
  let hm: HomeMemory;
  let homeStore: HomeStore;
  const dad = () => ({status: 'identified', memberId: 'dad', role: 'owner', confidence: 0.95, candidates: []}) as SpeakerResolution;

  beforeEach(async () => {
    clock = T0;
    const {home, core} = await setup(now);
    homeStore = home;
    const memory = createMemoryEngine({store: core, now});
    hm = createHomeMemory({homeId: 'h1', robotId: 'robo', robotName: 'Robo', store: home, memory, now, utcOffsetMinutes: 480});
    await hm.upsertMember({id: 'dad', displayName: 'Tom', role: 'owner', aliases: ['Dad']});
    await hm.upsertMember({id: 'kid', displayName: 'Lily', role: 'child', aliases: []});
    await hm.upsertPlace({id: 'home', name: 'Home', kind: 'home', aliases: []});
    await hm.upsertPlace({id: 'kitchen', name: 'Kitchen', kind: 'room', parentId: 'home', aliases: []});
    await hm.upsertPlace({id: 'cab', name: 'Left cabinet', kind: 'furniture', parentId: 'kitchen', aliases: ['cupboard']});
    await hm.upsertPlace({id: 'hall', name: 'Hall table', kind: 'furniture', parentId: 'home', aliases: []});
    await hm.upsertPlace({id: 'bath', name: 'Bathroom cabinet', kind: 'furniture', parentId: 'home', aliases: []});
    await hm.upsertObject({id: 'pills', name: 'Pill box', aliases: ['medicine'], safetyTags: ['medication'], ownerId: 'dad'});
  });

  it('validates places, rejecting unknown parents and cycles', async () => {
    await expect(hm.upsertPlace({id: 'x', name: 'X', kind: 'room', parentId: 'nope', aliases: []})).rejects.toMatchObject({code: 'unknown_place'});
    await expect(hm.upsertPlace({id: 'kitchen', name: 'Kitchen', kind: 'room', parentId: 'cab', aliases: []})).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(hm.upsertObject({id: 'o', name: 'O', aliases: [], safetyTags: ['radioactive' as never]})).rejects.toBeInstanceOf(MemoryError);
  });

  it('tracks object locations from perception with decay and habits', async () => {
    for (let i = 0; i < 4; i++) {
      clock = T0 + i * 3600;
      await hm.ingest({type: 'object_seen', object: {label: 'Blue mug'}, place: {id: 'cab'}, at: clock, confidence: 0.9, sensor: 'camera'});
    }
    clock = T0 + 5 * 3600;
    const seen = await hm.ingest({type: 'object_seen', object: {label: 'blue mug'}, place: {label: 'hall table'}, at: clock, confidence: 0.9, sensor: 'camera'});
    expect(seen).toMatchObject({type: 'object_seen', placeId: 'hall', createdObject: false});

    clock += 2 * 3600;
    const where = await hm.whereIs('the blue mug');
    expect(where.status).toBe('found');
    if (where.status !== 'found') return;
    expect(where.current.path).toBe('Hall table');
    expect(where.usual?.path).toBe('Kitchen › Left cabinet');
    expect(where.answer).toContain('2 hours ago');
    expect(where.answer).toContain('usually in Kitchen › Left cabinet');
    expect(where.current.confidence).toBeLessThan(0.9);
  });

  it('rejects observations at places that are not on the map', async () => {
    await expect(hm.ingest({type: 'object_seen', object: {label: 'mug'}, place: {label: 'garage'}, at: clock, confidence: 1})).rejects.toMatchObject({
      code: 'unknown_place',
    });
  });

  it('answers for unknown and never-seen objects', async () => {
    expect((await hm.whereIs('umbrella')).status).toBe('unknown_object');
    expect((await hm.whereIs('my medicine', {speaker: dad()})).status).toBe('never_seen');
  });

  it('records placements people tell it, only from identified members', async () => {
    const res = await hm.ingest({
      type: 'utterance',
      text: 'I put my medicine in the bathroom cabinet.',
      signals: [
        {source: 'voice', memberId: 'dad', score: 0.9},
        {source: 'face', memberId: 'dad', score: 0.9},
      ],
      at: clock,
    });
    expect(res).toMatchObject({type: 'utterance', placement: {objectId: 'pills', placeId: 'bath'}});

    const stranger = await hm.ingest({type: 'utterance', text: 'I put the pill box on the hall table', signals: [], at: clock + 10});
    expect(stranger).toMatchObject({placement: null, placementSkipped: 'not_permitted'});

    const where = await hm.whereIs('pill box');
    expect(where.status === 'found' && where.current.placeId).toBe('bath');
  });

  it('withholds sensitive object locations from children, guests and strangers', async () => {
    await hm.ingest({type: 'placement_told', speaker: dad(), objectLabel: 'pill box', placeLabel: 'bathroom cabinet', at: clock});
    const kid: SpeakerResolution = {status: 'identified', memberId: 'kid', role: 'child', confidence: 1, candidates: []};
    const stranger: SpeakerResolution = {status: 'unknown', memberId: null, role: null, confidence: 0, candidates: []};
    expect((await hm.whereIs('pill box', {speaker: kid})).status).toBe('withheld');
    expect((await hm.whereIs('pill box', {speaker: stranger})).status).toBe('withheld');
    expect((await hm.whereIs('pill box', {speaker: dad()})).status).toBe('found');
    expect((await hm.whereIs('pill box')).status).toBe('found'); // robot-internal planning
  });

  it('omits an empty personal memory block from the context', async () => {
    const kid: SpeakerResolution = {status: 'identified', memberId: 'kid', role: 'child', confidence: 1, candidates: []};
    expect(await hm.buildContext({speaker: kid})).not.toContain('MEMORY RULES:\n- Only treat');
  });

  it('gates medication actions even when memory is fresh', async () => {
    await hm.ingest({type: 'placement_told', speaker: dad(), objectLabel: 'pill box', placeLabel: 'bathroom cabinet', at: clock});
    const where = await hm.whereIs('pill box');
    if (where.status !== 'found') throw new Error('expected found');
    const decision = hm.checkAction({action: 'fetch_object', requester: dad(), objectTags: where.object.safetyTags, evidence: [where.evidence]});
    expect(decision).toMatchObject({decision: 'confirm', risk: 'critical', confirmBy: 'adult'});
    expect(decision.confirmPrompt).toContain('Bathroom cabinet');

    const kid: SpeakerResolution = {status: 'identified', memberId: 'kid', role: 'child', confidence: 0.99, candidates: []};
    expect(hm.checkAction({action: 'fetch_object', requester: kid, objectTags: ['medication'], evidence: [where.evidence]}).decision).toBe('deny');
  });

  it('keeps an episodic timeline with relative ranges and last-time queries', async () => {
    await hm.recordEpisode({kind: 'task', label: 'mop_floor', summary: 'Mopped the kitchen', placeId: 'kitchen', startedAt: T0 - 2 * DAY, endedAt: T0 - 2 * DAY + 1200});
    await hm.recordEpisode({kind: 'task', label: 'mop_floor', summary: 'Mopped the hall', startedAt: T0 - 3600});
    await hm.recordEpisode({kind: 'event', label: 'took_medication', summary: 'Tom took evening pills', actorIds: ['dad'], objectIds: ['pills'], startedAt: T0 - 600, importance: 0.9});

    expect((await hm.lastTime('mop_floor'))?.summary).toBe('Mopped the hall');
    expect((await hm.episodes({range: 'today'})).map(e => e.label)).toEqual(['took_medication', 'mop_floor']);
    expect((await hm.episodes({actorId: 'dad'})).map(e => e.label)).toEqual(['took_medication']);
    expect((await hm.episodes({objectId: 'pills', text: 'EVENING'})).length).toBe(1);
    expect((await hm.episodes({labels: ['mop_floor'], order: 'asc'}))[0]?.summary).toBe('Mopped the kitchen');

    const [line] = await hm.describe([(await hm.lastTime('took_medication'))!]);
    expect(line).toBe('2026-11-25 09:50 · took_medication · Tom: Tom took evening pills');

    await expect(hm.recordEpisode({kind: 'task', label: 'bad label!', summary: '', startedAt: T0})).rejects.toMatchObject({code: 'invalid_input'});
    await expect(hm.recordEpisode({kind: 'task', label: 'x', summary: '', startedAt: T0, endedAt: T0 - 1})).rejects.toMatchObject({code: 'invalid_input'});
  });

  it('merges consecutive presence sightings into one episode', async () => {
    const signals = [
      {source: 'face' as const, memberId: 'kid', score: 0.95},
      {source: 'voice' as const, memberId: 'kid', score: 0.5},
    ];
    const a = await hm.ingest({type: 'person_seen', signals, placeId: 'kitchen', at: clock});
    const b = await hm.ingest({type: 'person_seen', signals, placeId: 'kitchen', at: clock + 300});
    const c = await hm.ingest({type: 'person_seen', signals, placeId: 'kitchen', at: clock + 3000});
    const id = (r: typeof a) => (r.type === 'person_seen' ? r.episode?.id : undefined);
    expect(id(a)).toBeDefined();
    expect(id(b)).toBe(id(a));
    expect(id(c)).toBeDefined();
    expect(id(c)).not.toBe(id(a));
    const presence = await hm.episodes({kinds: ['presence']});
    expect(presence).toHaveLength(2);
    expect(presence[1]?.endedAt).toBe(clock + 300);
    const unknown = await hm.ingest({type: 'person_seen', signals: [{source: 'voice', memberId: 'kid', score: 0.3}], at: clock});
    expect(unknown).toMatchObject({episode: null, speaker: {status: 'unknown'}});
  });

  it('extracts personal facts per identified speaker and scopes the prompt context', async () => {
    await hm.ingest({
      type: 'utterance',
      text: "I'm allergic to peanuts.",
      signals: [{source: 'device', memberId: 'kid', score: 1}],
      at: clock,
      turns: [{role: 'user', content: "I'm allergic to peanuts."}],
      userTurn: 1,
    });
    await hm.addHouseholdFact(dad(), 'Dinner is usually at 7pm.');
    await expect(hm.addHouseholdFact({status: 'unknown', memberId: null, role: null, confidence: 0, candidates: []}, 'x')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await hm.recordEpisode({kind: 'task', label: 'vacuum', summary: 'Vacuumed the living room', startedAt: clock - 3600});

    const kid: SpeakerResolution = {status: 'identified', memberId: 'kid', role: 'child', confidence: 1, candidates: []};
    const kidCtx = await hm.buildContext({speaker: kid, objectQueries: ['pill box']});
    expect(kidCtx).toContain('SPEAKER: Lily (child)');
    expect(kidCtx).toContain('User is allergic to peanuts.');
    expect(kidCtx).toContain('Dinner is usually at 7pm.');
    expect(kidCtx).toContain('Vacuumed the living room');
    expect(kidCtx).toContain("LOCATION (pill box): I can't share where the Pill box is");
    expect(kidCtx).toContain('EMBODIED MEMORY RULES');

    const strangerCtx = await hm.buildContext({speaker: {status: 'unknown', memberId: null, role: null, confidence: 0, candidates: []}});
    expect(strangerCtx).not.toContain('peanuts');
    expect(strangerCtx).toContain('Dinner is usually at 7pm.');
  });

  it('forgets a member everywhere', async () => {
    await hm.ingest({type: 'placement_told', speaker: dad(), objectLabel: 'pill box', placeLabel: 'bathroom cabinet', at: clock});
    await hm.recordEpisode({kind: 'event', label: 'arrived', summary: 'Tom came home', actorIds: ['dad'], startedAt: clock});
    await hm.recordEpisode({kind: 'event', label: 'dinner', summary: 'Family dinner', actorIds: ['dad', 'kid'], startedAt: clock});

    await hm.forgetMember('dad');
    expect((await hm.listMembers()).map(m => m.id)).toEqual(['kid']);
    expect((await hm.whereIs('pill box')).status).toBe('never_seen');
    const eps = await hm.episodes({});
    expect(eps.map(e => e.label)).toEqual(['dinner']);
    expect(eps[0]?.actorIds).toEqual(['kid']);
    expect((await hm.listObjects()).find(o => o.id === 'pills')?.ownerId).toBeUndefined();
  });

  it('prunes old memory but keeps important episodes', async () => {
    await hm.ingest({type: 'object_seen', object: {label: 'Mug'}, place: {id: 'cab'}, at: T0 - 200 * DAY, confidence: 1});
    await hm.recordEpisode({kind: 'event', label: 'old_minor', summary: 'x', startedAt: T0 - 400 * DAY, importance: 0.2});
    await hm.recordEpisode({kind: 'event', label: 'old_major', summary: 'y', startedAt: T0 - 400 * DAY, importance: 0.95});
    expect(await hm.prune()).toEqual({sightings: 1, episodes: 1});
    expect((await hm.episodes({})).map(e => e.label)).toEqual(['old_major']);
  });

  it('removes objects and places cleanly', async () => {
    await hm.ingest({type: 'object_seen', object: {label: 'Mug'}, place: {id: 'cab'}, at: clock, confidence: 1});
    await hm.recordEpisode({kind: 'event', label: 'used', summary: 'used mug', objectIds: ['mug'], startedAt: clock});
    await hm.removeObject('mug');
    expect((await hm.episodes({}))[0]?.objectIds).toEqual([]);
    await hm.removePlace('kitchen');
    expect((await hm.listPlaces()).find(p => p.id === 'cab')?.parentId).toBeUndefined();
  });

  it('isolates homes from each other', async () => {
    const other = createHomeMemory({homeId: 'h2', robotId: 'robo', store: homeStore, now});
    expect(await other.listMembers()).toEqual([]);
    await hm.clearHome();
    expect(await hm.listMembers()).toEqual([]);
  });
});
