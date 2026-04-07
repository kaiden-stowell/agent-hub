# Code Style Guide

## General Rules
- Prefer clarity over cleverness
- Keep functions small — one job per function
- Name variables for what they hold, not their type
- Avoid magic numbers — use named constants
- Write code that doesn't need comments to explain what it does

## Error Handling
- Always handle errors at the boundary (user input, external APIs)
- Never silently swallow errors — log or re-throw
- Prefer early returns over deeply nested conditionals

## Security
- Sanitize all user input before use
- Never concatenate SQL — use parameterized queries
- Don't log sensitive data (tokens, passwords, PII)
- Validate on the server, even if you validate on the client

## Git
- Commit messages: imperative mood — "Add login endpoint", not "Added"
- One logical change per commit
- Keep PRs small and focused
