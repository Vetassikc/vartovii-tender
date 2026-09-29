export function isTrustedAward(result) {
  return result?.state === "finalized"
    && result?.verification === "verified-finalized-program-state"
    && isZeroResultStatus(result)
    && result?.award != null;
}

export function tenderLifecycleRailModel(result) {
  const states = ["open", "frozen", "queued", "finalized"];
  const currentIndex = states.indexOf(result?.state);
  return states.map((state, index) => ({
    state,
    active: currentIndex >= 0 && index <= currentIndex,
    current: currentIndex === index,
  }));
}

export function actionCopy(result) {
  if (result?.state === "open") return result.bidCount === 3 ? "All three encrypted bids are admitted. Freeze the tender." : "Waiting for three encrypted submissions.";
  if (result?.state === "frozen") return "The commitment is frozen. Queue the program-owned snapshot.";
  if (result?.state === "queued") return "MPC computation is pending. No award is available yet.";
  if (result?.state === "finalized" && !isZeroResultStatus(result)) {
    if (typeof result?.resultStatus !== "number" || !Number.isSafeInteger(result.resultStatus)) {
      return "Finalized state is missing a valid numeric result status. No award is trusted.";
    }
    return "Finalized without a valid allocation. No award is trusted.";
  }
  if (result?.state === "finalized" && isTrustedAward(result)) return "Allocation is verified on the local program.";
  if (result?.state === "finalized") return "Finalized state did not include a valid allocation. No award is trusted.";
  return "The tender is unavailable; no award is trusted.";
}

export function buyerReadoutModel(result) {
  const trusted = isTrustedAward(result);
  const accountState = result?.state ?? "unavailable";
  const resultStatus = Number.isSafeInteger(result?.resultStatus) ? result.resultStatus : null;
  return {
    trusted,
    title: trusted ? "Allocation is verified on the local program." : actionCopy(result),
    noAward: trusted ? null : result?.state === "finalized" ? "The finalized program state did not yield a valid allocation. No award is trusted." : "No award is shown until the program account is finalized and verified.",
    tender: result?.tender ?? null,
    commitment: result?.commitment ?? null,
    accountState,
    resultStatus,
    bidCount: result?.bidCount ?? null,
    accountReadAt: result?.timestamps?.readAt ?? null,
    award: trusted ? result.award : null,
    accountVerification: trusted
      ? "This receipt reads a finalized Tender account with result status 0."
      : `This receipt reads a ${accountState} Tender account with result status ${resultStatus ?? "unavailable or malformed"}. ${actionCopy(result)}`,
    callbackProvenance: "This page does not check callback transaction history for this Tender. A separate synthetic B3 run has retained, independently reviewed callback evidence.",
    verificationLimit: "This demo uses synthetic local data. Independent review covered one completed B3 run. B2 adversarial integrity and repeatability remain unverified. No devnet, production, customer-use, or independent-trust claim is made.",
  };
}

function isZeroResultStatus(result) {
  return typeof result?.resultStatus === "number"
    && Number.isSafeInteger(result.resultStatus)
    && result.resultStatus === 0;
}
