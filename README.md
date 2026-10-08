# daytona-kline

Read-only diagnostic tool for the **Triumph Daytona 675 (2006–2012, Keihin ECU)**, talking
over the K-line through a TuneECU-style FTDI USB-to-OBD cable: ISO 9141-2 OBD-II after a slow
init (what a 2012 Daytona 675 answers), or KWP2000 (ISO 14230) after a fast init (the other
ECUs of the family; the tool tries both).

What it does: find and connect to the ECU, show live engine data (rpm, speed, throttle,
manifold pressure, temperatures, load, timing, fuel trim, fuel system status) on the screen
and in a CSV, and read and clear fault codes together with the warning light (MIL) state.
All of it is standard OBD-II (SAE J1979 modes 01, 03 and 04), which the 2012 Daytona serves
without any security unlock. With the ECU unlocked (optional, below) it also shows the switch
states by name, records everything together with time stamps and events to catch a bike that
starts and then dies, and searches the ECU for more ids (see "Switches, Record and Find more IDs").

What it deliberately does **not** do: write anything to the ECU. No map flashing, no
table edits. The only things that change ECU state or drive anything are `cleardtc`, which asks
for `--yes`, and the optional, opt-in output tests (see "Output tests (optional)"), a whitelist
of 8 short tests that make the bike move or run parts and need the ECU unlock.

## Read this first: safety and no warranty

This is a hobby project made by an owner for their own bike, shared in the hope it helps others.
It comes with **no warranty of any kind** (see the licence): use it at your own risk.

- It talks to your bike's ECU over the diagnostic port. Mostly it only **reads**. The three things
  that change anything are clearing stored fault codes (asks for confirmation), the optional ECU
  unlock, and the optional output tests, which make the bike move or run parts (the tach needle,
  the cooling fan, the fuel pump and so on). Read "Output tests" before using them, and only run
  them with the bike stationary, the engine off and your hands clear of the fan and exhaust valve.
- It has been tried on **one bike**, a 2012 Triumph Daytona 675 (Keihin ECU), with one cable. Other
  years, models and cables may behave differently or not work at all.
- A weak battery and a diagnostic session do not mix: use a battery tender for long sessions.
- The ECU unlock needs a number for your own ECU that this project does not supply and will not
  help you obtain. Without it you still get the dials, fault codes and recordings.
- Do not use it while riding. Do not use it to defeat emissions or safety systems.
- Not affiliated with or endorsed by Triumph, Keihin or the makers of TuneECU or any other tool;
  those are names of their owners.

## What works today

| | Status |
|---|---|
| Connect (slow init), OBD dials, fault codes and the warning light, clearing codes | tried on the bike |
| ECU unlock (with your own number), named switches, the tip-over sensor | tried on the bike |
| Recorder with events and notes, graphs, fuel map | tried on the bike, the graphs and map only briefly |
| Output tests | 5 of the 8 tried on the bike; the other 3 are probably parts missing from that bike |
| Sensor block, probe, live and watch commands, Find more IDs | not working on the tested bike (its ECU never answers service 0x21), kept for other ECUs |
| Anything on a model other than the 2012 Daytona 675 | untested |

## Quick start

You need three things: a **TuneECU-style FTDI USB-to-OBD cable**, a computer with
**[Node.js](https://nodejs.org) 18 or newer**, and the bike (ignition on, kill switch at run).

1. Download or clone this folder.
2. Start it:
   - **Windows:** double-click `start.bat`.
   - **Mac / Linux:** run `sh start.sh`.
   - Or in a terminal: `npm install` once, then `npm start`.

   The first start installs what it needs (about a minute, needs internet once); after that it
   starts in seconds and opens the page at http://localhost:3675.
3. Plug the cable into the bike's diagnostic connector (under the seat) and into USB, pick its
   port at the top of the page and press **Connect**. The ECU answers only about one try in three,
   so connecting can take up to a minute. After that the dashboard and the switch watcher run by
   themselves.

The cable needs its **FTDI driver**. Windows 10 and 11 usually install it when the cable is first
plugged in; if no port shows up, get the "VCP" driver from [ftdichip.com](https://ftdichip.com/drivers/vcp-drivers/).
Linux and macOS have it built in.

Fault codes, the dials and recordings work straight away. Behind the optional ECU unlock (below)
are the named switches, battery, gear, the injection-pulse graph and the output tests. That needs
a number for your own ECU that this project does not supply (see "Unlocking the ECU (optional)"),
so treat it as an extra, not part of the setup.

The page has tabs: **Dashboard** (the dials, the switches and the output tests), **Graphs & map**
(strip charts and the fuel map), **Record**, **Faults & ECU** and **Advanced**. The row of key
numbers under the connection bar (engine speed, throttle, battery, coolant, injection pulse, fuel
pump and the tip-over sensor) stays on screen on every tab.

## Setup (once), the manual way

```bash
npm install
```

## Connecting to the bike

1. Plug the cable into the bike's diagnostic connector (under the seat, in front of the
   fusebox) and into USB.
2. Ignition **ON**, kill switch at **RUN**, engine off (running is fine too, for live data).
   A battery tender is a good idea for longer sessions — the pump and lights draw a lot
   with the engine off.
3. Find the cable's COM port:

```bash
node cli.js ports
```

4. Find the ECU (tries each known wake-up until one answers):

```bash
node cli.js scan --port COM3
```

The Daytona 675 is woken by a **slow init** to address `33`, and it answers only about one
try in three, so the tool tries up to 6 times, 6 s apart (the first after 3 s of quiet on the
line): connecting can take up to a minute. The progress lines say which try it is on ("slow
init 0x33, try 2/6"). Only if all of those fail does it fall back to fast init (`D5`/`F5`,
functional `33`, then generic addresses).

The wake-up that worked (slow or fast, its address and addressing mode) is saved to
`config.json` and tried first on every later connect, so every command just works without
flags; if it stops answering, the tool goes through the whole order again. Every command
makes the session ready and keeps it alive until it finishes. If no fast address answers, try
the alternate init pulse: `--init break`.

## Everyday commands

```bash
node cli.js gauges
```

shows the engine's live values, redrawn in place: engine speed, vehicle speed, throttle,
manifold pressure (hPa), coolant and intake air temperature, engine load, timing advance,
short-term fuel trim and the fuel system status in words (open loop, closed loop, ...). They
are standard mode 01 PIDs with the SAE J1979 formulas. A `?` after a value means the bike
description still marks that gauge unverified (none of the formulas has been compared with
the dash on this bike yet). A value shows `not available` when the ECU does not serve its
PID: the tool reads the ECU's list of supported PIDs (PID 00, and PID 20, 40, ... only while
that list says another range exists) before polling, and the last line shows that list.
Battery voltage and gear are not available this way.

```bash
node cli.js gauges --log run.csv
```

appends every reading to a CSV: a header `time,rpm,speed,tps,map,coolant,airtemp,load,timing,trim,fuelSystem,raw`
(one column per gauge with its latest value, blank until it has been read; the fuel system
status is its number), then one row per cycle with the ISO time, the values and, in `raw`,
the PIDs read in that cycle (`0c=3e 80|0d=00|...`). `--log` without a file name records to
`logs/run-<time>.csv`. `--cycles <n>` stops after n
readings, `--interval <ms>` adds a pause between them. Rpm, speed and throttle are read every
cycle and one of the others per cycle in turn, so the slower values refresh every few
seconds. The run only ends when you stop it or the connection decides the ECU is lost.

```bash
node cli.js dtc
```

reads the stored codes (mode 03) with the bike's meaning for the ones it knows, and the
warning light and the ECU's own stored-code count (mode 01 PID 01), and compares the count
with the codes actually read ("the ECU reports 2 stored codes and 2 were read", or "but 1
was read: the list may be incomplete"). Pending codes (mode 07) are read too when the ECU
serves them; the Daytona answers nothing to mode 07, which is reported as "not supported",
not as an error.

```bash
node cli.js cleardtc --yes
```

erases the stored codes (mode 04). It does nothing without `--yes`, the GUI asks for a
confirmation, and the request is never resent. Read and note the codes first.

```bash
node cli.js id
```

reads the ECU identification strings on ECUs that serve them (KWP2000). The 2012 Daytona
does not (mode 09 gets no reply), and the command says so.

The page (`node server.js`, then http://localhost:3675) shows the same: a dial for each of
rpm, speed, throttle, manifold pressure, coolant, intake air, load, timing advance and fuel
trim, a text tile for the fuel system status, a `not available` state for dials the ECU does
not serve, and next to the fault codes the warning light with the stored-code count and the
same comparison line. While connecting it shows which slow-init try it is on ("slow init
0x33, try 2/6").

## Unlocking the ECU (optional)

The 2012 Daytona keeps some of its data behind the manufacturer's security access. Until the
ECU is unlocked it refuses those reads, and the tool shows them as not available. Behind the
unlock are the clutch and other switch states, battery voltage, gear, the ECU's sensor block
and the ECU identity. Everything else (fault codes, the warning light, the OBD dials, the CSV
recordings) works without it, and the tool does not need it.

- **Read-only.** The unlock only makes those reads possible. The tool still has no write,
  programming or flash command.
- **One key per connection.** The ECU may count wrong keys and lock out, so the tool sends at
  most one key each time it connects and never retries by itself. A failed attempt is repeated
  only when you ask for it.
- **You supply the number.** The unlock needs a multiplier that belongs to your ECU. This
  repository contains no such number and no tool to obtain one. How you get it for your own ECU
  is up to you. Put it in a local file `unlock.json` next to `config.json`:

  ```json
  {"multiplier": <integer 1-65535>}
  ```

  (`unlock.example.json` is a placeholder to copy; the value there is rejected on purpose).
  `unlock.json` is git-ignored: do not share it, commit it, or paste its
  value into an issue, a log or a chat. The tool never prints it, and `--debug` hides the key.
- **Automatic attempt.** When a connection is ready, the tool tries the unlock once if the file
  is there. Add `--no-unlock` to a command to skip that attempt.

The unlock indicator (CLI and page) shows one of:

| State | Meaning |
|---|---|
| `unavailable` | No `unlock.json` (or not an ISO 9141 session): the feature is off and nothing unlock-related is sent. |
| `invalid` | `unlock.json` exists but cannot be used (not JSON, no `multiplier`, or not a whole number from 1 to 65535). The message says what to fix. Nothing is sent. |
| `locked` | Ready to try; the ECU is still locked. |
| `unlocking` | The attempt is in progress. |
| `unlocked` | The ECU accepted the key (or reported itself already unlocked): the gated reads work until the connection ends. |
| `failed` | The ECU refused the seed request or the key, or did not answer. Check your number before trying again: every retry is another key the ECU may count. |

A new connection, or one lost and re-established, starts again at `locked`, since the ECU
forgets the unlock too.

## Switches, Record and Find more IDs

All of this is read-only: only service 0x22 reads (and the standard OBD modes) are sent. Unlocked,
the ECU answers 0x22 reads for battery voltage, gear and the switch states. Locked, **Switches**
and **Find more IDs** say `needs the ECU unlock, not available` and send nothing, and **Record**
carries on with the OBD values only.

### Switches

`node cli.js switches` and the page's **Switches** panel show one named tile (or line) per switch
the bike description knows: the name, a state in words suited to the switch, the raw bytes and
the id. Whatever flips since you started gets a yellow outline (the CLI colours the id).
Ids you ask for that the description does not name (`--ids 10,41`) come after the named ones as
`ID 0x....`, with the raw bytes only.

Each id returns two data bytes. A plain id is **on** when its value is not zero (it reads
`00 ff`); an **inverted** id is on when its low byte is `00`. The words:

| Name | Id | Words (on / off) | Label |
|---|---|---|---|
| Neutral (inverted) | `0x40` | IN NEUTRAL / IN GEAR | consistent |
| Clutch (inverted) | `0x41` | PULLED / RELEASED | consistent |
| Start switch | `0x46` | PRESSED / RELEASED | **confirmed** |
| Fuel pump | `0x60` | ON / OFF | **confirmed** |
| Main relay | `0x69` | ON / OFF | consistent |
| Sidestand (dash S lamp) | `0x42` | ON / OFF | unconfirmed |
| Warning lamp (red triangle) | `0x44` | ON / OFF | unconfirmed |
| Dash lamp | `0x62` | ON / OFF | unconfirmed |
| Tip-over sensor | `0x63` | NOT TRIPPED / TRIPPED (red) | confirmed |
| O2 sensor heater | `0x64` | ON / OFF | unconfirmed |
| Secondary air, SAI (inverted) | `0x66` | ON / OFF | unconfirmed |
| Air flap | `0x70` | ON / OFF | unconfirmed |

*Confirmed* means the id was watched flipping on the bike when that input was operated (the
starter button turned `00 00` into `00 ff`; the fuel pump went `00 00` to `00 ff` at key-on).
*Consistent* means what the bike showed fits (the clutch id flips while shifting and starting, the
neutral id reads `00 00` in neutral) but the input has not yet been operated on its own.
*Unconfirmed* labels come from another tool's tables. The page puts a small **?** on unconfirmed
tiles and a **~** on consistent ones; the CLI shows `?` after unconfirmed ones; hover a tile for
the note of how it was seen. Id `0x63` is the tip-over (fall detection) sensor: the owner traced an
intermittent no-start and cut-out to it and identified the tile (the other tool's table labels it
'start relay', which is wrong on this bike). It reads `00 ff` while it is enabled and good and lets
the bike start (shown NOT TRIPPED) and `00 00` when tripped (shown TRIPPED, in red: the ECU will not
let the bike start), and it is *confirmed* by the owner. Ids
`0x43`, `0x45` and `0x65`, which other tools list, get no reply at all from this ECU and are left
out; `0x61` and `0x68` answer only now and then.

Two voltages are shown as small tiles under the switches (on the page; unlock only, unconfirmed):
the sidestand sensor, id `0x26`, value = raw / 51 V, and the rollover (tip-over) switch, id
`0x28`, value = raw x 4.887 / 1000 V. To confirm the first, watch it while lifting and lowering the
sidestand; for the second, engine off and key on, tilt the bike. If the ECU stays silent on one it
says `not available` once and is not asked again.

### Record

```bash
node cli.js record [--minutes 10] [--log-dir <folder>]
```

and the page's **Record** panel record the OBD gauges, battery and gear, the analog tiles and the
switch states **together**, with a time stamp for every sample, into one CSV
(`logs/record-<time>.csv`). Every cycle reads the values that show a stall, a cut-out or a crank:
battery, `rpmId` (the ECU's own engine speed, `0x22` id `0x100`: it may show cranking speed where
the OBD rpm reads 0), start switch, fuel pump, the injection pulse of cylinder 1, the tip-over
sensor (`tipOver`, id `0x63`: a trip can be brief, and a read once per rotation missed it)
and the two dash power flags (`warningLamp` `0x44`, `engineLamp` `0x61`); everything else, the OBD
rpm (PID 0C) and the main relay included, takes its turn, one per cycle (the other switches first,
then the other gauges, then the other analog values). Reads are at least 60 ms
apart (the session's job), so a cycle of 8 every-cycle reads plus one takes about 1.2 s on the
mock and about 1.7 s on the bike (a read there takes about 190 ms). Locked, only the OBD values
are recorded (the status says which values were skipped, `needs the ECU unlock`); unlock in the
middle and they are added.

What the recorder does about silence (the ECU now and then skips a request, and some ids say
nothing at all; silence is never counted as a lost link):

- an id read is resent once; every-cycle values wait 500 ms for an answer, the values that take
  turns only about 250 ms;
- a value that never answered is marked not available once and not asked again: after 3 silent
  reads in a row for an every-cycle value, after 2 for one that takes turns;
- a value that did answer once is never dropped, but an every-cycle value that is then silent for
  3 cycles in a row moves to the rotation until it answers again (otherwise it would wait out
  2 x 500 ms in every cycle);
- when the every-cycle reads of a cycle already took more than 1.2 s (300 ms per every-cycle value
  if that is more) the rotating read of that cycle is skipped, so a cycle stays short enough to
  catch a 2-3 s crank;
- the ECU's list of supported PIDs is read in the first cycle; if that read fails it is tried again
  only every 10 cycles, not every cycle.

The CSV has the columns `t_ms` (milliseconds since the start), `cycle_ms` (how long the cycle of
that row took, in clock milliseconds: the next row starts that long after this one; blank on the
closing row of a marker or a lost connection), one per gauge (`rpm`, `speed`, `tps`,
..., `battery`, `gear`) and per analog (`sidestandV`, `rolloverV`, `rpmId`, `injPulse1`, ...)
holding the newest value (blank until read, or when not available), one per switch (`neutral`,
`clutch`, `startSwitch`, `fuelPump`, `mainRelay`, `tipOver`, ...) as `1` (on, by the decode
rule above) or `0`, then `<name>_raw` (the data bytes in hex) for each 0x22 value, then `marker`
and `event`. If the sample spacing is slower than you expect, `cycle_ms` shows which cycles were
slow (a silent id costs 2 x 500 ms or 2 x 250 ms); the page's `view()` has the newest one as
`cycle_ms`, the longest as `cycleMs.longest`, and which every-cycle values were moved to the
rotation as `demoted`.

**Markers.** The page has quick buttons **Cranking**, **Started**, **Died** and **Other...** (type a
note, then the button or Enter); in the CLI type a line and press Enter. The note is stamped
on the next sample's `marker` column, and a note made after the last sample gets a row of its own.

**Events** are found from consecutive samples, written to the `event` column and listed live
(page and CLI):

| Event | When |
|---|---|
| `engine stopped` | rpm falls from above 400 to below 100 within 2 s |
| `fuel pump OFF while running` | the pump flag turns off while rpm is above 0 |
| `fuel pump ON` | the pump flag turns on |
| `main relay OFF` | the main relay flag turns off |
| `start switch pressed` / `released` | the start switch flag changes |
| `battery dip <v> V` | the battery voltage goes below 9.5 V (once per dip) |
| `tip-over sensor TRIPPED` / `tip-over sensor OK again` | the tip-over flag (id `0x63`) turns off (tripped) / on (good) |
| `dash power flags disagree (0x44 x, 0x61 y)` / `dash power flags agree again` | the two dash flags change into / out of disagreement (once each time) |
| `connection lost` | the ECU stopped answering (a last row is written) |

The panel also shows the lowest and highest battery voltage seen, the elapsed time and the CSV file
name. A recording stops by itself after 10 minutes (`--minutes`), when the file would pass 50 MB
(with a message), when you stop it, or when the connection ends; the file is always closed.
The dashboard and the switch watcher pause while recording (one run at a time on the K-line) and
come back when it ends.

To catch a bike that **starts and then dies**: connect, start recording with the key on, press
**Cranking** as you thumb the starter, **Started** when it fires and **Died** when it quits. Then open
the CSV and look at the rows around the `engine stopped` event: the `fuelPump` and `mainRelay`
columns (did the ECU cut the pump or the relay, `fuel pump OFF while running`?), `battery` (a dip
while cranking, or the voltage collapsing afterwards), `startSwitch`, `neutral`, `clutch` and
`sidestand` (an interlock opening), and `rpm` and `tps` just before it.

### Graphs

The **Graphs** panel draws strip charts of the fuel and engine channels: injection pulse (per
cylinder), short-term fuel trim, fuel pump, manifold pressure, engine load, engine speed, throttle,
battery, the tip-over sensor (shaded red while tripped) and the start switch. They fill in from
the dashboard while it runs, and from the recorder while recording, so a recording's graphs are
the same lanes drawn live. The dashboard and the switch watcher start by themselves once you are
connected (Stop turns one off until the next connection; they pause during a recording and come
back after it). Locked, only the OBD values are graphed; the injection pulse, fuel pump and
tip-over flag need the unlock.

Pick a window (30 s, 1 min, 5 min, all), **Pause** to scroll back through what was drawn, hover for
the values at a moment, and **Save picture** for a PNG. **Saved recordings** lists the CSVs in the
logs folder: **Open** draws one as graphs, with its events (red dashed lines) and your notes
(yellow) marked. Only `record-*.csv` files in the logs folder can be opened this way.

### Fuel map

Under the graphs, the **Fuel map** is a table of engine speed (rows) against throttle (columns).
Each cell is the average of the chosen value (the injection pulse of cylinder 1 by default; ignition
timing, fuel trim, manifold pressure and load are in the list) seen at that speed and throttle, so it
fills in while the engine runs, coloured from blue (low) through purple to red and orange (high).
A white crosshair and outlined cell mark where the engine is now (or the moment under the pointer
on a graph lane), and hovering a cell shows its value and sample count. **Fill gaps** shades cells
with no data from their neighbours (paler, no number). Open a saved recording and the map is built
from that recording instead. Only samples with the engine above 400 rpm count, and **Clear map**
starts the live one over.

The columns can be throttle or manifold pressure (the **Columns** list). Besides the injection pulse,
each cell can show the **injector duty cycle** (pulse x rpm / 1200, in %, for a cylinder that injects
once per two turns) or an **estimated fuel flow** in cc/min: type the size of one injector from its
spec sheet and the flow of all three cylinders is duty x that size x 3. The flow is an estimate from
the pulse width and assumes equal injectors; the ECU does not report flow or fuel pressure (the bike
has no fuel pressure sensor, the regulator holds it constant), so those cannot be mapped.

Note this is what the ECU did (the measured pulse), not the ECU's own
stored fuel table, which the tool does not read.

The dashboard reads engine speed, throttle and the injection pulse every cycle and one other value
per cycle in turn (speed, the flags, temperatures and so on); the switch watcher reads in the
background and gives way to the dashboard while the engine runs, so the needles keep up with the
throttle.

### Find more IDs

```bash
node cli.js discover [--from 0 --to ff] [--extended] [--log-dir <folder>]
```

and the page's **Find more IDs** panel ask the ECU about every id in a range (hex; default `0000`-`00ff`,
`--extended` is `0100`-`03ff`) with service 0x22 and list the ones that answer: the id, its value, the two
bytes in hex and the bike's name for it if it has one. It sends nothing but `22 hi lo`, once per
id (a 300 ms wait each, no resends); silence and refusals both mean "not served here". The default
range takes a couple of minutes, a sweep is cut off after 10 minutes in any case (it says where), you can
cancel it, and a disconnect ends it. The result is saved to `logs/discovered-ids-<time>.json`.

To find what an unknown id means, take **Snapshot A**, do something to the bike (lift the sidestand,
flip the kill switch, tilt the bike...), take **Snapshot B**: the ids whose value changed are listed with
before and after. The page's snapshots read the ids the last scan found (or, before any scan, the ids
the bike table names). In the CLI:

```bash
node cli.js snapshot [--ids 41,60]
```

takes A (a sweep of the range, or just the ids you name), waits for Enter while you operate the bike,
takes B and prints the changes.

### Advanced: the ECU's own data blocks and IDs

The sensor block (`probe`, `watch`, `live`) uses service 0x21 and the switch IDs
(`switches --ids ...`) service 0x22. The 2012 Daytona answers service 0x22 with a refusal
(`7F 33 36`) until the ECU is unlocked (see above), and nothing shows the bike serves 0x21
either. The commands stay for ECUs that serve them, nothing else depends on them, and on a
locked Daytona they stop with an explanation (`probe` gives up after the first 8 ids, `live`
and `watch` say the ECU probably needs its unlock, `switches` and the page's Switches panel say
switch states need the ECU unlock, not available).

```bash
node cli.js probe
```

asks the ECU which data blocks it serves (a read-only query across all 255 block ids) and
remembers the biggest one: on Keihin bikes that is the "all sensors in one response" block
(~66 bytes, same idea as Suzuki SDS).

```bash
node cli.js watch
```

shows the sensor block as a live hex grid and highlights every byte that has changed since
the start, with its min..max range, for mapping the bytes to sensors by rolling the throttle
and warming the engine. As you identify fields, add them to `sensorBlock.fields` in
`src/bikes/triumph-keihin-2006-2012.js`:

```js
{ name: 'RPM', offset: 16, type: 'u16', scale: 1, unit: 'rpm', verified: true },
```

(`offset` is the 0-based position shown by `watch`; `u16` reads two bytes as high×256+low;
value = raw × scale + add.) Then:

```bash
node cli.js live --log run.csv
```

streams the decoded block values and appends every sample to a CSV: a header
`time,<field names>,raw`, then one row per sample with the ISO time, the decoded values and
the raw block as hex. A `?` after a value means the field is still marked unverified in the
map. `--id` picks the data block to read; without it the tool uses the block `probe` saved in
`config.json`, and before any probe the bike's default (`80`). `--map file.json` reads the
fields from a JSON file of the same shape. `watch` and `live` take `--interval <ms>` (150 and
200 by default). The map ships with one starting guess (TPS scaled /51, from a forum report)
that is unverified.

`node cli.js switches --ids 41,60` polls the named (hex) common IDs and highlights the ones
that change; IDs the ECU refuses are dropped after the first read. Without `--ids` it polls the
switches the bike description names (see Switches above).

## Output tests (optional)

An output test asks the ECU to drive one output for a few seconds, so you can check that a
relay, motor or actuator works without a second tool. **This is the only part of the tool that
makes the bike do anything**, and nothing else is ever commanded. It is off until you turn it on,
it needs the ECU unlock, and the effects have **not yet been confirmed on every bike**: every test
below is marked "not yet confirmed on a bike" because none of them has been run on one yet. The
routine bytes come from how another tool drives this ECU generation. If you run one on your bike,
note what happened (see CONTRIBUTING.md).

### The 8 tests

Exactly these, looked up by key in the bike description (`outputTests`). There is no way to ask for
anything else.

| Key | Test | What you should see | Safety |
|---|---|---|---|
| `tachometer` | Tachometer | The tach needle sweeps. | Only the dash needle moves. |
| `coolingFan` | Cooling fan | The fan spins. | Keep hands, tools and cables clear of the fan: it can start without warning. |
| `fuelPump` | Fuel pump | You hear the pump run for a few seconds, and the Fuel pump switch (id `0x60`) turns on. | Only with fuel in the tank (a pump run dry is damaged), and only for the few seconds it runs. |
| `idleSpeedControl` | Idle speed control | You may hear the idle speed stepper motor move. | Runs until it is stopped: the tool sends the stop when the watch ends (15 s) or when you press Stop. |
| `purgeValve` | Purge control valve | You hear the purge valve click or buzz. | Only the valve solenoid is driven. |
| `secondaryAir` | Secondary air injection (SAI) | You hear the secondary air valve click or buzz. | Only the air injection valve is driven. |
| `airFlap` | Air flap | The air flap moves; you can hear its actuator. | Keep fingers and cables clear of the flap and its linkage. |
| `exhaustValve` | Exhaust valve | The exhaust valve cable moves (the exhaust butterfly servo pulls and releases it). | Keep hands and cables clear of the servo and the valve cable: it moves with force. |

`node cli.js outputtest list` prints the same table.

### Preconditions

A test is sent only when all of this holds, checked by the tool before anything is sent (and a
refusal says which one failed):

- the ECU is **unlocked** (locked or not connected: "needs the ECU unlock, not available", nothing sent);
- you have said yes (the page asks with a confirmation, the CLI needs `--yes`);
- the **engine is off**: engine speed (mode 01 PID 0C) reads 0, and if it cannot be read the test is refused;
- the **bike is stationary**: vehicle speed (PID 0D) reads 0, and if it cannot be read the test is refused;
- the **battery** (id `0x07`) reads at least 10.5 V, and is readable. Between 10.5 and 11.5 V the test goes
  ahead with a warning that the ECU may reset;
- **no other test is running**, and the last one ended at least 5 seconds ago.

Put the key on, kill switch at RUN, engine off, the bike on its stand, with clear access to the fan
and the exhaust valve. A battery tender is a good idea.

### Enabling and running

On the page, the **Output tests** panel shows an explanation and a button, **Enable output tests**, that
stays disabled until you tick "The bike is stationary, the engine is off, the key is on, I have clear
access to the fan and exhaust valve, and I understand these tests make the bike move or run parts".
After that, every test shows what you should see and its safety note, and **Run test...** asks one more
confirmation before anything is sent. Enabling lasts for that page session only: a reload, a disconnect
or a lost unlock turns it off again, and nothing is remembered. While a test runs the panel shows the
effect as the tool sees it (for the fuel pump the Fuel pump switch flipping on and off again), the
dials and the Switches tiles keep refreshing, and **Stop** ends the watch early.

In the CLI:

```bash
node cli.js outputtest list            # the whitelist
node cli.js outputtest fuelPump        # what would happen and the preconditions; sends nothing
node cli.js outputtest fuelPump --yes  # connects and runs it
```

An unknown key is refused and the whitelist is printed. With `--yes` the command shows the effect as
it changes and, when it ends, where it was logged; Ctrl+C ends the watch early.

### What the tool sends

Start: service `31` with the one routine byte, `31 <byte>`; the ECU answers `71 <byte>`. The request is
sent once and never resent; a refusal is reported with its code, and silence is reported as "no answer".
Stop: only the idle speed control is stopped (`32 02`), when its watch ends, when you press Stop, or
when the connection ends (best effort); every other test ends by itself and nothing is sent to stop it.
While a test runs the tool watches for at most 8 s (15 s for the idle speed control), reading the
test's effect id (the fuel pump switch for the pump test) and the battery voltage, which also keeps the
session alive. A disconnect or a lost ECU ends the watch.

Every attempt, refusals included, and its result and the effect observed are appended to
`logs/output-tests-<date>.txt`.

### What is deliberately not here

No injector or ignition coil tests (this ECU has none), no throttle motor drive, and none of the
adjustment and reset routines (adjust exhaust valve, adjust idle, reset adaptation, reset throttle
position, idle fuel trim): they change stored values, which this tool does not do. No flashing, no
writing. The raw `send` command is limited to reads and refuses `31`, `32`, security access and every
other service that is not a read, before it connects.

## If the ECU won't answer

What this bike (a 2012 Daytona 675) really does, checked on the bike with the scripts below:

- **Fast init never answers.** The 25 ms pulse and `StartCommunication` to `D5`/`F5`, to
  functional `33` and to the generic addresses get silence every time. That is normal for this
  bike, not a cable fault, and `--init break` is not a fix for it (it only changes the fast pulse).
- **Slow init to `33` is the way in, and the ECU answers only about one try in three.** It
  replies `55`, then key bytes `08 08`; the tool must send `~KB2` (`F7`) 25-50 ms after the
  second key byte, after which the ECU says `CC`. A try that gets no `55` is normal: the tool
  retries every 6 s (up to 6 tries, a minute), and TuneECU does the same. Do not conclude
  "dead" from one or two silent tries; five or six in a row are worth investigating.
- **Idle matters.** The ECU wants at least 3 s of quiet on the line before the address byte,
  and keeps its own session for up to ~5 s after the last request, so tries are spaced 6 s
  apart and nothing else should talk on the cable meanwhile (close the GUI, other terminals,
  TuneECU: only one program can hold the port anyway).
- **Key-on timing.** Connect with the ignition already on (kill switch at RUN). If tries
  keep failing right after switching on, wait a few seconds for the ECU to boot and run
  `scan` again; if it answers only now and then, run `scripts/waitecu.js` and switch the key
  off and on while it runs: it restarts its cycle every time the K-line comes alive, so the
  first seconds after power-up are covered.
- Once connected it uses plain OBD-II framing (modes 01 and 03 work, 07 and 09 stay silent,
  service 22 is refused); no security unlock is needed for what this tool reads.

Checklist:

- Ignition on, kill switch at RUN? The ECU is asleep otherwise.
- Right COM port? `node cli.js ports` marks the FTDI one.
- TuneECU-style cables need the **FTDI VCP driver** (Windows usually installs it
  automatically; the port shows up as "USB Serial Port").
- Give the slow init its full minute; `--debug` prints every frame hex.
- `node cli.js scan --targets 11,10,12,01,02,33,3f,51,81,f1` casts a wider net for the fast
  addresses (other ECUs of the family; `--init break` is the alternate fast pulse for them).
- Still nothing: `node scripts/echotest.js COM5` first (is the line powered?), then
  `node scripts/obd9141.js COM5` (eight slow-init tries, raw bytes, about a minute), then
  `node scripts/waitecu.js COM5` while cycling the key.

### Hardware probe scripts

These talk to the cable directly (`node scripts/<name>.js [port]`, port defaults to COM5).
They send only wake-up patterns, the `~KB2` acknowledgement and read-only requests, and they
all share `src/probekit.js`. Every script first checks that the cable hears its own bytes
(except `echotest`, `holdlow` and `waitecu`, which check or watch the line themselves). Never
run one while the GUI or the CLI holds the port.

| Script | What it proves |
|---|---|
| `echotest.js` | The K-line is powered and the switch position is right: the cable hears its own bytes. Add `pulse` to also check that the 360-baud and break wake-up pulses really reach the wire. |
| `holdlow.js` | Wiring, with a multimeter: holds the K-line low and high in 10 s blocks (pin 7 to pin 4); the meter must swing between ~0 V and ~11 V. |
| `obd9141.js [port] [addr] [tries]` | The whole verified session with this bike: slow init to `33` with retries (default 8), `~KB2` in the W4 window, then modes 01, 03, 07, 09 and the 22 probes in ISO 9141-2 framing, every raw byte printed. Expect `48 6B D1 41 00 BC 3E 90 10 5F` for the supported-PID query, silence for 07 and 09, `7F 33 36` for 22. Independent of the tool's parser, so it separates "ECU silent" from "parser rejected it". Read-only, never mode 04. |
| `waitecu.js [port] [seconds]` | Catching an ECU that answers only now and then: cycles fast `D5`/`F5`, slow `33`, fast, slow `D5` at a relaxed pace and restarts the cycle whenever the K-line comes alive (key switched on). Stops at the first answer. |
| `slowinit.js [port] [addr] [tries]` | Slow-init timing: how far `setTimeout` overshoots here, and whether the answer depends on bit edges (busy-wait 196 ms, nominal 200 ms, plain sleeps). Judge a variant by the try it answered on; one miss means little on this bike. |
| `sweep.js [port] [slowTries]` | The tool's own wake-up, variant by variant: slow `33` first (up to 6 tries), then every fast pulse (break high-times and the baud trick) against the fast and generic addresses. A silent result predicts that `scan` stays silent. |
| `linesprobe.js [port] [slowTries]` | The tool's wake-up under every DTR/RTS combination, for cables that use those lines internally: slow `33` with retries, then the fast pulses. |
| `rawprobe.js [port] [section...]` | Raw capture of fast-init variants and odd handshakes (no pre-low, header and source variants, Honda-style init, StartCommunication timing offsets, passive listen), recording every byte so silence can be told from a rejected answer. This bike is silent on all of it; it is for the other ECUs of the family. Sections: `pulses headers honda offsets listen`. |

## How it works (for the curious)

- **Wake-up** (`src/wakeup.js` owns all of it). The order comes from the bike description
  (`wake.attempts`): for the Daytona 675 slow init to `33` (6 tries) first, then fast init to
  `D5`/`F5`, then functional `33`, then the generic targets; the saved wake-up goes before
  all of them.
  - *Slow init* (ISO 9141-2): after 3 s of bus idle (6 s between failed tries) the address
    byte is sent at 5 baud by bit-banging the break line: start bit low, 8 data bits LSB
    first, stop bit high, no parity, 196 ms per bit. Each edge is placed against an absolute
    time (the real clock busy-waits the last 30 ms, because Windows timers are ~16 ms
    coarse) so USB latency does not pile up. The ECU answers `0x55`, KB1, KB2 (`08 08` on the
    bike); the tool must send `~KB2` 25-50 ms after KB2 (it waits 28 ms; one sent late is
    ignored) and the ECU ends with `~address`. Receive buffers are flushed after the last
    bit because the break edges leave garbage bytes. KB2 `08` means ISO 9141-2 framing.
  - *Fast init* (ISO 14230): bus idle 320 ms, then the K-line is held low with a 200 ms
    break (Triumph Keihin ECUs want this long low; harmless to others), then a `0x00` byte
    sent at 360 baud, which is 9 bit-times x 2.78 ms = exactly 25 ms low timed by the UART
    hardware instead of the Windows scheduler. The tool waits for that byte's loopback echo,
    switches to 10,400 baud, and sends `StartCommunication`. With `--init break` the pulse is
    instead a 25 ms serial break timed by the OS, followed by 24 ms of high. Failed fast
    attempts are followed by a 350 ms pause.

  The result says which kind worked, the address and addressing mode, the key bytes and the
  session style, and carries a `replay` object that goes back in as `prefer`. Progress events
  name the try ("slow init 0x33, try 2/6").
- **Framing and requests** (`src/kwp.js`), two styles picked by how the session was woken.
  *Addressed* (KWP2000, after fast init): `fmt target source payload checksum`, checksum =
  sum of all bytes mod 256, payloads over 63 bytes get a separate length byte. *ISO 9141*
  (after slow init with KB2 `08`): requests are `68 6A F1 data checksum`, replies `48 6B D1
  data checksum`, checksum again the sum; there is no length byte, so a reply ends when the
  line has been quiet for 60 ms (replies sent back to back are told apart by their checksum
  and the next header), requests are kept at least 60 ms apart, there is no
  StartCommunication or StopCommunication, and no StartDiagnosticSession is sent. A request
  the ECU leaves completely unanswered (modes 07 and 09 on the bike) fails with kind
  `timeout`; a caller that expects that passes `allowSilence` so it does not count towards a
  lost link. In that style any reply starting `7F` is a refusal whatever its second byte
  (the bike answers `7F 33 36` to service `22`). The cable loops TX back to RX in both
  styles, so the session consumes its own echo before parsing. `request()` returns every
  reply frame or throws a `KwpError` whose `kind` is `timeout`, `bad-checksum`,
  `echo-mismatch`, `negative-response` (with `service` and `code`) or `wrong-service`.
  Link failures are resent once unless the request is declared `destructive` (clear DTCs),
  which is never resent.
- **The line lock** (`LineLock` in `src/kwp.js`, behind every session): one request on the K-line at a
  time, in a fixed order. `session.request(data, opts)` takes the line and gives it back in a
  `finally`, success or failure; the line passes straight to the next waiting request, so a late one
  cannot cut in. Two priorities (`PRIORITY.NORMAL`, and `PRIORITY.BACKGROUND` for reads nobody is
  watching move, `background: true`): when the line comes free the oldest background request that has
  waited `setBackgroundWaitMs(ms)` (300 ms unless the run coordinator changed it) goes first, else the
  oldest normal one. `session.hold()` returns `{ request, release }` for something that must not be
  interleaved (the unlock's seed and key): requests already queued finish first, then only the
  holder's requests go and everything else waits until `release()`. One hold at a time; always
  release in a `finally`.
- **Connection** (`src/connection.js`): the one place that turns a port name into a ready
  session: saved wake-up first, then the bike's order, then making the session ready and the
  keep-alive, `config.json` (which remembers the kind of wake-up that worked). An addressed
  session starts the bike's diagnostic session; an ISO 9141 session is ready only when its
  first request, mode 01 PID 00, is answered. The keep-alive is TesterPresent every 1.5 s, or
  mode 01 PID 00 every 2 s on ISO 9141, in both cases only while no other request is running.
  Its state is `disconnected`, `connecting`, `connected` or `lost` (the ECU stopped answering
  keep-alives and requests); the CLI and the GUI only render its progress and state. Probes,
  live reads and gauge loops register as runs and are cancelled when the session ends.
- **Unlock** (`src/unlock.js`, driven by the connection). Service `22` stays refused until
  security access: `27 05` returns a 16-bit seed, `27 06` answers with the key `(seed x
  multiplier) mod 65536`. The multiplier is read only from the git-ignored `unlock.json` beside
  `config.json` (`{"multiplier": <1..65535>}`); it is not in the source, the tests or any log, and
  without the file the whole feature is `unavailable` and no `27` is ever sent. The ECU may count
  wrong keys, so at most one key goes out per attempt, nothing is resent (both requests are
  `destructive`), and a failed attempt is never repeated by the software: the connection tries
  once when it becomes `connected` and only an explicit `unlock()` tries again. It also only
  sends the two levels `05` and `06` (a seed of `0000` means already unlocked and sends no key)
  and only on ISO 9141 sessions. The connection's unlock state is `unavailable`, `invalid`,
  `locked`, `unlocking`, `unlocked` or `failed` (with a reason); a new wake-up or a lost
  session starts over at `locked`, as the ECU itself forgets the unlock then.
- **Live data and codes** (`src/services.js`): mode 01 as a PID table (SAE J1979 formulas for
  load, coolant, short-term trim, manifold pressure, rpm, speed, timing advance, intake air,
  throttle, fuel system status and oxygen sensor 1). `readPid(session, pid)` returns the data
  bytes, or `null` when the ECU does not serve the PID (no reply at all, or a refusal), and
  never throws for that; the silence is passed to the session as `allowSilence`, so it does not
  count as a failing link (the keep-alive's own request does that). `decodePid(pid, bytes)`
  turns them into `{ value, unit, text? }`; `supportedPids(session)` reads the ECU's list (PID
  00, then 20, 40, ... only while the bitmap says the next range exists); `readStatus(session)`
  decodes PID 01 into `{ milOn, dtcCount }`. `readDtcs` returns the codes (mode 03, plus mode
  07 when the ECU answers it: silence or a refusal there means `pendingSupported: false`, not
  an error) with the status, and `faultSummary` is the one line comparing the warning light
  and the ECU's count with the codes read. On an ISO 9141 session there is no KWP fallback:
  a refused mode 03 or 04 is an error, never a different service.
- **Live runs** (`src/liverun.js`): one module owns what a run is. `LiveRun` polls over the
  connection's session at a pace and keeps the latest sample, min/max per channel, error counts, a
  short history for the graphs (`series(since)`) and, if asked, a CSV; `gaugeRun` (the dashboard: rpm,
  speed and throttle every cycle, one slower gauge per cycle in turn), `blockRun` (a sensor data
  block), `switchRun` and `probeRun` are its kinds. A run is stopped with `stop()` or by the
  connection ending (it registers with the connection when created). Read errors are counted and the
  run carries on: whether the link is dead is the connection's call. `gauges`, `watch`, `live`,
  `switches` and `probe` in the CLI and the matching endpoints of the GUI server only render what a
  run reports. `src/recorder.js` (`recordRun`: gauges, switches and analog values into one
  time-stamped CSV, with markers and events) and `src/discover.js` (`discoverRun`, the 0x22 sweep,
  and `takeSnapshot`) are runs too.
  - *Sample time.* A sample's time is when its cycle started, in ms since the run started, read once
    by the run and handed to the sampler as `ctx.t`. The graph history, the run CSV's `time` column
    and the recorder's `t_ms` all use that one value, so a live graph and the replay of its
    recording put a sample at the same moment.
  - *Log sink* (`src/logsink.js`): `openLogSink({ dir, prefix, stamp, maxBytes, onError })` is one
    log file and nothing about what goes in it: it never overwrites (a numbered name if the file
    exists), refuses rows past a size limit, closes itself if a write fails (reported once, never
    thrown into the run) and is closed by the run when the run ends. `DEFAULT_LOG_DIR` (the project's
    `logs` folder) and `logStamp(ms)` are defined there, once.
  - *Polled-item set* (`src/pollset.js`): `pollset({ items, every, ... })` is the policy "an item
    that never answered is dropped, one that answered keeps its last value (stale)" and the rotation
    "one item per cycle in turn", written once for the dashboard, the switch watcher and the
    recorder. It knows nothing about requests: each cycle `plan()` says what to read (and applies the
    unlock gate and the supported-PID list), the run reads it its own way and `report()`s what came
    back. The strike counts (3, 6, 2 ...) differ per caller on purpose and live in that file with
    the reason for each. The gauge run reads the supported-PID list first, so a gauge whose PID is
    not on it is marked `not available` without being asked.
  - *Run coordinator* (`src/runs.js`, `createRuns(conn)`): the one place that decides who may use the
    K-line. Every feature of the page is a run in one of three roles: `exclusive` (`recording`,
    `scan`: they refuse each other and hold the line alone), `background` (`dashboard`, `switches`:
    stopped for an exclusive run and started again when it ends, and held back, server-side, if the
    page asks meanwhile, so a reloaded page cannot start them beside the recorder) and `tool`
    (`sensor`, `probe`: started and stopped by the owner). `runs.start(name)`, `stop(name)`,
    `ensure(name)`, `reconcile()` and `status()` are the interface: the owner's Stop of the
    dashboard or the switch watcher is remembered until the next connection and nothing restarts it
    behind the owner's back, and `reconcile()` starts what should be running (the dashboard, and the
    switch watcher once unlocked) and is what the page calls once connected. The line priority
    tuning (how long a waiting switch read may be overtaken by the dashboard, longer while the
    engine runs) is there too. None of it can start anything the owner could not start before.
  - *GUI server* (`server.js`): routes only, `'METHOD /path': async (body, query) => object`,
    answered as `{ ok: true, ...object }` or `{ ok: false, error }`. Besides the routes the page
    already used (`POST /api/gauges/start` answers `{ paused: true, note }` while a recording or
    scan runs, and `GET /api/switches` answers its usual shape plus `paused: true` and a `note`), it
    has `GET /api/runs` (read-only: what is running, what is paused and why, which features the
    owner stopped, what waits for the unlock, which exclusive run is on), `POST /api/runs/start`
    and `POST /api/runs/stop` (`{ "feature": "dashboard" | "switches" }`: the owner starting or
    stopping it) and `POST /api/runs/reconcile`. `/api/gauges` returns the dial definitions, the
    latest values, the supported PIDs and the unavailable gauges (and `series` when asked with
    `?since=`); `/api/dtc` returns the codes, the warning light status and the one-line summary.
    `decodeSwitch(def, bytes)` in `src/services.js` is the one place that turns a switch id's bytes
    into on / off.
- **The page** (`public/index.html`, `public/js/`): the server serves the page at `/` and the
  scripts at `/js/<name>.js` and nothing else (a name is lower-case letters, digits and dashes and
  must be a file of `public/js`: no dots, slashes or other ways out of the folder; everything else is
  a 404). `app.js` is the drawing and DOM code; the logic without a DOM is in three plain scripts
  loaded before it, each setting one global and also working with `require()` in Node so the tests
  cross the same interface the page does: `graphstore.js` (`GraphStore`: the points the strip
  charts, the vitals strip and the fuel map are drawn from, re-based onto the page's clock, with a
  saved recording opened as a replay), `fuelmap.js` (`FuelMap`: the fuel map's cells, derived
  metrics and crosshair) and `session.js` (`SessionState`: what should be running, decided from
  `GET /api/runs`). The page keeps no flags of its own about who may use the K-line or what the
  owner stopped: it asks the server and follows. The graph lanes are listed in `app.js`.
- **Small shared modules**: `src/format.js` (hex text for ids and bytes), `src/clock.js` (the clock
  that everything that waits goes through, so tests can swap in one that never sleeps, and
  `waitUntil` for precise waits) and `src/recordings.js` (lists and reads the `record-*.csv` files
  of the logs folder, and only those, for the page's Saved recordings).
- **Bike knowledge** (`src/bikes/`): everything specific to one bike lives in one
  description file, `triumph-keihin-2006-2012.js`: the ECU and tester addresses and the
  order to try them in, the diagnostic session, the data block id and sensor block field
  map (advanced), the dashboard gauges (a standard PID each, with a unit conversion where
  needed, such as kPa to hPa for the manifold pressure) and the fault code meanings. The
  0x22 reads, which the bike serves once the ECU is unlocked, are there too: the id gauges
  (battery, gear), the `switches` table (id, name, inverted flag, words for the two states and a
  confirmation level with the note of how it was seen, from which the `switchIds` list is
  derived) and the `analogs` (voltages). The `outputTests` table is the whitelist of output tests
  (key, name, routine byte, whether it needs a stop, what you should see, a safety note, the effect id
  to watch and a confirmation level). `src/bikes/index.js` validates a description, adds `describeDtc(code)` and holds the
  one rule for which data block id to read (bike default, then what `probe` saved, then
  `--id`). The generic modules take all of this from the description they are given, so
  another bike is one more description file. Every fault code, from either protocol path,
  comes back as `{ code, status, statusByte, description }`; the CLI, the API and the page
  all show that description.
- **Probe kit** (`src/probekit.js`): what the scripts in `scripts/` share: capture window,
  busy-wait timing, power/echo check, frame building, echo stripping, raw pulses, and the
  wake-ups. `wake()` is the tool's own wake-up (fast or slow, a slow one with retries) so a
  silent probe predicts a silent `scan`. It reuses the tool's pieces wherever the behaviour is the
  same: the frame checksum and `buildFrame` are `checksum` and `addressedFrame` of `src/kwp.js`,
  and the 5-baud bit-banging, the key byte listener and the `~KB2` acknowledgement are
  `src/wakeup.js`'s. What deliberately differs stays here: the Honda-style two's-complement
  checksum (`withChecksum`), and `slowInit()`, which only sends the address and listens (bit time,
  edge timing and parity are options) and returns the moment KB2 has arrived, where the tool's slow
  init also waits for idle and acknowledges. `ackKb2()` sends `~KB2` 28 ms after the call (the ECU
  ignores one sent after about 50 ms) and `slowHandshake()` runs the whole exchange with the tool's
  retry spacing and reports where it stopped. Scripts only use the transport's interface; `npm test`
  runs the kit against the mock.
- **Services used**: mode 01 live data (the PIDs above), mode 03 stored codes, mode 04 clear
  codes (only behind `--yes` or the page's confirmation), mode 07 pending codes when served;
  on addressed (KWP2000) sessions also StartCommunication (81), StartDiagnosticSession (10),
  ReadEcuIdentification (1A), ReadDTCByStatus (18), ClearDTC (14), TesterPresent (3E) and
  StopCommunication (82); the advanced tools use ReadDataByLocalIdentifier (21) and
  ReadDataByCommonIdentifier (22). Security access (27) is sent only as the unlock above:
  levels 05 and 06, on ISO 9141 sessions, and only when `unlock.json` exists.
  Services `31` and `32` (the output tests above) are built in `src/outputtests.js` and nowhere
  else, only from the routine byte of a whitelisted test, and `npm test` fails if any other file
  builds such a request.
- **Tests**: `npm test` runs the whole stack without the bike or a serial port.
  `test/mockecu.js` is a recording transport: it logs every baud change, break, flush and
  write, and the mock ECU only answers after it has seen a proper wake-up pulse. In
  `iso9141` mode it behaves like the real bike: it decodes the 5-baud address from the break
  edges and their timestamps (bit time 200 ms +-10 %, no parity, 3 s of idle first), can
  answer only the Nth try, insists on `~KB2` 20-100 ms after KB2, then speaks the OBD-II
  framing from a table of PIDs (`t.pids`: PID to data bytes, the supported-PID list is derived
  from it), stored codes and per-mode handlers (`t.storedCodes`, `t.modes`), and stays silent
  for unsupported modes and PIDs. `t.dataIds` holds the 0x22 ids it serves once unlocked (values, or functions
  that return them) and `t.silentIds` the ones it leaves unanswered instead of refusing.
  Services `31` / `32` answer `71 <b>` / `72 <b>` for exactly the 8 routine bytes (`7F 31 12` for any
  other, `7F 33 36` while locked), record what was started and stopped (`t.routinesStarted`,
  `t.routinesStopped`) and flip id `0x60` for a few seconds on the pump routine; `outputTestsSilent` and
  `outputTestsRefuse` are its faults.
  `test/cli.test.js` and `test/cli-record.test.js` run the CLI commands against it and check
  what they print. The page's modules (`test/page-*.test.js`) and the server's static files are tested through
  the same interfaces the page uses. It can inject faults
  (dropped reply, corrupted checksum, partial echo, wrong service), and the tests use a clock
  that never sleeps.

## Licence

Copyright (C) 2026 Andrew Wilke. This program is free software: you can redistribute it and/or
modify it under the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version. It is
distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the file `LICENSE` for the
full text.
