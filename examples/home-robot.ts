/**
 * Household robot walkthrough. Run: npm run example:home
 * Simulates perception, speech and task events; no robot or model needed.
 */
import {DatabaseSync} from 'node:sqlite';
import {createHomeMemory, createMemoryEngine, fromNodeSqlite, SqlHomeStore, SqlStore} from '../src/index.js';

const driver = fromNodeSqlite(new DatabaseSync(':memory:'));
const homeStore = new SqlHomeStore(driver);
const coreStore = new SqlStore(driver);
await homeStore.migrate();
await coreStore.migrate();

let clock = Math.floor(Date.now() / 1000);
const now = () => clock;
const home = createHomeMemory({
  homeId: 'demo-home',
  robotId: 'robo-1',
  robotName: 'Robo',
  store: homeStore,
  memory: createMemoryEngine({store: coreStore, now}),
  now,
  utcOffsetMinutes: 480,
});

// 1) Set up from the robot's map and the family's onboarding.
await home.upsertMember({id: 'tom', displayName: 'Tom', role: 'owner', aliases: ['Dad']});
await home.upsertMember({id: 'lily', displayName: 'Lily', role: 'child', aliases: []});
await home.upsertPlace({id: 'home', name: 'Home', kind: 'home', aliases: []});
await home.upsertPlace({id: 'kitchen', name: 'Kitchen', kind: 'room', parentId: 'home', aliases: []});
await home.upsertPlace({id: 'cabinet', name: 'Left cabinet', kind: 'furniture', parentId: 'kitchen', aliases: ['cupboard']});
await home.upsertPlace({id: 'bath', name: 'Bathroom cabinet', kind: 'furniture', parentId: 'home', aliases: []});
await home.upsertObject({id: 'pills', name: 'Pill box', aliases: ['medicine'], ownerId: 'tom', safetyTags: ['medication']});

// 2) Perception: the camera sees mugs in the cupboard over a few days.
for (let i = 0; i < 3; i++) {
  await home.ingest({type: 'object_seen', object: {label: 'Blue mug'}, place: {id: 'cabinet'}, at: clock - (3 - i) * 86400, confidence: 0.92, sensor: 'camera'});
}

// 3) Speech: Tom (voice + face agree) says where he put his medicine.
const said = await home.ingest({
  type: 'utterance',
  text: 'I put my medicine in the bathroom cabinet.',
  signals: [
    {source: 'voice', memberId: 'tom', score: 0.88},
    {source: 'face', memberId: 'tom', score: 0.91},
  ],
  at: clock,
});
console.log('utterance →', said.type === 'utterance' ? {speaker: said.speaker.memberId, placement: said.placement} : said);

// 4) Tasks: the robot logs what it did.
await home.recordEpisode({kind: 'task', label: 'mop_floor', summary: 'Mopped the kitchen', placeId: 'kitchen', startedAt: clock - 2 * 3600});

clock += 3600;

// 5) Questions.
console.log('\nwhere is the mug? →', (await home.whereIs('blue mug')).answer);
console.log('last mopped →', (await home.describe([(await home.lastTime('mop_floor'))!]))[0]);

// 6) Three requests, one safety gate.
const lily = await home.identify([{source: 'face', memberId: 'lily', score: 0.97}]);
const tom = await home.identify([{source: 'device', memberId: 'tom', score: 1}]);
const mug = await home.whereIs('blue mug', {speaker: tom});
if (mug.status === 'found') {
  console.log('\nTom asks for the mug →', home.checkAction({action: 'fetch_object', description: 'bring the blue mug', requester: tom, objectTags: mug.object.safetyTags, evidence: [mug.evidence]}));
}
console.log('Lily: where are the pills? →', (await home.whereIs('pill box', {speaker: lily})).answer);
const pills = await home.whereIs('pill box'); // robot-internal lookup, no speaker
if (pills.status === 'found') {
  console.log('Lily asks for pills →', home.checkAction({action: 'fetch_object', description: 'bring the pill box', requester: lily, objectTags: pills.object.safetyTags, evidence: [pills.evidence]}));
  console.log('Tom asks for pills →', home.checkAction({action: 'fetch_object', description: 'bring your pill box', requester: tom, objectTags: pills.object.safetyTags, evidence: [pills.evidence]}));
}

// 7) Context for the robot's LLM, scoped to the speaker.
console.log('\n--- context for Lily ---\n');
console.log(await home.buildContext({speaker: lily, objectQueries: ['blue mug']}));
