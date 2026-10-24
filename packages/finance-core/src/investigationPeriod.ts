/** datetime-local strings have no offset: Date.parse interprets them in the user's local timezone. */
export function investigationPeriod(fromDate: string, cutoffDate: string): { from: number | null; cutoff?: number } {
  const parse = (value: string): number => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) {
      throw new Error("Choose a valid local date and time.");
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new Error("Choose a valid local date and time.");
    return timestamp;
  };
  const from = fromDate ? parse(fromDate) : null;
  const cutoff = cutoffDate ? parse(cutoffDate) : undefined;
  if (from !== null && cutoff !== undefined && from > cutoff) {
    throw new Error("Choose a review period ending at or after its start.");
  }
  // Do not consult the browser clock for the default or for future-date validation.
  return { from, ...(cutoff === undefined ? {} : { cutoff }) };
}
