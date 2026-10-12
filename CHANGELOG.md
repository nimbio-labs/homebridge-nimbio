# Changelog

All notable changes to `@nimbio/homebridge-nimbio` are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First release. Requires `@nimbio/community-api` 0.7.0.

### Added

- Dynamic platform `NimbioGates` with a Homebridge UI settings form.
- Detects the key type on startup. **Personal keys** get open-only gates.
  **Community API keys** also get live status and hold-open switches, each gated
  on the key's own capabilities (`gate_status`, `hold_opens`).
- Gates as Garage Door Openers. Latches whose sense line reports
  Locked/Unlocked appear as Locks. Classification matches the Home Assistant
  integration.
- Live updates over the Nimbio event stream, with a polling fallback and a
  15-minute safety re-sync.
- Every open carries an idempotency key and the access-log note
  "Apple Home (Homebridge)".
- Requests carry `X-Nimbio-Integration: homebridge/<version>`, so opens are attributed to Homebridge.
