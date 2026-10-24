export class IntakeError extends Error {
  constructor(public readonly rawId: string, message: string) { super(message); this.name = "IntakeError"; }
}

const DECIMAL = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/** Exact decimal-dollars to integer cents. Parses text, never multiplies a float by 100. */
export function dollarsToCents(value: unknown, rawId: string): number {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new IntakeError(rawId, "Amount is not a finite number");
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    throw new IntakeError(rawId, "Amount must be a number or decimal string");
  }
  const match = DECIMAL.exec(text);
  if (!match) throw new IntakeError(rawId, `Amount ${JSON.stringify(text)} cannot be represented exactly in cents`);
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(Number(whole) * 100)) throw new IntakeError(rawId, "Amount exceeds the safe integer-cent range");
  return sign ? -cents : cents;
}

export function isPositiveCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function formatCents(cents: number, currency = "USD"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${sign}${symbol}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** YYYY-MM-DD as UTC midnight epoch milliseconds. */
export function utcDate(value: unknown, rawId: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new IntakeError(rawId, "Date must be YYYY-MM-DD");
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new IntakeError(rawId, `Invalid calendar date ${value}`);
  return ms;
}
