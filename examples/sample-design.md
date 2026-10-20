# Feature Design: Bounded in-memory LRU cache for symbol lookups

> Sample design document for QFB. In a real run, Phase A (human-controlled design) produces and
> iterates this document before approval. Customer/prospect identities and customer-specific schema
> names are deliberately **absent** here and belong only in the `--deny` list, never in code.

## 1. Requirements and desired behavior

- Add an optional, bounded LRU cache in front of the symbol-lookup path.
- Cache capacity is configurable; eviction is strict LRU.
- Zero behavior change when the cache is disabled (capacity = 0).
- Thread-safe under concurrent readers and writers.

## 2. Architecture and technical decisions

- A small `SymbolLookupCache` class owned by the existing lookup component.
- Backed by a bounded structure with O(1) get/put and LRU eviction.
- Concurrency via the existing lock discipline of the surrounding component; no new global locks.
- No on-disk format changes; purely an in-memory accelerator.

## 3. Implementation Plan

1. Add a `SymbolLookupCache` class with capacity, `get`, `put`, and strict-LRU eviction, plus unit
   tests for basic hit/miss/eviction ordering.
2. Wire the cache into the symbol-lookup path behind a configuration flag (default disabled), keeping
   behavior identical when capacity is 0.
3. Add concurrency tests exercising parallel readers/writers and verifying no lost updates or
   corrupted ordering under contention.

## 4. Test expectations and acceptance criteria

- Unit tests cover hit, miss, eviction order, and capacity = 0 (disabled) semantics.
- Concurrency tests pass reliably under repeated runs.
- No regressions in the existing symbol-lookup test suite.
- With the cache disabled, results are byte-for-byte identical to the pre-change behavior.
