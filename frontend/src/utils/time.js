// The backend stores times in UTC and sends them without a time zone ("2026-11-08T16:14:03").
// JavaScript reads such a string as local time, which showed every time one hour early in Germany.
const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export function serverDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && NAIVE_ISO.test(value)) return new Date(value + 'Z');
  return new Date(value);
}
