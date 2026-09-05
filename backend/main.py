from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import json
import os

from reconciliation_engine import ReconciliationEngine

app = FastAPI(title="AI Finance Controller — Multi-Source Reconciliation")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")


def _load(name):
    path = os.path.join(DATA_DIR, f"{name}.json")
    with open(path) as f:
        return json.load(f)


@app.get("/api/reconcile")
def reconcile():
    """Run the engine fresh on the current synthetic batch and return the full report."""
    try:
        settlement = _load("settlement")
        bank = _load("bank")
        ledger = _load("ledger")
    except FileNotFoundError:
        raise HTTPException(404, "No data batch found — run data_generator.py first")

    engine = ReconciliationEngine(settlement, bank, ledger)
    report = engine.run()
    return report


@app.get("/api/sources")
def sources():
    """Raw source data, for inspection in the UI."""
    try:
        return {
            "settlement": _load("settlement"),
            "bank": _load("bank"),
            "ledger": _load("ledger"),
        }
    except FileNotFoundError:
        raise HTTPException(404, "No data batch found — run data_generator.py first")


@app.get("/api/health")
def health():
    return {"status": "ok"}
