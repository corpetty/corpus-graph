---
title: Architecture decisions
---

# Architecture decisions

This page records the load-bearing decisions behind Quill's request model.

## Server-side rendering

**Server-side rendering is the default; a route opts out explicitly rather than opting in.** This trades per-request cost for a simpler mental model and no separate build step. It depends on how we resolve streaming.

## No global state

**Each request runs in an isolated context, and nothing is shared mutably between requests.** This is what lets [[File-based routing]] compose safely and keeps the [[Query builder]] free of cross-request leakage.
