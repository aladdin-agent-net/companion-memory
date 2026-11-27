import {episodeLimit, matchesEpisodeQuery, type HomeStore, type MemberInput, type ObjectInput} from './store.js';
import type {Episode, EpisodeQuery, HomeKey, Member, ObjectEntity, ObjectSighting, Place} from './types.js';

type Home = {
  members: Map<string, Member>;
  places: Map<string, Place>;
  objects: Map<string, ObjectEntity>;
  sightings: ObjectSighting[];
  episodes: Episode[];
};

const clone = <T>(v: T): T => structuredClone(v);

/** Process-local household store for tests, simulators and single-process robots. */
export class InMemoryHomeStore implements HomeStore {
  private readonly homes = new Map<string, Home>();
  private readonly now: () => number;

  constructor(options: {now?: () => number} = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private home(key: HomeKey): Home {
    let h = this.homes.get(key.homeId);
    if (!h) {
      h = {members: new Map(), places: new Map(), objects: new Map(), sightings: [], episodes: []};
      this.homes.set(key.homeId, h);
    }
    return h;
  }

  async upsertMember(key: HomeKey, input: MemberInput) {
    const h = this.home(key);
    const prev = h.members.get(input.id);
    const now = this.now();
    const member: Member = {...clone(input), createdAt: prev?.createdAt ?? now, updatedAt: now};
    h.members.set(member.id, member);
    return clone(member);
  }
  async listMembers(key: HomeKey) {
    return [...this.home(key).members.values()].map(clone);
  }

  async upsertPlace(key: HomeKey, place: Place) {
    this.home(key).places.set(place.id, clone(place));
    return clone(place);
  }
  async listPlaces(key: HomeKey) {
    return [...this.home(key).places.values()].map(clone);
  }
  async removePlace(key: HomeKey, placeId: string) {
    const h = this.home(key);
    h.places.delete(placeId);
    h.sightings = h.sightings.filter(s => s.placeId !== placeId);
    for (const p of h.places.values()) if (p.parentId === placeId) delete p.parentId;
  }

  async upsertObject(key: HomeKey, input: ObjectInput) {
    const h = this.home(key);
    const prev = h.objects.get(input.id);
    const now = this.now();
    const object: ObjectEntity = {...clone(input), createdAt: prev?.createdAt ?? now, updatedAt: now};
    h.objects.set(object.id, object);
    return clone(object);
  }
  async listObjects(key: HomeKey) {
    return [...this.home(key).objects.values()].map(clone);
  }
  async removeObject(key: HomeKey, objectId: string) {
    const h = this.home(key);
    h.objects.delete(objectId);
    h.sightings = h.sightings.filter(s => s.objectId !== objectId);
    for (const e of h.episodes) e.objectIds = e.objectIds.filter(id => id !== objectId);
  }

  async addSighting(key: HomeKey, input: Omit<ObjectSighting, 'id'>) {
    const sighting: ObjectSighting = {id: crypto.randomUUID(), ...clone(input)};
    this.home(key).sightings.push(sighting);
    return clone(sighting);
  }
  async listSightings(key: HomeKey, objectId: string, options: {since?: number; limit?: number} = {}) {
    return this.home(key)
      .sightings.filter(s => s.objectId === objectId && (options.since == null || s.at >= options.since))
      .sort((a, b) => b.at - a.at)
      .slice(0, options.limit ?? 200)
      .map(clone);
  }

  async addEpisode(key: HomeKey, input: Omit<Episode, 'id'>) {
    const episode: Episode = {id: crypto.randomUUID(), ...clone(input)};
    this.home(key).episodes.push(episode);
    return clone(episode);
  }
  async updateEpisode(key: HomeKey, episodeId: string, patch: Partial<Pick<Episode, 'endedAt' | 'summary' | 'importance' | 'data'>>) {
    const e = this.home(key).episodes.find(x => x.id === episodeId);
    if (e) Object.assign(e, clone(patch));
  }
  async queryEpisodes(key: HomeKey, query: EpisodeQuery) {
    const dir = query.order === 'asc' ? 1 : -1;
    return this.home(key)
      .episodes.filter(e => matchesEpisodeQuery(e, query))
      .sort((a, b) => (a.startedAt - b.startedAt) * dir)
      .slice(0, episodeLimit(query))
      .map(clone);
  }

  async prune(key: HomeKey, options: {sightingsBefore?: number; episodesBefore?: number; keepImportanceAtLeast?: number}) {
    const h = this.home(key);
    const s0 = h.sightings.length;
    const e0 = h.episodes.length;
    if (options.sightingsBefore != null) h.sightings = h.sightings.filter(s => s.at >= options.sightingsBefore!);
    if (options.episodesBefore != null) {
      const keep = options.keepImportanceAtLeast ?? 1.01;
      h.episodes = h.episodes.filter(e => (e.endedAt ?? e.startedAt) >= options.episodesBefore! || e.importance >= keep);
    }
    return {sightings: s0 - h.sightings.length, episodes: e0 - h.episodes.length};
  }

  async forgetMember(key: HomeKey, memberId: string) {
    const h = this.home(key);
    h.members.delete(memberId);
    h.sightings = h.sightings.filter(s => !(s.provenance.kind === 'told' && s.provenance.sourceId === memberId));
    h.episodes = h.episodes.filter(e => !(e.actorIds.length === 1 && e.actorIds[0] === memberId));
    for (const e of h.episodes) {
      e.actorIds = e.actorIds.filter(id => id !== memberId);
      if (e.provenance.sourceId === memberId) delete e.provenance.sourceId;
    }
    for (const o of h.objects.values()) if (o.ownerId === memberId) delete o.ownerId;
  }

  async clearHome(key: HomeKey) {
    this.homes.delete(key.homeId);
  }
}
