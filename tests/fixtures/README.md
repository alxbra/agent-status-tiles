# Test fixtures

This directory is reserved for sanitized, test-only fixtures. Production code
must never read from it. The foundation smoke tests use a temporary user-data
directory instead of the developer's Electron profile; provider fixtures will
be added with their adapters.
