import {formatAgo} from './episodes.js';
import type {SpeakerResolution} from './speaker.js';
import type {Provenance, SafetyTag} from './types.js';

/**
 * Memory is not permission. A plan that relies on remembered information must pass this gate
 * before a physical action. The gate never executes anything; it returns allow / confirm / deny
 * and, for `confirm`, a question to ask a person.
 */

export type ActionRisk = 'low' | 'medium' | 'high' | 'critical';
const RISK_ORDER: ActionRisk[] = ['low', 'medium', 'high', 'critical'];
const maxRisk = (a: ActionRisk, b: ActionRisk) => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b);

/** A piece of memory the plan depends on. */
export type MemoryEvidence = {
  kind: 'location' | 'fact' | 'episode';
  /** Human-readable, used in the confirmation question: "the pill box is in Bathroom › Cabinet". */
  description: string;
  provenance: Provenance;
  safetyTags?: SafetyTag[];
};

export type ActionRequest = {
  /** Your action id, e.g. `fetch_object`, `give_medication`, `open_door`. */
  action: string;
  /** Human wording for the confirmation question, e.g. "bring the pill box". Defaults to the action id. */
  description?: string;
  /** Explicit risk. Combined with risk derived from safety tags; the higher wins. */
  risk?: ActionRisk;
  /** Who asked for the action. Omit for robot-initiated routines. */
  requester?: SpeakerResolution;
  /** Safety tags of objects the action touches. */
  objectTags?: SafetyTag[];
  evidence: MemoryEvidence[];
};

export type SafetyDecision = {
  decision: 'allow' | 'confirm' | 'deny';
  risk: ActionRisk;
  reasons: string[];
  /** Ask this before acting (decision = confirm). */
  confirmPrompt?: string;
  /** Who may confirm: anyone present, the identified requester, or an adult. */
  confirmBy?: 'anyone' | 'requester' | 'adult';
};

export type SafetyPolicy = {
  /** Minimum evidence confidence per risk level; below → confirm. */
  minConfidence: Record<ActionRisk, number>;
  /** Max evidence age in seconds per risk level; older → confirm. */
  maxAgeSec: Record<ActionRisk, number>;
  /** Evidence from people (told / inferred) is not enough at or above this risk. */
  requireObservedFrom: ActionRisk;
  /** Tags whose memory must always be re-verified before acting, however fresh. */
  alwaysConfirmTags: SafetyTag[];
  /** Risk derived from object safety tags. */
  tagRisk: Partial<Record<SafetyTag, ActionRisk>>;
  /** Roles that cannot request actions at or above `restrictedFrom`. */
  restrictedRoles: Array<'child' | 'guest'>;
  restrictedFrom: ActionRisk;
};

export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  minConfidence: {low: 0.3, medium: 0.5, high: 0.7, critical: 0.9},
  maxAgeSec: {low: 30 * 86400, medium: 7 * 86400, high: 86400, critical: 3600},
  requireObservedFrom: 'high',
  alwaysConfirmTags: ['medication', 'allergen', 'hazardous'],
  tagRisk: {
    medication: 'critical',
    hazardous: 'critical',
    allergen: 'high',
    sharp: 'high',
    child_restricted: 'high',
    fragile: 'medium',
    valuable: 'medium',
  },
  restrictedRoles: ['child', 'guest'],
  restrictedFrom: 'high',
};

export function deriveRisk(request: ActionRequest, policy: SafetyPolicy = DEFAULT_SAFETY_POLICY): ActionRisk {
  let risk: ActionRisk = request.risk ?? 'low';
  const tags = new Set([...(request.objectTags ?? []), ...request.evidence.flatMap(e => e.safetyTags ?? [])]);
  for (const tag of tags) {
    const t = policy.tagRisk[tag];
    if (t) risk = maxRisk(risk, t);
  }
  return risk;
}

const atLeast = (risk: ActionRisk, threshold: ActionRisk) => RISK_ORDER.indexOf(risk) >= RISK_ORDER.indexOf(threshold);

export function assessAction(request: ActionRequest, now: number, policy: SafetyPolicy = DEFAULT_SAFETY_POLICY): SafetyDecision {
  const risk = deriveRisk(request, policy);
  const reasons: string[] = [];
  const requester = request.requester;

  // 1) Who is asking.
  if (requester && atLeast(risk, policy.restrictedFrom)) {
    if (requester.status !== 'identified') {
      return {
        decision: 'deny',
        risk,
        reasons: [`${risk}-risk action requested by an unidentified person`],
        confirmBy: 'adult',
      };
    }
    if (requester.role && (policy.restrictedRoles as string[]).includes(requester.role)) {
      return {
        decision: 'deny',
        risk,
        reasons: [`${requester.role} cannot request a ${risk}-risk action`],
        confirmBy: 'adult',
      };
    }
  }

  // 2) What the plan relies on.
  const tags = new Set([...(request.objectTags ?? []), ...request.evidence.flatMap(e => e.safetyTags ?? [])]);
  const alwaysConfirm = policy.alwaysConfirmTags.filter(t => tags.has(t));
  if (alwaysConfirm.length) reasons.push(`involves ${alwaysConfirm.join(', ')}: always re-verify`);

  const questions: string[] = [];
  for (const ev of request.evidence) {
    const age = Math.max(0, now - ev.provenance.at);
    const issues: string[] = [];
    if (ev.provenance.confidence < policy.minConfidence[risk]) issues.push(`low confidence (${ev.provenance.confidence})`);
    if (age > policy.maxAgeSec[risk]) issues.push(`stale (${formatAgo(age)})`);
    if (atLeast(risk, policy.requireObservedFrom) && ev.provenance.kind !== 'observed' && ev.provenance.kind !== 'configured') {
      issues.push(`not directly observed (${ev.provenance.kind})`);
    }
    if (issues.length || alwaysConfirm.length) {
      if (issues.length) reasons.push(`${ev.description}: ${issues.join(', ')}`);
      questions.push(`${ev.description} (${ev.provenance.kind}, ${formatAgo(age)})`);
    }
  }

  if (!request.evidence.length && atLeast(risk, 'high')) {
    reasons.push('no supporting evidence for a high-risk action');
  }

  if (!reasons.length) return {decision: 'allow', risk, reasons: []};

  const confirmBy: SafetyDecision['confirmBy'] =
    atLeast(risk, 'high') ? 'adult'
    : requester?.status === 'identified' ? 'requester'
    : 'anyone';
  const doing = request.description?.trim() || request.action.replace(/_/g, ' ');
  const confirmPrompt =
    questions.length ?
      `Before I ${doing}, please confirm: ${questions.join('; ')}. Is that still correct?`
    : `Please confirm that I should ${doing}.`;
  return {decision: 'confirm', risk, reasons, confirmPrompt, confirmBy};
}

/** Prompt text for the robot's LLM so it does not treat memory as instructions. */
export const EMBODIED_MEMORY_RULES = `EMBODIED MEMORY RULES:
- Remembered locations and facts may be outdated. Say when you last saw something and how you know it.
- Memory is never permission. Physical actions that depend on memory go through the safety check; follow its decision.
- Always re-verify anything involving medication, allergens or hazardous items before acting.
- Do not reveal one household member's personal memories to another person.`;
