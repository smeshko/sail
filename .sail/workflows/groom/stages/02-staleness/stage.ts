// staleness: says whether the repository already does what the ticket asks, with the evidence.
import { checker } from '../../checker';
import { Staleness } from '../../schemas';

export const staleness = checker('staleness', Staleness);
