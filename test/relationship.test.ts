import {describe, expect, it} from 'vitest';
import {
  applyBond,
  applyUserTurn,
  computeAffection,
  familiarityToStage,
  initialRelationship,
  isFirstConversation,
  userTurnFingerprint,
} from '../src/index.js';

describe('relationship', () => {
  it('maps familiarity to stages', () => {
    expect(familiarityToStage(0, 0)).toBe('first_conversations');
    expect(familiarityToStage(4, 1)).toBe('early');
    expect(familiarityToStage(12, 3)).toBe('familiar');
    expect(familiarityToStage(40, 10)).toBe('close');
    expect(familiarityToStage(100, 25)).toBe('long_term');
  });

  it('counts each user turn once', () => {
    let s = initialRelationship(0);
    s = applyUserTurn(s, 'fp1', 10);
    const again = applyUserTurn(s, 'fp1', 11);
    expect(again).toBe(s);
    s = applyUserTurn(s, 'fp2', 12);
    expect(s.interactionCount).toBe(2);
    expect(s.familiarity).toBe(8);
    expect(s.stage).toBe('early');
  });

  it('ratchets bond values up and clamps them', () => {
    const s = applyBond(applyBond(initialRelationship(0), {trust: 50, romance: 150}), {trust: 20});
    expect(s.trust).toBe(50);
    expect(s.romance).toBe(100);
    expect(computeAffection(s)).toBe(60);
  });

  it('detects a first conversation', () => {
    expect(isFirstConversation(null, 1)).toBe(true);
    expect(isFirstConversation({...initialRelationship(0), interactionCount: 3}, 1)).toBe(false);
    expect(isFirstConversation(null, 5)).toBe(false);
  });

  it('fingerprints turns deterministically', async () => {
    const turns = [{role: 'user' as const, content: 'hi'}];
    expect(await userTurnFingerprint(turns)).toBe(await userTurnFingerprint(turns));
    expect(await userTurnFingerprint([])).toBeNull();
  });
});
