# Nimbio for Homebridge

The official [Homebridge](https://homebridge.io) plugin for [Nimbio](https://nimbio.com)
gates. Open your gates from the Apple Home app, Siri, Apple Watch and CarPlay.

Gates appear as **garage doors** (or **locks**, for latches that report
Locked/Unlocked). HomeKit treats both as secure devices: they need an unlocked
iPhone and Siri asks before opening.

## What you get depends on your key

When the plugin starts it asks Nimbio what your API key is allowed to do.

| | Personal key | Community API key (community managers) |
|---|---|---|
| Open gates | ✅ | ✅ |
| Live open/closed status | — | ✅ for gates with a status sensor |
| Hold-open switch per gate | — | ✅ if your community's key has hold-open access |

- **Personal key**: create one at [api.nimbio.com/manage](https://api.nimbio.com/manage).
  Each gate rests at *Closed*, shows *Open* for a few seconds after a successful
  open, then returns to *Closed*. The plugin makes no background requests.
- **Community API key**: created by a community manager in the Nimbio admin
  portal. Gates with a status sensor track the real state live; gates without
  one behave like the personal-key gates.

A community manager who pastes their *personal* key gets the personal-key
experience — use the community key for status and hold-opens.

## Install

Homebridge UI → **Plugins** → search **`@nimbio/homebridge-nimbio`** → **Install**,
then open **Settings** and paste your API key. The plugin stays idle until a key
is saved.

```json
{
  "platforms": [
    { "platform": "NimbioGates", "name": "Nimbio", "apiKey": "nimbio_live_…" }
  ]
}
```

| Option | Default | |
|---|---|---|
| `apiKey` | — | Required. |
| `momentaryResetSeconds` | `5` | How long a gate without a sensor shows *Open* after opening. |
| `holdOpenSwitches` | `true` | Community keys: one *Hold Open* switch per gate. |
| `liveUpdates` | `stream` | Community keys: `stream` (live, works behind your router) or `polling`. |
| `pollSeconds` | `60` | Polling interval, minimum 30. |
| `excludeLatchIds` | `[]` | Latch IDs to hide. |

## Good to know

- **Gates close on their own.** Nimbio has no close or lock command, so asking
  Home to close a gate or lock a latch does nothing; the tile returns to the
  real state.
- **Opens can take 15–20 seconds** over cellular. The tile shows *Opening*
  until the gate box confirms. If it never confirms, Home briefly shows an error.
- **Hold Open** turns the *manual* hold-open on and off. Scheduled hold-open
  windows are managed in the Nimbio portal and are not cancelled by the switch.
- **Live status** uses an outbound connection — no port forwarding. Each API key
  allows 3 live connections; if Home Assistant uses the same key, give each its
  own.
- Opens are recorded in your community's access log as
  *Apple Home (Homebridge)*.

## Privacy

No analytics. The plugin talks only to `api.nimbio.com`, and never logs your
API key or member details.

## Support

Issues: <https://github.com/nimbio-labs/homebridge-nimbio/issues>

MIT licensed.
