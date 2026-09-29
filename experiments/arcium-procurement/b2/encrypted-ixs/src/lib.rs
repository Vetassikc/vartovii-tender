//! Tender-bound confidential two-lot allocation.
//!
//! The three supplier inputs are separate encrypted values. The circuit never
//! receives a host-side plaintext aggregate and reveals only the bounded award
//! result. Supplier identity, tender binding and snapshot integrity are
//! enforced by the Anchor program before this circuit is queued.

use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    const MAX_PRICE: u64 = 1_000_000;
    const MAX_CAPACITY: u8 = 2;
    const INVALID_SUPPLIER: u8 = 3;

    pub struct SupplierInput {
        pub lot_0_price: u64,
        pub lot_1_price: u64,
        pub capacity: u8,
    }

    pub struct AllocationResult {
        pub status: u8,
        pub lot_0_supplier: u8,
        pub lot_1_supplier: u8,
        pub lot_0_price: u64,
        pub lot_1_price: u64,
        pub total: u64,
    }

    fn price(input: &SupplierInput, lot: u8) -> u64 {
        if lot == 0 {
            input.lot_0_price
        } else {
            input.lot_1_price
        }
    }

    fn capacity(input: &SupplierInput) -> u8 {
        input.capacity
    }

    fn pair_is_feasible(
        first: u8,
        second: u8,
        a: &SupplierInput,
        b: &SupplierInput,
        c: &SupplierInput,
    ) -> bool {
        let first_capacity = if first == 0 {
            capacity(a)
        } else if first == 1 {
            capacity(b)
        } else {
            capacity(c)
        };
        let second_capacity = if second == 0 {
            capacity(a)
        } else if second == 1 {
            capacity(b)
        } else {
            capacity(c)
        };
        if first == second {
            first_capacity >= 2
        } else {
            first_capacity >= 1 && second_capacity >= 1
        }
    }

    fn price_for(
        supplier: u8,
        lot: u8,
        a: &SupplierInput,
        b: &SupplierInput,
        c: &SupplierInput,
    ) -> u64 {
        if supplier == 0 {
            price(a, lot)
        } else if supplier == 1 {
            price(b, lot)
        } else {
            price(c, lot)
        }
    }

    #[instruction]
    pub fn allocate(
        a_ctxt: Enc<Shared, SupplierInput>,
        b_ctxt: Enc<Shared, SupplierInput>,
        c_ctxt: Enc<Shared, SupplierInput>,
    ) -> AllocationResult {
        let a = a_ctxt.to_arcis();
        let b = b_ctxt.to_arcis();
        let c = c_ctxt.to_arcis();

        let valid_input = a.lot_0_price <= MAX_PRICE
            && a.lot_1_price <= MAX_PRICE
            && b.lot_0_price <= MAX_PRICE
            && b.lot_1_price <= MAX_PRICE
            && c.lot_0_price <= MAX_PRICE
            && c.lot_1_price <= MAX_PRICE
            && a.capacity <= MAX_CAPACITY
            && b.capacity <= MAX_CAPACITY
            && c.capacity <= MAX_CAPACITY;

        let result = if !valid_input {
            AllocationResult {
                status: 1,
                lot_0_supplier: INVALID_SUPPLIER,
                lot_1_supplier: INVALID_SUPPLIER,
                lot_0_price: 0,
                lot_1_price: 0,
                total: 0,
            }
        } else {
            let mut found = false;
            let mut best_total = 0u64;
            let mut best_lot_0_supplier = INVALID_SUPPLIER;
            let mut best_lot_1_supplier = INVALID_SUPPLIER;
            let mut best_lot_0_price = 0u64;
            let mut best_lot_1_price = 0u64;

            if pair_is_feasible(0, 0, &a, &b, &c) {
                let lot_0_price = price_for(0, 0, &a, &b, &c);
                let lot_1_price = price_for(0, 1, &a, &b, &c);
                let total = lot_0_price + lot_1_price;
                if !found || total < best_total {
                    found = true;
                    best_total = total;
                    best_lot_0_supplier = 0;
                    best_lot_1_supplier = 0;
                    best_lot_0_price = lot_0_price;
                    best_lot_1_price = lot_1_price;
                }
            }
            if pair_is_feasible(0, 1, &a, &b, &c) {
                let lot_0_price = price_for(0, 0, &a, &b, &c);
                let lot_1_price = price_for(1, 1, &a, &b, &c);
                let total = lot_0_price + lot_1_price;
                if !found || total < best_total {
                    found = true;
                    best_total = total;
                    best_lot_0_supplier = 0;
                    best_lot_1_supplier = 1;
                    best_lot_0_price = lot_0_price;
                    best_lot_1_price = lot_1_price;
                }
            }
            if pair_is_feasible(0, 2, &a, &b, &c) {
                let lot_0_price = price_for(0, 0, &a, &b, &c);
                let lot_1_price = price_for(2, 1, &a, &b, &c);
                let total = lot_0_price + lot_1_price;
                if !found || total < best_total {
                    found = true;
                    best_total = total;
                    best_lot_0_supplier = 0;
                    best_lot_1_supplier = 2;
                    best_lot_0_price = lot_0_price;
                    best_lot_1_price = lot_1_price;
                }
            }
            if pair_is_feasible(1, 0, &a, &b, &c) {
                let lot_0_price = price_for(1, 0, &a, &b, &c);
                let lot_1_price = price_for(0, 1, &a, &b, &c);
                let total = lot_0_price + lot_1_price;
                if !found || total < best_total {
                    found = true;
                    best_total = total;
                    best_lot_0_supplier = 1;
                    best_lot_1_supplier = 0;
                    best_lot_0_price = lot_0_price;
                    best_lot_1_price = lot_1_price;
                }
            }
            if pair_is_feasible(1, 1, &a, &b, &c) {
                let lot_0_price = price_for(1, 0, &a, &b, &c);
                let lot_1_price = price_for(1, 1, &a, &b, &c);
                let total = lot_0_price + lot_1_price;
                if !found || total < best_total {
                    found = true;
                    best_total = total;
                    best_lot_0_supplier = 1;
                    best_lot_1_supplier = 1;
                    best_lot_0_price = lot_0_price;
                    best_lot_1_price = lot_1_price;
                }
            }
            if pair_is_feasible(1, 2, &a, &b, &c) {
                let lot_0_price = price_for(1, 0, &a, &b, &c);
                let lot_1_price = price_for(2, 1, &a, &b, &c);
                let total = lot_0_price + lot_1_price;
                if !found || total < best_total {
                    found = true;
                    best_total = total;
                    best_lot_0_supplier = 1;
                    best_lot_1_supplier = 2;
                    best_lot_0_price = lot_0_price;
                    best_lot_1_price = lot_1_price;
                }
            }
            if pair_is_feasible(2, 0, &a, &b, &c) {
                let lot_0_price = price_for(2, 0, &a, &b, &c);
                let lot_1_price = price_for(0, 1, &a, &b, &c);
                let total = lot_0_price + lot_1_price;
                if !found || total < best_total {
                    found = true;
                    best_total = total;
                    best_lot_0_supplier = 2;
                    best_lot_1_supplier = 0;
                    best_lot_0_price = lot_0_price;
                    best_lot_1_price = lot_1_price;
                }
            }
            if pair_is_feasible(2, 1, &a, &b, &c) {
                let lot_0_price = price_for(2, 0, &a, &b, &c);
                let lot_1_price = price_for(1, 1, &a, &b, &c);
                let total = lot_0_price + lot_1_price;
                if !found || total < best_total {
                    found = true;
                    best_total = total;
                    best_lot_0_supplier = 2;
                    best_lot_1_supplier = 1;
                    best_lot_0_price = lot_0_price;
                    best_lot_1_price = lot_1_price;
                }
            }
            if pair_is_feasible(2, 2, &a, &b, &c) {
                let lot_0_price = price_for(2, 0, &a, &b, &c);
                let lot_1_price = price_for(2, 1, &a, &b, &c);
                let total = lot_0_price + lot_1_price;
                if !found || total < best_total {
                    found = true;
                    best_total = total;
                    best_lot_0_supplier = 2;
                    best_lot_1_supplier = 2;
                    best_lot_0_price = lot_0_price;
                    best_lot_1_price = lot_1_price;
                }
            }

            if !found {
                AllocationResult {
                    status: 2,
                    lot_0_supplier: INVALID_SUPPLIER,
                    lot_1_supplier: INVALID_SUPPLIER,
                    lot_0_price: 0,
                    lot_1_price: 0,
                    total: 0,
                }
            } else {
                AllocationResult {
                    status: 0,
                    lot_0_supplier: best_lot_0_supplier,
                    lot_1_supplier: best_lot_1_supplier,
                    lot_0_price: best_lot_0_price,
                    lot_1_price: best_lot_1_price,
                    total: best_total,
                }
            }
        };

        result.reveal()
    }
}
