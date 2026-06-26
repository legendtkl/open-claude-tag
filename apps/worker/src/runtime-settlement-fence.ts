export class RuntimeSettlementFence {
  private readonly settlements = new Map<string, RuntimeSettlementRecord>();

  watch(taskId: string): RuntimeSettlementRecord {
    return this.getOrCreate(taskId);
  }

  settle(taskId: string, errorMessage: string): void {
    const settlement = this.getOrCreate(taskId);
    if (settlement.errorMessage) return;
    settlement.errorMessage = errorMessage;
    settlement.resolve(errorMessage);
  }

  throwIfSettled(taskId: string): void {
    const errorMessage = this.settlements.get(taskId)?.errorMessage;
    if (errorMessage) {
      throw new RuntimeWatchdogSettledError(errorMessage);
    }
  }

  clear(taskId: string): void {
    this.settlements.delete(taskId);
  }

  async race<T>(taskId: string, promise: Promise<T>): Promise<T> {
    const settlement = this.watch(taskId);
    if (settlement.errorMessage) {
      throw new RuntimeWatchdogSettledError(settlement.errorMessage);
    }

    return Promise.race([
      promise,
      settlement.promise.then((errorMessage) => {
        throw new RuntimeWatchdogSettledError(errorMessage);
      }),
    ]);
  }

  private getOrCreate(taskId: string): RuntimeSettlementRecord {
    const existing = this.settlements.get(taskId);
    if (existing) return existing;

    let resolve!: (errorMessage: string) => void;
    const promise = new Promise<string>((settle) => {
      resolve = settle;
    });
    const settlement = { promise, resolve, errorMessage: null };
    this.settlements.set(taskId, settlement);
    return settlement;
  }
}

export interface RuntimeSettlementRecord {
  promise: Promise<string>;
  resolve(errorMessage: string): void;
  errorMessage: string | null;
}

export class RuntimeWatchdogSettledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeWatchdogSettledError';
  }
}
