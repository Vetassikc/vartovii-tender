import { sha256 } from "@noble/hashes/sha2";
import { sha3_256 } from "@noble/hashes/sha3";

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new TypeError("Unsupported hash input");
}

function concat(chunks) {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function randomBytes(length) {
  const result = new Uint8Array(length);
  for (let offset = 0; offset < result.length; offset += 65536) {
    crypto.getRandomValues(result.subarray(offset, Math.min(offset + 65536, result.length)));
  }
  return result;
}

export function createHash(algorithm) {
  const chunks = [];
  return {
    update(value) {
      chunks.push(asBytes(value));
      return this;
    },
    digest() {
      const input = concat(chunks);
      if (algorithm === "sha256") return sha256(input);
      if (algorithm === "sha3-256") return sha3_256(input);
      throw new Error(`Unsupported browser hash: ${algorithm}`);
    },
  };
}
