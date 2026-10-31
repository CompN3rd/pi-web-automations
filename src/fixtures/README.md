# Legacy SQLite compatibility fixture

`legacy-0.1.2.sqlite` was created with `AutomationStore` from commit
`65b2e096796728cf477d8500d71df7c4e8e917ed` and **better-sqlite3 13.0.3**,
not the new runtime SQLite implementation. It contains only synthetic data:
two disabled definitions, a completed/tested run with a session, attempt and
partial usage/cost, and a starting/interrupted run. It uses schema version 1.

The store test copies the fixture to a temporary directory before opening it.
It verifies preservation, recovery to unknown, and persistent admission blocking
across reopen. No live plugin state was used or migrated.
