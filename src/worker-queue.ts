// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * A fair queue in front of each region's upstream (worker-regions.ts).
 *
 * An upstream account takes only so many requests at once and so many a minute, for everyone
 * together, and refuses the rest at once. A refused request still counts against the minute. So
 * requests are not passed through to be refused: each waits here for its turn.
 *
 *   - No more requests are in flight than the region allows (`parallel`), and no more are sent in
 *     a clock minute than it allows (`perMinute`). Every request sent counts, answered or not.
 *   - Accounts take turns. One person's folder of fifty files does not hold up another person's
 *     single question: the next request sent is the next account's, not the next in line.
 *   - When the upstream says to wait (`Retry-After`), nothing is sent to it until then.
 *   - The wait is bounded. A request that has not been sent within `maxWaitMs` is answered as
 *     busy, with how many are waiting. It is never sent to another region's upstream.
 *
 * The queue is in this process's memory: one server runs the service. It holds callers, not what
 * they sent beyond the request already in memory, and nothing of it is written anywhere.
 */

export interface QueueLimits {
  /** Requests in flight at once. */
  readonly parallel: number;
  /** Requests sent in one clock minute. 0: no limit. */
  readonly perMinute: number;
  /** How long a request may wait for its turn before it is answered as busy. */
  readonly maxWaitMs: number;
  /** Requests that may wait at once, over all accounts. One more is answered as busy at once. */
  readonly maxWaiting: number;
}

export interface QueueClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: QueueClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type Admission =
  /** The request may be sent now. `release` must be called once its answer is in, or it failed. */
  | { readonly admitted: true; readonly waitedMs: number; readonly release: () => void }
  /** Not sent: the wait ran out, or too many are waiting. `waiting` counts this request too. */
  | { readonly admitted: false; readonly reason: "busy"; readonly waiting: number; readonly retryAfterSeconds: number }
  /** Not sent: the caller went away while waiting. */
  | { readonly admitted: false; readonly reason: "gone" };

interface Waiter {
  readonly account: string;
  readonly since: number;
  readonly resolve: (admission: Admission) => void;
  timer: unknown;
  forget: () => void;
}

export interface EnterOptions {
  /** Aborts when the caller goes away, so that its place is not kept. */
  readonly signal?: AbortSignal | undefined;
  /** The time by which the request must have been sent. Unset: `maxWaitMs` from now. */
  readonly deadlineAt?: number | undefined;
  /** A request the upstream refused although it was sent in turn: it goes first, not last. */
  readonly front?: boolean | undefined;
}

export class WorkerQueue {
  limits: QueueLimits;
  readonly #clock: QueueClock;
  #active = 0;
  /** Each account's waiting requests, oldest first. */
  readonly #waiting = new Map<string, Array<Waiter>>();
  /** The accounts that have someone waiting, in the order their turns come. */
  #turns: Array<string> = [];
  #minute = -1;
  #sentThisMinute = 0;
  #blockedUntil = 0;
  #wake: unknown = null;

  constructor(limits: QueueLimits, clock: QueueClock = systemClock) {
    this.limits = limits;
    this.#clock = clock;
  }

  /** What the app is shown: how many requests the region takes at once, and how busy it is. */
  state(): { readonly parallel: number; readonly active: number; readonly waiting: number } {
    return { parallel: this.limits.parallel, active: this.#active, waiting: this.#waitingCount() };
  }

  /** The upstream said to send nothing for this long. */
  blockFor(ms: number): void {
    this.#blockedUntil = Math.max(this.#blockedUntil, this.#clock.now() + Math.max(0, ms));
    this.#pump();
  }

  enter(account: string, options: EnterOptions = {}): Promise<Admission> {
    return new Promise<Admission>((resolve) => {
      const now = this.#clock.now();
      const deadlineAt = options.deadlineAt ?? now + this.limits.maxWaitMs;
      if (options.signal?.aborted === true) return resolve({ admitted: false, reason: "gone" });
      if (this.#waitingCount() >= this.limits.maxWaiting || deadlineAt <= now) {
        return resolve({ admitted: false, reason: "busy", waiting: this.#waitingCount() + 1, retryAfterSeconds: this.#retryAfterSeconds() });
      }
      const waiter: Waiter = { account, since: now, resolve, timer: null, forget: () => undefined };
      const leave = (admission: Admission) => {
        if (!this.#remove(waiter)) return;
        resolve(admission);
      };
      waiter.timer = this.#clock.setTimeout(
        // Counted before it leaves, so the number includes the request being answered.
        () => leave({ admitted: false, reason: "busy", waiting: this.#waitingCount(), retryAfterSeconds: this.#retryAfterSeconds() }),
        deadlineAt - now,
      );
      const gone = () => leave({ admitted: false, reason: "gone" });
      options.signal?.addEventListener("abort", gone, { once: true });
      waiter.forget = () => options.signal?.removeEventListener("abort", gone);

      const line = this.#waiting.get(account);
      if (line === undefined) {
        this.#waiting.set(account, [waiter]);
        if (options.front === true) this.#turns.unshift(account);
        else this.#turns.push(account);
      } else if (options.front === true) {
        line.unshift(waiter);
        this.#turns = [account, ...this.#turns.filter((other) => other !== account)];
      } else {
        line.push(waiter);
      }
      this.#pump();
    });
  }

  #waitingCount(): number {
    let total = 0;
    for (const line of this.#waiting.values()) total += line.length;
    return total;
  }

  #sentInMinute(now: number): number {
    const minute = Math.floor(now / 60_000);
    if (minute !== this.#minute) {
      this.#minute = minute;
      this.#sentThisMinute = 0;
    }
    return this.#sentThisMinute;
  }

  /** When the next request could be sent, if only time is in the way. Null: a slot is. */
  #waitUntil(now: number): number | null {
    let until = 0;
    if (now < this.#blockedUntil) until = this.#blockedUntil;
    if (this.limits.perMinute > 0 && this.#sentInMinute(now) >= this.limits.perMinute) {
      until = Math.max(until, (Math.floor(now / 60_000) + 1) * 60_000);
    }
    return until === 0 ? null : until;
  }

  #retryAfterSeconds(): number {
    const now = this.#clock.now();
    const until = this.#waitUntil(now);
    return until === null ? 5 : Math.max(1, Math.ceil((until - now) / 1000));
  }

  #remove(waiter: Waiter): boolean {
    const line = this.#waiting.get(waiter.account);
    const index = line?.indexOf(waiter) ?? -1;
    if (line === undefined || index < 0) return false;
    line.splice(index, 1);
    if (line.length === 0) {
      this.#waiting.delete(waiter.account);
      this.#turns = this.#turns.filter((account) => account !== waiter.account);
    }
    this.#clock.clearTimeout(waiter.timer);
    waiter.forget();
    return true;
  }

  #pump(): void {
    for (;;) {
      if (this.#turns.length === 0 || this.#active >= this.limits.parallel) return;
      const now = this.#clock.now();
      const until = this.#waitUntil(now);
      if (until !== null) {
        // Only time is in the way: look again when it has passed.
        if (this.#wake !== null) this.#clock.clearTimeout(this.#wake);
        this.#wake = this.#clock.setTimeout(() => {
          this.#wake = null;
          this.#pump();
        }, until - now);
        return;
      }
      // The next account's turn. If it has more waiting, it goes to the back of the turns.
      const account = this.#turns.shift();
      const line = account === undefined ? undefined : this.#waiting.get(account);
      const waiter = line?.shift();
      if (account === undefined || line === undefined || waiter === undefined) continue;
      if (line.length === 0) this.#waiting.delete(account);
      else this.#turns.push(account);
      this.#clock.clearTimeout(waiter.timer);
      waiter.forget();
      this.#active += 1;
      this.#sentThisMinute += 1;
      let released = false;
      waiter.resolve({
        admitted: true,
        waitedMs: now - waiter.since,
        release: () => {
          if (released) return;
          released = true;
          this.#active -= 1;
          this.#pump();
        },
      });
    }
  }
}
