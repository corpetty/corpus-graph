---
title: Routing guide
---

# Routing guide

## Filesystem routes

**Routes are derived from the filesystem: a file at `routes/foo.ts` becomes the `/foo` handler, with no central route table to keep in sync.**

The [[Router]] scans `routes/` at boot and builds the dispatch table. Because there is no shared registry, this composes with Quill's no-global-state rule.

## Dynamic segments

`routes/users/[id].ts` matches `/users/42`. The segment is passed to the handler as a typed parameter.
