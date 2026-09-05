"""
Synthetic data generator for the multi-source reconciliation problem.

Simulates the real-world Razorpay finance-ops scenario:
  - Source A: Razorpay Settlement Report (what the gateway says it paid out)
  - Source B: Bank Statement (what actually landed in the merchant's bank account)
  - Source C: Internal Order Ledger (what the merchant's own system recorded as sold)

A "clean" transaction reconciles across all three. Real batches never are clean:
amounts get rounded differently, UTRs get typo'd on manual re-entry, settlement
batches merge multiple orders into one bank credit, dates drift by a day across
timezones, and a slice of orders never got paid out at all (fraud holds, refunds,
disputed payments). This generator reproduces that mess deliberately so the
reconciliation engine has something real to prove itself against.
"""

import random
import string
from datetime import datetime, timedelta
from dataclasses import dataclass, field, asdict


random.seed(42)  # reproducible batch


def _order_id(n: int) -> str:
    return f"ORD{n:06d}"


def _utr(n: int) -> str:
    return f"UTR{2026}{n:08d}"


def _rand_ref(base: str, typo: bool = False) -> str:
    if not typo:
        return base
    # simulate a manual re-entry typo: swap two adjacent chars
    chars = list(base)
    i = random.randint(3, len(chars) - 2)
    chars[i], chars[i + 1] = chars[i + 1], chars[i]
    return "".join(chars)


@dataclass
class Txn:
    order_id: str
    utr: str
    amount: float
    date: str
    customer: str
    source: str
    note: str = ""


def generate_batch(n_orders: int = 65):
    base_date = datetime(2026, 8, 1)
    customers = [
        "Rahul Sharma", "Priya Menon", "Aditya Rao", "Sneha Kulkarni", "Vikram Singh",
        "Ananya Iyer", "Karthik Reddy", "Isha Gupta", "Rohan Desai", "Meera Nair",
    ]

    settlement, bank, ledger = [], [], []
    audit_ground_truth = []  # for measuring precision/recall against generator's own truth

    n = 1
    while n <= n_orders:
        oid = _order_id(n)
        utr = _utr(n)
        amount = round(random.uniform(199, 24999), 2)
        date = base_date + timedelta(days=random.randint(0, 14))
        cust = random.choice(customers)

        scenario = random.choices(
            [
                "clean",              # matches perfectly everywhere
                "amount_rounding",    # bank shows paise-rounded amount
                "date_drift",         # bank credit lands next day
                "utr_typo",           # manual re-entry typo in ledger's recorded UTR
                "batched_settlement", # 2 orders merged into 1 bank credit
                "missing_bank",       # settled per gateway, never hit bank (held/reversed)
                "missing_ledger",     # payment received, never recorded as an order (manual sale)
                "duplicate_ledger",   # ledger has a duplicate entry (double data-entry)
            ],
            weights=[38, 12, 10, 10, 8, 8, 8, 6],
            k=1,
        )[0]

        settlement.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "settlement"))

        if scenario == "clean":
            bank.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "bank"))
            ledger.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "ledger"))
            audit_ground_truth.append((oid, "matched_all"))

        elif scenario == "amount_rounding":
            bank_amt = round(amount) - 0.0  # bank rounds to nearest rupee
            bank.append(Txn(oid, utr, bank_amt, date.strftime("%Y-%m-%d"), cust, "bank"))
            ledger.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "ledger"))
            audit_ground_truth.append((oid, "matched_all"))

        elif scenario == "date_drift":
            bank.append(Txn(oid, utr, amount, (date + timedelta(days=1)).strftime("%Y-%m-%d"), cust, "bank"))
            ledger.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "ledger"))
            audit_ground_truth.append((oid, "matched_all"))

        elif scenario == "utr_typo":
            bank.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "bank"))
            ledger.append(Txn(oid, _rand_ref(utr, typo=True), amount, date.strftime("%Y-%m-%d"), cust, "ledger"))
            audit_ground_truth.append((oid, "matched_all"))

        elif scenario == "batched_settlement":
            # this order's bank credit is combined with the NEXT order into one line
            if n + 1 <= n_orders:
                oid2 = _order_id(n + 1)
                utr2 = _utr(n + 1)
                amount2 = round(random.uniform(199, 24999), 2)
                cust2 = random.choice(customers)
                combined_utr = f"BATCH{utr}-{utr2}"
                combined_amt = round(amount + amount2, 2)
                bank.append(Txn(oid, combined_utr, combined_amt, date.strftime("%Y-%m-%d"), f"{cust}+{cust2}", "bank",
                                 note=f"batched with {oid2}"))
                ledger.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "ledger"))
                settlement.append(Txn(oid2, utr2, amount2, date.strftime("%Y-%m-%d"), cust2, "settlement"))
                ledger.append(Txn(oid2, utr2, amount2, date.strftime("%Y-%m-%d"), cust2, "ledger"))
                audit_ground_truth.append((oid, "batched_pair"))
                audit_ground_truth.append((oid2, "batched_pair"))
                n += 1  # consumed two order slots
            else:
                bank.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "bank"))
                ledger.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "ledger"))
                audit_ground_truth.append((oid, "matched_all"))

        elif scenario == "missing_bank":
            # gateway says settled, but no bank credit — held for fraud review / reversed
            ledger.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "ledger"))
            audit_ground_truth.append((oid, "exception_missing_bank"))

        elif scenario == "missing_ledger":
            bank.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "bank"))
            audit_ground_truth.append((oid, "exception_missing_ledger"))

        elif scenario == "duplicate_ledger":
            bank.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "bank"))
            ledger.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "ledger"))
            ledger.append(Txn(oid, utr, amount, date.strftime("%Y-%m-%d"), cust, "ledger", note="duplicate entry"))
            audit_ground_truth.append((oid, "exception_duplicate_ledger"))

        n += 1

    return settlement, bank, ledger, audit_ground_truth


def to_dicts(txns):
    return [asdict(t) for t in txns]


if __name__ == "__main__":
    import json, os
    settlement, bank, ledger, truth = generate_batch(65)
    os.makedirs("/home/claude/finance-reconciler/data", exist_ok=True)
    with open("/home/claude/finance-reconciler/data/settlement.json", "w") as f:
        json.dump(to_dicts(settlement), f, indent=2)
    with open("/home/claude/finance-reconciler/data/bank.json", "w") as f:
        json.dump(to_dicts(bank), f, indent=2)
    with open("/home/claude/finance-reconciler/data/ledger.json", "w") as f:
        json.dump(to_dicts(ledger), f, indent=2)
    with open("/home/claude/finance-reconciler/data/ground_truth.json", "w") as f:
        json.dump(truth, f, indent=2)
    print(f"settlement={len(settlement)} bank={len(bank)} ledger={len(ledger)} orders={len(truth)}")
