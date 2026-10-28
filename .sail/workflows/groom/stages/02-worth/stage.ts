// worth: says whether the groomed ticket earns its place or should be canceled, and which open tickets it should be
// merged with, each with a confidence. The workflow, not the judge, applies the threshold to these numbers.
import { checker } from '../../checker';
import { Worth } from '../../schemas';

export const worth = checker('worth', Worth);
