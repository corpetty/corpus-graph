---
title: Security model
---

# Security model

## Sessions

**Sessions default to a signed, HttpOnly cookie unless a server-side store is configured.** The [[Auth]] module signs the cookie and rejects tampered values.

## Threat model

Quill assumes a hostile client and a trusted server. Cookie signing defends against tampering; it does not defend against a fully compromised server.
