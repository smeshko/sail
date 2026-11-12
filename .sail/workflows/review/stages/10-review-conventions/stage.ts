// review-conventions: one of review's six reviewers: does the change follow AGENTS.md and CONTEXT.md, and is it fit for
// a public repository? It reports findings with a severity and what it checked, and judges nothing: the judge decides
// what each finding becomes.
import { reviewer } from '../../reviewer';

// The reviewer that checks the vocabulary, so it alone reads the glossary beside AGENTS.md.
export const reviewConventions = reviewer('review-conventions', 'fast', { conventions: ['AGENTS.md', 'CONTEXT.md'] });
