// Simple token-bucket rate limiter.
//
// Gmail's per-user quota is 250 units/sec. We target 200 to leave
// headroom for the user's own actions (modify, send, etc.) that also
// charge against the same budget.
//
// Each call to `take(units)` resolves as soon as the bucket has enough
// tokens; if not, it sleeps just long enough for refill.

export class RateLimiter {
  constructor(budgetPerSec) {
    this.budgetPerSec = budgetPerSec;
    this.tokens = budgetPerSec;
    this.lastRefill = Date.now();
  }

  async take(units) {
    while (true) {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.budgetPerSec, this.tokens + elapsed * this.budgetPerSec);
      this.lastRefill = now;
      if (this.tokens >= units) {
        this.tokens -= units;
        return;
      }
      const waitMs = Math.ceil(((units - this.tokens) / this.budgetPerSec) * 1000);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

// Shared instance — every sync engine consumer uses the same budget so
// concurrent accounts can't double-spend.
export const gmailLimiter = new RateLimiter(200);
