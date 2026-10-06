# Contributing

Thanks for helping. This is a small, read-only diagnostic tool for motorcycle ECUs, and a few
rules keep it safe to run on someone's bike.

## Rules

- **Read-only, apart from the output tests.** The tool reads and, on request, clears stored fault
  codes, and it can run the whitelisted output tests (below). Pull requests that add write,
  programming, flash, calibration, adaptation or any other routine-control services will not be merged.
  The unlock (`src/unlock.js`) only opens reads and sends security access levels 05 and 06;
  do not widen that.
- **No secrets.** Do not put unlock multipliers, seed/key values, keys or constants extracted
  from other programs in issues, pull requests, tests, comments or logs. Tests use made-up values
  against the mock ECU. Redact `unlock.json` and anything derived from it. Do not contribute
  tools that extract such values from other software.
- Never commit `config.json`, `unlock.json` or recordings in `logs/` (they are git-ignored).

## Output tests

The output tests (`outputTests` in a bike description, run by `src/outputtests.js`) are the one thing
in the tool that makes a bike move or run parts, so they are limited to the whitelist in the bike
description and nothing else:

- Adding a test needs a note of **how it was confirmed on a bike** (which bike, year and ECU, what you
  saw, heard or read back) and a **safety review** (what moves, what can be hurt, what the precondition
  and the safety note have to say). Without both it stays out; a test nobody has run on a bike keeps the
  `unconfirmed` level and says so on the page.
- No write, flash, calibration, adaptation or reset routines, and none of the adjust routines
  (adjust exhaust valve, adjust idle, reset adaptation, reset throttle position, idle fuel trim): they
  change stored values. No injector or coil tests on an ECU that has none, and no throttle motor drive.
- Start and stop requests are built in `src/outputtests.js` only, from a routine byte of the bike
  table, never from user input. The raw `send` command stays limited to reads. `npm test` checks both.
- The guards (unlock, confirmation, engine off, stationary, battery, one at a time) are not options:
  do not add a way around them, and keep the feature off until the person turns it on.

## Labelling an id

The switch table and the analog tiles in a bike description (`switches`, `analogs`) name 0x22 ids.
A label is only a guess until it has been seen on a bike, so every entry carries a `confirmation`
level and an `evidence` note:

- `confirmed`: you toggled that one input on a bike and watched the id flip. The note says how
  ("start button pressed: `00 00` -> `00 ff`") and, in an issue or pull request, on which bike,
  year and ECU.
- `consistent`: what the bike showed fits, but the input was not operated on its own.
- `unconfirmed`: a label taken from another tool's tables, or a guess. Say where it came from.

Do not raise a label to `confirmed` without a note of how it was confirmed on a bike, and do not
name an id that has only been seen answering (the "Find more IDs" snapshots show which id moves
when you operate something: do that first). Read-only applies here too: a table names ids to
read, never anything to send.

## Running the tests

```bash
npm install
npm test
```

The tests run the whole stack against a mock ECU (`test/mockecu.js`) with a fake clock: no bike,
no serial port, no real waiting. The suite should stay green and fast. A change to behaviour
comes with a test that goes through the same interface its callers use.

## Hardware tests

Anything that needs a real ECU is a script under `scripts/`, run by hand (`node scripts/<name>.js
[port]`), never from `npm test`. Scripts send only wake-up patterns and read-only requests, and
use `src/probekit.js`. Close the GUI and the CLI first: only one program can hold the port.
When you report a result from a bike, say which bike, year and ECU, and attach the output of the
script with any secret removed.

## Adding a second bike

Everything specific to one bike lives in one description file in `src/bikes/`.

1. Copy `src/bikes/triumph-keihin-2006-2012.js` to a new file named for the bike and ECU.
2. Fill in its `id`, `name`, `dataBlockId`, the wake-up order (`wake.attempts`), the dashboard
   gauges (a standard PID each), and the fault code meanings. Mark values you have not compared
   with the real bike as unverified. If the ECU serves 0x22 ids for switches, add them to the
   `switches` table with a `confirmation` level and an `evidence` note (see "Labelling an id").
3. Run it through `defineBike()` in `src/bikes/index.js`, which checks the required fields, and
   add tests in `test/bikes.test.js`.
4. The tool currently uses `DEFAULT_BIKE`; if you need to select a bike, keep that selection in
   `src/bikes/index.js` and do not put bike specifics in the generic modules.

Do not include anything in a description that needs a secret to use.
