export const IMAGE_LIMIT = 2 * 1024 * 1024;

export function imageType(bytes) {
  if (bytes.length > IMAGE_LIMIT || bytes.length < 12) throw new Error("invalid_image");
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { type: "image/png", extension: "png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return { type: "image/jpeg", extension: "jpg" };
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { type: "image/webp", extension: "webp" };
  throw new Error("invalid_image");
}

export async function readLimited(response, maximum) {
  if (!response.ok) throw new Error("source_unavailable");
  if (Number(response.headers.get("content-length")) > maximum) throw new Error("source_too_large");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximum) throw new Error("source_too_large");
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
