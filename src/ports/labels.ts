// GitHub's label names are case-insensitive, and every CodeHost matches labels so: `Factory` and `factory` are one label.
export const sameLabel = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const holdsLabel = (labels: readonly string[], label: string): boolean =>
  labels.some((each) => sameLabel(each, label));
