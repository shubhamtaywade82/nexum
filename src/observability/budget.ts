export type TokenBudget = {
  limit: number;
  usedInput: number;
  usedOutput: number;
};

export function createTokenBudget(limit = 0): TokenBudget {
  return { limit, usedInput: 0, usedOutput: 0 };
}

export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): TokenBudget {
  // Inline (not platform readEnv) because this helper takes an injected env.
  const raw = env.NEXUM_TOKEN_BUDGET ?? "0";
  const limit = Number(raw);
  return createTokenBudget(Number.isFinite(limit) && limit > 0 ? limit : 0);
}

export function recordUsage(budget: TokenBudget, inputTokens = 0, outputTokens = 0): void {
  budget.usedInput += Math.max(0, inputTokens);
  budget.usedOutput += Math.max(0, outputTokens);
}

export function totalUsed(budget: TokenBudget): number {
  return budget.usedInput + budget.usedOutput;
}

export function isBudgetExceeded(budget: TokenBudget): boolean {
  if (budget.limit <= 0) return false;
  return totalUsed(budget) >= budget.limit;
}
