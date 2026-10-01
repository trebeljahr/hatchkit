import assert from "node:assert/strict";
import { test } from "node:test";
import { readLimitedMlResponse } from "../services/ml-response.js";

test("accepts a response within the byte limit", async () => {
  const body = await readLimitedMlResponse(new Response("hello"), 5);
  assert.equal(body.toString("utf8"), "hello");
});

test("rejects an oversized declared body before reading it", async () => {
  const response = new Response("hello", { headers: { "content-length": "100" } });
  await assert.rejects(readLimitedMlResponse(response, 5), /exceeds 5 bytes/);
});

test("rejects a streamed body that exceeds the limit without a length header", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    },
  }));
  await assert.rejects(readLimitedMlResponse(response, 5), /exceeds 5 bytes/);
});
