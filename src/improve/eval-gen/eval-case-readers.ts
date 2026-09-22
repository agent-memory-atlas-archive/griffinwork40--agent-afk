/**
 * Read-side helpers for eval-case artifacts.
 *
 * These functions are pure query helpers — they only read from the eval-case
 * directory and depend only on types, path helpers, and schema validation.
 * No write-side state is needed here.
 *
 * @module improve/eval-gen/eval-case-readers
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { EvalCaseSchema, type EvalCase } from '../schemas.js';
import { getEvalCaseJsonPath, getEvalCasesDir } from '../paths.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EvalCaseListEntry {
  evalCaseId: string;
  cardSlug: string;
  proposalId: string | null;
  title: string;
  kind: EvalCase['kind'];
  status: EvalCase['status'];
  patternId: EvalCase['assertion']['patternId'];
  createdAt: string;
  sliceSha256: string;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export function listEvalCases(): EvalCaseListEntry[] {
  const dir = getEvalCasesDir();
  if (!existsSync(dir)) return [];
  const entries: EvalCaseListEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('.')) continue;
    if (name.endsWith('.fixture.jsonl')) continue; // never matches .json but defensive
    const ec = readEvalCaseIfExists(join(dir, name));
    if (!ec) continue;
    entries.push({
      evalCaseId: ec.evalCaseId,
      cardSlug: ec.cardSlug,
      proposalId: ec.proposalId,
      title: ec.title,
      kind: ec.kind,
      status: ec.status,
      patternId: ec.assertion.patternId,
      createdAt: ec.createdAt,
      sliceSha256: ec.replay.sliceSha256,
    });
  }
  // Newest first by createdAt; stable by id.
  entries.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.evalCaseId < b.evalCaseId ? -1 : 1;
  });
  return entries;
}

export function getEvalCase(evalCaseId: string): EvalCase | undefined {
  return readEvalCaseIfExists(getEvalCaseJsonPath(evalCaseId));
}

export function getEvalCasesForCard(cardSlug: string): EvalCase[] {
  return listEvalCases()
    .filter((e) => e.cardSlug === cardSlug)
    .map((e) => getEvalCase(e.evalCaseId))
    .filter((ec): ec is EvalCase => ec !== undefined);
}

export function getEvalCasesForProposal(proposalId: string): EvalCase[] {
  return listEvalCases()
    .filter((e) => e.proposalId === proposalId)
    .map((e) => getEvalCase(e.evalCaseId))
    .filter((ec): ec is EvalCase => ec !== undefined);
}

export function readEvalCaseIfExists(path: string): EvalCase | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    const validated = EvalCaseSchema.safeParse(parsed);
    if (!validated.success) return undefined;
    return validated.data;
  } catch {
    return undefined;
  }
}
