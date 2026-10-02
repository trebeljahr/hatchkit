import assert from "node:assert/strict";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { mirror } from "./src/assets/mirror.js";

const listedPrefixes: Array<string | undefined> = [];
const source = {
  async send(command: ListObjectsV2Command) {
    listedPrefixes.push(command.input.Prefix);
    return {
      Contents: [
        { Key: "photos/a.png", Size: 1 },
        { Key: "photos-old/private.png", Size: 1 },
      ],
      IsTruncated: false,
    };
  },
};
const target = {
  async send() { return { Contents: [], IsTruncated: false }; },
};

for (const prefix of ["photos", "photos/"]) {
  const keys: string[] = [];
  const result = await mirror({
    source: { kind: "s3", client: source as never, bucket: "old", prefix, label: "old" },
    target: { kind: "s3", client: target as never, bucket: "new", label: "new" },
    dryRun: true,
    onObject(event) { keys.push(event.key); },
  });
  assert.equal(result.scanned, 1);
  assert.deepEqual(keys, ["a.png"]);
}
assert.deepEqual(listedPrefixes, ["photos/", "photos/"]);
console.log("assets mirror prefix tests passed");
