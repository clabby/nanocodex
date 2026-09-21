// The native helper owns this private JSONL optimization. DesktopRuntime keeps
// its full, immutable snapshot contract for in-process consumers and requests.
export class NativeThreadEvents {
  #threads = new Map();
  #accountScope;
  #generation = 0;

  forget(id) { this.#threads.delete(id); }

  encode(event) {
    if (event.type === "state") {
      if (event.state.accountScope !== this.#accountScope) {
        this.#threads.clear();
        this.#accountScope = event.state.accountScope;
      }
      return event;
    }
    if (event.type !== "thread") return event;

    const { thread } = event;
    const previous = this.#threads.get(thread.id);
    // Runtime envelopes are immutable and retain identity across snapshots.
    // Check the entire prefix: older pages, out-of-order delivery, and retention
    // pruning must send a full replacement, including when length is unchanged.
    if (!previous || previous.events.length > thread.events.length
      || !previous.events.every((entry, index) => entry === thread.events[index])) {
      const generation = ++this.#generation;
      this.#threads.set(thread.id, { events: thread.events, generation });
      return { ...event, eventGeneration: generation };
    }
    this.#threads.set(thread.id, { events: thread.events, generation: previous.generation });

    return {
      type: "threadPatch",
      eventOffset: previous.events.length,
      eventGeneration: previous.generation,
      thread: { ...thread, events: thread.events.slice(previous.events.length) },
    };
  }
}
