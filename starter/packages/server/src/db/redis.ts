import { Redis } from "ioredis";
import { env } from "../config/env.js";

let redis: Redis | null = null;
// A connected subscriber is not ready until Redis acknowledges its subscriptions
// and its owner has restored any state lost while disconnected.
const subscribers = new Map<string, { client: Redis | null; ready: boolean }>();

export function getRedis(): Redis | null {
  return redis;
}

export function isRedisReady(): boolean {
  return (
    !env.REDIS_URL ||
    (redis?.status === "ready" &&
      [...subscribers.values()].every(({ client, ready }) => ready && client?.status === "ready"))
  );
}

export function setRedisSubscriber(name: string, client: Redis | null, ready = false): void {
  subscribers.set(name, { client, ready });
}

export function setRoomSubscriber(client: Redis | null, ready = false): void {
  setRedisSubscriber("rooms", client, ready);
}

export async function connectRedis(): Promise<void> {
  if (!env.REDIS_URL) {
    console.log("[redis] No REDIS_URL configured, skipping Redis connection");
    return;
  }

  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  await redis.connect();
  console.log("[redis] Connected to Redis");
}

export async function disconnectRedis(): Promise<void> {
  if (!redis) return;
  await redis.quit();
  redis = null;
  subscribers.clear();
  console.log("[redis] Disconnected from Redis");
}
