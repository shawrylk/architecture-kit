// Money is held in integer cents so that sums never drift.
export type Cents = number;

export function toCents(amount: number): Cents {
  return Math.round(amount * 100);
}

export function formatCents(cents: Cents, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

// Round half away from zero, which is what the payment provider does.
export function roundCents(value: number): Cents {
  return Math.sign(value) * Math.round(Math.abs(value));
}
