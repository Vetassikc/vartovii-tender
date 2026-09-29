import { x25519 } from "@noble/curves/ed25519";

export function createEncryptionIdentity() {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function deriveRescueSharedSecret(secretKey, peerPublicKey) {
  return x25519.getSharedSecret(secretKey, peerPublicKey);
}

export function requireTenderDto(tender) {
  if (!tender || !Number.isSafeInteger(tender.deadline)) {
    throw new Error("Tender response is missing a numeric deadline.");
  }
  if (typeof tender.tenderId !== "string" || !/^[0-9a-f]{32}$/i.test(tender.tenderId)) {
    throw new Error("Tender response has an invalid tender id.");
  }
  return tender;
}
