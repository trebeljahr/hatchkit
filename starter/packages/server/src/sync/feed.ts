/**
 * The server-side fan-out for the sync feed: who is listening, and who gets a
 * change.
 *
 * **A subscriber's room is its authenticated user id and nothing else.** That
 * is the whole design, and it is the reason this module's surface is as small
 * as it is. There is no API here that lets a caller name a room from client
 * input: `subscribe` takes the user id the socket upgrade already
 * authenticated, and `publish` is only ever called with the user id the
 * mutation was performed as. A room a client can name is a room a client can
 * name *somebody else's* — and this feed carries every change to that
 * account's data, so a single `?roomId=` or a `join` frame would turn the
 * whole feed into a read API for other people's records. Compare
 * `ws/rooms.ts`, which is the opposite by design: an interactive room a client
 * joins by name, carrying only what clients deliberately put into it.
 *
 * Two more rules that fail quietly if broken:
 *
 *  - **A throwing `send` must never break the fan-out.** One subscriber whose
 *    socket has just gone away would otherwise swallow the event for every
 *    other device of that person — a missed refetch is invisible until
 *    somebody notices their phone is showing yesterday's data. So every send
 *    is wrapped, and a failure is dropped: the socket's own close handler is
 *    what unsubscribes it.
 *  - **This feed is in-process.** It fans out to the subscribers of THIS
 *    node, which is correct for a single-instance deployment and silently
 *    wrong for two: a person's phone connected to instance A would never hear
 *    about the mutation their laptop made against instance B. A multi-instance
 *    deployment needs a Redis (or any pub/sub) fan-out behind this same
 *    interface — publish to a channel, subscribe once per instance, deliver
 *    locally. The interface is deliberately narrow, three methods and no
 *    room names, precisely so that swap stays local to this file.
 */
import type { SyncEvent, SyncMessage } from "@starter/shared";

/**
 * A live listener: the user whose changes it receives, and how to hand it one.
 *
 * `userId` is not a parameter the subscriber chose. It is the id the upgrade
 * authenticated, passed in by the only caller that has it — see
 * `sync/handler.ts`.
 */
export type SyncSubscriber = {
  userId: string;
  send: (message: SyncMessage) => void;
};

/** What a publisher may say about a change, beyond the change itself. */
export type PublishOptions = {
  /**
   * The id the mutating client stamped its request with, echoed back so that
   * client can recognise its own change and skip a refetch it has already
   * applied locally.
   */
  originId?: string;
  /**
   * The tenant the change happened in, absent for a change about the account
   * rather than any one tenant. A socket carries every tenant the person
   * belongs to, so a consumer showing one needs this to leave the others
   * alone. It is NOT an authorisation boundary — the room is still the user.
   */
  tenantId?: string;
};

export class SyncFeed {
  /** user id → its live subscribers. Empty sets are deleted, not kept. */
  private readonly rooms = new Map<string, Set<SyncSubscriber>>();

  /**
   * Register a listener and get back its unsubscribe.
   *
   * The returned function is idempotent: a socket that both errors and closes
   * calls it twice, and the second call must not delete a room a reconnect has
   * meanwhile re-created.
   */
  subscribe(subscriber: SyncSubscriber): () => void {
    let room = this.rooms.get(subscriber.userId);
    if (!room) {
      room = new Set();
      this.rooms.set(subscriber.userId, room);
    }
    room.add(subscriber);

    return () => {
      const current = this.rooms.get(subscriber.userId);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) this.rooms.delete(subscriber.userId);
    };
  }

  /**
   * Deliver one event to every device of one user.
   *
   * `userId` is the user the mutation ran as — `ctx.user.id`, never a value
   * that came off the request body. Publishing to a user id a client supplied
   * would deliver that account's data to whoever asked for it, which is the
   * same hole as a client-named room wearing a different hat.
   */
  publish(userId: string, event: SyncEvent, options: PublishOptions = {}): void {
    const room = this.rooms.get(userId);
    if (!room || room.size === 0) return;

    const message: SyncMessage = {
      type: "sync",
      event,
      ...(options.originId !== undefined ? { originId: options.originId } : {}),
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    };

    // A copy, because a `send` that throws leads to a `close` that
    // unsubscribes, mutating the set we are iterating.
    for (const subscriber of [...room]) {
      try {
        subscriber.send(message);
      } catch (err) {
        // Never rethrown: a mutation must not fail because one of the
        // person's other devices has a dead socket. The socket's close
        // handler is what removes it.
        console.warn(`[sync] dropping event for a failing subscriber:`, err);
      }
    }
  }

  /** How many live subscribers a user has. For health output and tests. */
  count(userId: string): number {
    return this.rooms.get(userId)?.size ?? 0;
  }
}

/**
 * The process-wide feed.
 *
 * One instance, module-level, because the sockets it fans out to are also
 * process-wide. A second instance would be a second set of subscribers that
 * no mutation publishes to — a feed that connects and then says nothing.
 */
export const syncFeed = new SyncFeed();

/**
 * Tell every device of `userId` that something changed.
 *
 * The convenience every router calls, so a mutation's last line is one import
 * and one call rather than a reach into the feed's internals. Deliberately
 * returns nothing: a publish is best-effort and must never change what a
 * mutation answers.
 */
export const publishSync = (
  userId: string,
  event: SyncEvent,
  options?: PublishOptions,
): void => {
  syncFeed.publish(userId, event, options);
};
