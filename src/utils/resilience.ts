// Модуль отказоустойчивости: TTL-кэш, Circuit Breaker, ретраи с exponential backoff и метрики
// Работает in-memory без внешних зависимостей (Redis / pybreaker) с возможностью легкой замены адаптера

export interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  public hits = 0;
  public misses = 0;

  constructor(defaultTtlMs = 15 * 60 * 1000, maxEntries = 500) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): { value: T; storedAt: number } | null {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return { value: entry.value, storedAt: entry.storedAt };
  }

  /**
   * Возвращает даже просроченную запись как аварийный fallback при открытом Circuit Breaker
   */
  getStale(key: string): { value: T; storedAt: number } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    return { value: entry.value, storedAt: entry.storedAt };
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    const now = Date.now();
    this.store.set(key, {
      value,
      storedAt: now,
      expiresAt: now + (ttlMs ?? this.defaultTtlMs)
    });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  size(): number {
    return this.store.size;
  }
}

export interface CircuitState {
  failures: number;
  openedAt: number | null;
  lastError?: string;
  totalFailures: number;
  totalSuccesses: number;
  rateLimitedCount: number;
}

export class CircuitBreakerRegistry {
  private circuits = new Map<string, CircuitState>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(failureThreshold = 5, cooldownMs = 10 * 60 * 1000) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
  }

  private getOrCreate(key: string): CircuitState {
    let state = this.circuits.get(key);
    if (!state) {
      state = {
        failures: 0,
        openedAt: null,
        totalFailures: 0,
        totalSuccesses: 0,
        rateLimitedCount: 0
      };
      this.circuits.set(key, state);
    }
    return state;
  }

  isOpen(key: string): boolean {
    const state = this.getOrCreate(key);
    if (state.openedAt === null) return false;
    if (Date.now() - state.openedAt >= this.cooldownMs) {
      // Переход в half-open состояние
      state.openedAt = null;
      state.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(key: string): void {
    const state = this.getOrCreate(key);
    state.failures = 0;
    state.openedAt = null;
    state.totalSuccesses++;
  }

  recordFailure(key: string, reason: string, isRateLimit = false): void {
    const state = this.getOrCreate(key);
    state.failures++;
    state.totalFailures++;
    state.lastError = reason;
    if (isRateLimit) {
      state.rateLimitedCount++;
    }
    if (state.failures >= this.failureThreshold) {
      state.openedAt = Date.now();
    }
  }

  getSnapshot(): Record<string, { status: 'open' | 'closed'; failures: number; totalSuccesses: number; totalFailures: number; rateLimitedCount: number; lastError?: string }> {
    const result: Record<string, { status: 'open' | 'closed'; failures: number; totalSuccesses: number; totalFailures: number; rateLimitedCount: number; lastError?: string }> = {};
    this.circuits.forEach((state, key) => {
      result[key] = {
        status: this.isOpen(key) ? 'open' : 'closed',
        failures: state.failures,
        totalSuccesses: state.totalSuccesses,
        totalFailures: state.totalFailures,
        rateLimitedCount: state.rateLimitedCount,
        lastError: state.lastError
      };
    });
    return result;
  }
}

export const marketplaceCircuitBreaker = new CircuitBreakerRegistry(5, 10 * 60 * 1000);

export interface ResilientFetchOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  circuitKey?: string;
  headers?: Record<string, string>;
}

/**
 * Обертка над fetch с таймаутом, exponential backoff (макс 3 попытки),
 * обработкой 429 (удвоение паузы) и защитой Circuit Breaker.
 */
export async function resilientFetch(
  url: string,
  options: ResilientFetchOptions = {}
): Promise<Response | null> {
  const {
    timeoutMs = 2800,
    maxRetries = 3,
    baseDelayMs = 300,
    circuitKey,
    headers
  } = options;

  if (circuitKey && marketplaceCircuitBreaker.isOpen(circuitKey)) {
    return null;
  }

  let delay = baseDelayMs;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json, text/plain, */*',
          ...headers
        }
      });
      clearTimeout(timer);

      if (response.status === 429) {
        if (circuitKey) {
          marketplaceCircuitBreaker.recordFailure(circuitKey, 'HTTP 429 Rate Limit', true);
        }
        delay *= 2;
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return null;
      }

      if (response.ok) {
        if (circuitKey) {
          marketplaceCircuitBreaker.recordSuccess(circuitKey);
        }
        return response;
      }

      // 404 не является аварией площадки — просто ресурс не найден
      if (response.status === 404) {
        return response;
      }

      if (circuitKey) {
        marketplaceCircuitBreaker.recordFailure(circuitKey, `HTTP ${response.status}`);
      }
    } catch (err: any) {
      clearTimeout(timer);
      if (circuitKey) {
        marketplaceCircuitBreaker.recordFailure(circuitKey, err?.name === 'AbortError' ? 'Timeout' : (err?.message || 'Network error'));
      }
    }

    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }

  return null;
}
