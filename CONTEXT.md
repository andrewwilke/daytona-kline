# Context

The words this project uses, in plain terms. The README says what the tool does; this says what
the words mean.

**ECU.** The engine control unit: the computer in the bike that runs the engine and answers the
tool's questions.

**K-line.** The single wire in the bike's diagnostic connector that the tool and the ECU talk over.
Only one of them speaks at a time, so only one request is on it at any moment.

**Slow init.** The way this bike's ECU is woken: the tool sends the ECU's address one slow bit at a
time (5 bits a second), then the ECU answers with a few bytes that say how to talk to it. It can
take several tries.

**Session.** A ready, awake conversation with the ECU after a successful wake-up. It ends on
disconnect or when the ECU stops answering, and the next one starts afresh.

**Unlock.** The ECU's own security step (security access). Until it is done, the ECU refuses some
reads (switch states, battery, gear, output tests). It needs a number that belongs to the owner's
ECU and is never in this project. One key is sent per connection, and never again by itself.

**Gauge.** A live engine value read with a standard OBD request (rpm, speed, throttle, coolant
and so on). A few extra values need the unlock.

**Switch.** An on/off input or output the ECU reports by id (neutral, clutch, fuel pump, ...), shown
by name and in words. Needs the unlock.

**Analog.** A voltage-like value read by id (for example the sidestand sensor), shown as a number
rather than on/off.

**Gauge run.** The dashboard's loop: read the main gauges over and over, a few every cycle and the
others in turn, and keep the newest values and a short history for the graphs.

**Run.** Anything that polls the ECU in a loop and reports what it saw: a gauge run, the switch
watcher, a recording, an id scan, a sensor block read or a probe.

**Run coordinator.** The one module that decides which run may use the K-line. A recording or an id
scan holds the line alone; the dashboard and the switch watcher step aside for it and come back
afterwards, unless the owner stopped them.

**Polled-item set.** The list a run asks the ECU about, with the rules for it: an item that never
answers is dropped, one that answered once keeps its last value, and the slower items take turns
one per cycle.

**Recording.** The Record feature: gauges, switches and analog values read together, each sample
stamped with its time, written to one CSV file together with notes and events.

**Event.** Something the recording notices between two samples (the engine stopped, the fuel pump
went off while running, the battery dipped, ...), written to the CSV and listed live.

**Output test.** One of a short, fixed list of tests that ask the ECU to run a part for a few
seconds (the fan, the fuel pump, ...) so the owner can see or hear it work. Off until enabled, and
only on a stationary bike with the engine off.

**Bike description.** The one file that holds everything specific to a bike: ECU addresses, wake-up
order, gauges, switch and analog tables, fault code meanings and the output test list.

**Tip-over sensor.** The bike's fall-detection switch. When it trips, the ECU will not let the
engine start; it is shown as a switch and a flag in recordings.

**Vitals.** The row of key numbers (engine speed, throttle, battery, coolant, injection pulse, fuel
pump, tip-over sensor) that stays on screen on every tab of the page.
