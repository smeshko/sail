// review-requirements: one of review's six reviewers: does the change do what its requirements ask, all of it and
// nothing more? It reports findings with a severity and what it checked, and judges nothing: the judge decides what
// each finding becomes.
import { reviewer } from '../../reviewer';

export const reviewRequirements = reviewer('review-requirements');
