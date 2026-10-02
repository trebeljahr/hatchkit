import { Redis } from "ioredis";
import { env } from "../config/env.js";

let redis: Redis | null = null;
let roomSubscriber: Redis | null = null;
let roomSubscriberRequired = false;

export function getRedis(): Redis | null {
  return redis;
}

export function isRedisReady(): boolean {
  return !env.REDIS_URL ||
    (redis?.status === "ready" && (!roomSubscriberRequired || roomSubscriber?.status === "ready"));
}

export function setRoomSubscriber(client: Redis | null): void {
  roomSubscriber = client;
  if (client) roomSubscriberRequired = true;
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
  roomSubscriber = null;
  roomSubscriberRequired = false;
  console.log("[redis] Disconnected from Redis");
}
