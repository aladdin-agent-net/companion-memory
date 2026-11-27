import {
  decideExtraction,
  type BeginExtractionArgs,
  type BeginExtractionResult,
  type ExtractionState,
  type FactPatch,
  type MemoryKey,
  type MemoryStore,
} from '../store.js';
import type {Fact, NewFact, Pin, RelationshipState, Role} from '../types.js';

type Bucket = {
  story: string;
  pins: Pin[];
  facts: Fact[];
  relationship: RelationshipState | null;
  extraction: ExtractionState | null;
};

/** Process-local store for tests, demos and single-process apps. Not persistent. */
export class InMemoryStore implements MemoryStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(options: {now?: () => number} = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private bucket(key: MemoryKey): Bucket {
    const id = `${key.userId}\u0000${key.agentId}`;
    let b = this.buckets.get(id);
    if (!b) {
      b = {story: '', pins: [], facts: [], relationship: null, extraction: null};
      this.buckets.set(id, b);
    }
    return b;
  }

  async getStory(key: MemoryKey) {
    return this.bucket(key).story;
  }
  async setStory(key: MemoryKey, body: string) {
    this.bucket(key).story = body;
  }

  async listPins(key: MemoryKey) {
    return [...this.bucket(key).pins];
  }
  async addPin(key: MemoryKey, pin: {role: Role; content: string}) {
    const row: Pin = {id: crypto.randomUUID(), ...pin, createdAt: this.now()};
    this.bucket(key).pins.push(row);
    return row;
  }
  async removePin(key: MemoryKey, pinId: string) {
    const b = this.bucket(key);
    b.pins = b.pins.filter(p => p.id !== pinId);
  }

  async listFacts(key: MemoryKey) {
    return this.bucket(key).facts.map(f => ({...f}));
  }
  async addFact(key: MemoryKey, fact: NewFact) {
    const row: Fact = {
      id: crypto.randomUUID(),
      scope: fact.scope,
      content: fact.content,
      source: fact.source,
      disabled: false,
      updatedAt: this.now(),
      ...(fact.subjectName ? {subjectName: fact.subjectName} : {}),
    };
    this.bucket(key).facts.push(row);
    return {...row};
  }
  async updateFact(key: MemoryKey, factId: string, patch: FactPatch) {
    const fact = this.bucket(key).facts.find(f => f.id === factId);
    if (!fact) return;
    if (patch.content !== undefined) fact.content = patch.content;
    if (patch.disabled !== undefined) fact.disabled = patch.disabled;
    if (patch.scope !== undefined) fact.scope = patch.scope;
    if (patch.subjectName !== undefined) {
      if (patch.subjectName === null) delete fact.subjectName;
      else fact.subjectName = patch.subjectName;
    }
    fact.updatedAt = this.now();
  }
  async removeFact(key: MemoryKey, factId: string) {
    const b = this.bucket(key);
    b.facts = b.facts.filter(f => f.id !== factId);
  }

  async getRelationship(key: MemoryKey) {
    const r = this.bucket(key).relationship;
    return r ? {...r, notes: [...r.notes]} : null;
  }
  async saveRelationship(key: MemoryKey, state: RelationshipState) {
    this.bucket(key).relationship = {...state, notes: [...state.notes]};
  }

  async beginExtraction(key: MemoryKey, args: BeginExtractionArgs): Promise<BeginExtractionResult> {
    // Synchronous read-decide-write: atomic within one JS event loop.
    const b = this.bucket(key);
    const decision = decideExtraction(b.extraction, args);
    if (decision === 'started') {
      b.extraction = {
        status: 'running',
        lastTurn: b.extraction?.lastTurn ?? 0,
        lastThreadId: b.extraction?.lastThreadId ?? null,
        lastExtractedAt: b.extraction?.lastExtractedAt ?? 0,
        updatedAt: args.now,
      };
    }
    return decision;
  }
  async finishExtraction(key: MemoryKey, args: {turn: number; threadId?: string; now: number; error?: string}) {
    const b = this.bucket(key);
    const prev = b.extraction;
    b.extraction =
      args.error ?
        {
          status: 'error',
          lastTurn: prev?.lastTurn ?? 0,
          lastThreadId: prev?.lastThreadId ?? null,
          lastExtractedAt: prev?.lastExtractedAt ?? 0,
          updatedAt: args.now,
        }
      : {
          status: 'ok',
          lastTurn: args.turn,
          lastThreadId: args.threadId ?? prev?.lastThreadId ?? null,
          lastExtractedAt: args.now,
          updatedAt: args.now,
        };
  }

  async clear(key: MemoryKey) {
    this.buckets.delete(`${key.userId}\u0000${key.agentId}`);
  }
}
