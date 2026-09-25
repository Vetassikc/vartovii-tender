const MAX_PRICE = 1_000_000;
const MAX_CAPACITY = 2;
const INVALID_SUPPLIER = 3;

function emptyResult(status, statusCode, enumeratedAssignments) {
  return {
    status,
    statusCode,
    winners: [INVALID_SUPPLIER, INVALID_SUPPLIER],
    winningPrices: [0, 0],
    total: 0,
    enumeratedAssignments,
  };
}

function hasExpectedShape(input) {
  return (
    input !== null &&
    typeof input === "object" &&
    Array.isArray(input.prices) &&
    input.prices.length === 3 &&
    input.prices.every(
      (supplierPrices) =>
        Array.isArray(supplierPrices) && supplierPrices.length === 2
    ) &&
    Array.isArray(input.capacities) &&
    input.capacities.length === 3
  );
}

function hasValidBounds(input) {
  return (
    input.prices.flat().every(
      (price) =>
        Number.isSafeInteger(price) && price >= 0 && price <= MAX_PRICE
    ) &&
    input.capacities.every(
      (capacity) =>
        Number.isSafeInteger(capacity) &&
        capacity >= 0 &&
        capacity <= MAX_CAPACITY
    )
  );
}

function assignmentIsFeasible(firstSupplier, secondSupplier, capacities) {
  if (firstSupplier === secondSupplier) {
    return capacities[firstSupplier] >= 2;
  }
  return (
    capacities[firstSupplier] >= 1 && capacities[secondSupplier] >= 1
  );
}

function solveAllocation(input) {
  if (!hasExpectedShape(input) || !hasValidBounds(input)) {
    return emptyResult("invalid_input", 1, 0);
  }

  let best = null;
  let enumeratedAssignments = 0;

  for (let firstSupplier = 0; firstSupplier < 3; firstSupplier += 1) {
    for (let secondSupplier = 0; secondSupplier < 3; secondSupplier += 1) {
      enumeratedAssignments += 1;
      if (
        !assignmentIsFeasible(
          firstSupplier,
          secondSupplier,
          input.capacities
        )
      ) {
        continue;
      }

      const firstPrice = input.prices[firstSupplier][0];
      const secondPrice = input.prices[secondSupplier][1];
      const total = firstPrice + secondPrice;

      if (best === null || total < best.total) {
        best = {
          winners: [firstSupplier, secondSupplier],
          winningPrices: [firstPrice, secondPrice],
          total,
        };
      }
    }
  }

  if (best === null) {
    return emptyResult("no_feasible", 2, enumeratedAssignments);
  }

  return {
    status: "valid",
    statusCode: 0,
    winners: best.winners,
    winningPrices: best.winningPrices,
    total: best.total,
    enumeratedAssignments,
  };
}

module.exports = {
  MAX_PRICE,
  MAX_CAPACITY,
  INVALID_SUPPLIER,
  solveAllocation,
};
