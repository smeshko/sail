// worth: says whether the groomed ticket earns its place or should be canceled, which open tickets it should be
// merged with, each with a confidence, and whether it is stale (the repository already does what it asks). The workflow, not the judge, applies the threshold to these numbers.
import { checker } from '../../checker';
import { Worth } from '../../schemas';

export const worth = checker('worth', Worth);
