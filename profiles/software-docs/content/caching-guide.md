---
title: Caching guide
---

# Caching guide

## Cache keys

**A cache key is a hash of the response content plus its varying headers, and a key is never mutated in place.**

The [[Caching layer]] stores responses under these content-addressed keys. To replace content you write a new key, never overwrite an old one.

## Invalidation

Because keys are immutable, invalidation is a separate concern — see the open question on the invalidation API. The working answer is tag-based invalidation that maps a tag to the set of keys it should evict.
