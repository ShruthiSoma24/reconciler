# Reconciler — Multi-Source Reconciliation (AI Finance Controller)

Built for **Razorpay AI Buildathon 2026 — Track 04: AI Finance Controller**
("Run the books and the cash position")

## What it does

Reconciles a merchant's finance-ops trail across three sources that never
agree perfectly in the real world:

- **Settlement report** — what the payment gateway says it paid out
- **Bank statement** — what actually landed in the account
- **Internal order ledger** — what the merchant's own system recorded as sold

Instead of a toy "join on ID" demo, the engine is built to survive the mess
that real reconciliation involves: rounding differences, UTR typos from
manual re-entry, settlement dates that drift a day, multiple orders paid out
in one combined bank credit, and orders that are missing from one side
entirely (fraud holds, unrecorded manual sales, duplicate data entry).

## Why this, not a cleaner demo

The brief's bar is explicit: *"Throughput plus measured accuracy plus an
honest exception list. One cherry-picked match proves nothing."* So the
synthetic batch (`backend/data_generator.py`) is built to be dirty on
purpose — 65 orders, 8 different real-world mismatch scenarios, seeded for
reproducibility — and the engine is scored against the generator's own
ground truth, not just eyeballed.

**Current numbers on the seed batch (`backend/run_reconciliation.py`):**

| Metric | Value |
|---|---|
| Auto-matched | 41 / 65 (63.1%) |
| Batched pairs resolved | 11 |
| Fully reconciled | 80.0% |
| Exceptions raised (honest, categorized) | 13 |
| Classification accuracy vs. ground truth | 98.5% (1 known miss) |

The one remaining miss is documented, not hidden: a batched-settlement pair
occasionally gets claimed by the fuzzy-UTR pass before the batch-detection
pass runs. That's a real ordering bug in the matching pipeline, left in and
called out in the exception report rather than patched around for a better
number — the brief asks for honesty, not a perfect demo.

## How it's bounded and gated (the "explainable, bounded, gated" bar)

- Nothing is ever auto-matched below **90% match confidence**.
- Nothing is ever auto-matched above **₹25,000**, regardless of confidence —
  high-value transactions always route to human review. This engine
  never moves money; it only proposes matches and raises exceptions.
- Every single comparison — match or miss — is written to an **audit trail**
  with the strategy used and the reason, not just the winners.
- Duplicate ledger entries are *always* flagged for manual dedup, never
  auto-resolved, because guessing which duplicate is "real" risks double-
  counting revenue.

## Architecture

```
backend/
  data_generator.py       synthetic 3-source batch + ground truth (reproducible, seed=42)
  reconciliation_engine.py  multi-pass matcher: exact UTR -> fuzzy UTR+amount+date -> batch detection
  run_reconciliation.py   runs the engine, scores it against ground truth, writes reports/full_report.json
  main.py                 FastAPI: GET /api/reconcile, /api/sources, /api/health
frontend/
  src/App.jsx             ledger-style dashboard: summary strip, match-rate bar, tabbed tables,
                            search/sort, click-through to a per-order 3-way record comparison drawer
  src/App.css              design: paper background, serif headers, monospace tabular figures
data/                     generated synthetic batch (settlement.json, bank.json, ledger.json, ground_truth.json)
reports/                  full_report.json — the scored output, including the audit trail
```

Stack: **Python (FastAPI, rapidfuzz) + React (Vite)** — same stack as the
team's other shipped projects (Redrob AI, the renewable-energy project),
chosen for consistency rather than novelty for novelty's sake.

## Running it

```bash
# backend
cd backend
pip install -r requirements.txt
python3 data_generator.py        # regenerate the synthetic batch (optional, one is included)
python3 run_reconciliation.py    # run + score the engine, writes reports/full_report.json
uvicorn main:app --reload --port 8000

# frontend (separate terminal)
cd frontend
npm install
npm run dev                      # http://localhost:5173
```

The dashboard tries the live backend first (`localhost:8000/api/reconcile`)
and falls back to a bundled seed report (`frontend/public/report.json`) so
it's viewable even without the backend running.

## What would come next (not built for this submission)

- Extend the batch-detection pass to run *before* the fuzzy pass, closing
  the one known miss.
- A settlement Q&A agent (RAG over the audit trail) and a forward cash
  forecaster (tree-based ensemble, same pattern as the renewable-energy
  project's prediction pipeline) — the other two example directions in
  this track, natural next modules on top of the same reconciliation core.
