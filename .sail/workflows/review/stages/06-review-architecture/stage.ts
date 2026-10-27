// review-architecture: one of review's six reviewers: does the change fit the codebase: its layers, its contracts, what
// already exists? It reports findings with a severity and what it checked, and judges nothing: the judge decides what
// each finding becomes.
import { reviewer } from '../../reviewer';

export const reviewArchitecture = reviewer('review-architecture');
