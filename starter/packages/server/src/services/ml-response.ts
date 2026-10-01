/** Read an upstream body without trusting Content-Length or buffering without a cap. */
export async function readLimitedMlResponse(res: Response, maxBytes: number): Promise<Buffer> {
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await res.body?.cancel();
    throw new Error(`ML response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`ML response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
