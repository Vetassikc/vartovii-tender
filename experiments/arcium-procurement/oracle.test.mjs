import assert from "node:assert/strict";
import { test } from "node:test";

import { solveAllocation } from "./oracle.mjs";

const canonical = {
  prices: [
    [40, 40],
    [55, 50],
    [45, 60],
  ],
  capacities: [1, 2, 1],
};

test("canonical fixture enumerates all nine assignments and selects C then A at 85", () => {
  assert.deepEqual(solveAllocation(canonical), {
    status: "valid",
    statusCode: 0,
    winners: [2, 0],
    winningPrices: [45, 40],
    total: 85,
    enumeratedAssignments: 9,
  });
});

test("equal totals use the lexicographically smallest feasible supplier pair", () => {
  assert.deepEqual(
    solveAllocation({
      prices: [
        [10, 20],
        [10, 20],
        [100, 100],
      ],
      capacities: [1, 1, 1],
    }),
    {
      status: "valid",
      statusCode: 0,
      winners: [0, 1],
      winningPrices: [10, 20],
      total: 30,
      enumeratedAssignments: 9,
    }
  );
});

test("all-zero capacity returns an explicit no-feasible result with sentinel winners", () => {
  assert.deepEqual(
    solveAllocation({
      prices: [
        [40, 40],
        [55, 50],
        [45, 60],
      ],
      capacities: [0, 0, 0],
    }),
    {
      status: "no_feasible",
      statusCode: 2,
      winners: [3, 3],
      winningPrices: [0, 0],
      total: 0,
      enumeratedAssignments: 9,
    }
  );
});

test("out-of-range price or capacity returns explicit invalid input without a winner", () => {
  for (const input of [
    {
      prices: [
        [1_000_001, 40],
        [55, 50],
        [45, 60],
      ],
      capacities: [1, 2, 1],
    },
    {
      prices: canonical.prices,
      capacities: [1, 3, 1],
    },
  ]) {
    assert.deepEqual(solveAllocation(input), {
      status: "invalid_input",
      statusCode: 1,
      winners: [3, 3],
      winningPrices: [0, 0],
      total: 0,
      enumeratedAssignments: 0,
    });
  }
});

test("maximum valid prices remain within the two-million total bound", () => {
  assert.deepEqual(
    solveAllocation({
      prices: [
        [1_000_000, 1_000_000],
        [1_000_000, 1_000_000],
        [1_000_000, 1_000_000],
      ],
      capacities: [1, 2, 1],
    }),
    {
      status: "valid",
      statusCode: 0,
      winners: [0, 1],
      winningPrices: [1_000_000, 1_000_000],
      total: 2_000_000,
      enumeratedAssignments: 9,
    }
  );
});
