# SolarCockpit - setup guide

This guide takes you from "never seen the adapter" to a working energy dashboard. It explains
the concepts first, then every setting, then the widgets. Deutsche Fassung: [../de/README.md](../de/README.md).

**Contents**

1. [Concepts](#1-concepts)
2. [Prerequisites](#2-prerequisites)
3. [Installation](#3-installation)
4. [Configuration, step by step](#4-configuration-step-by-step)
5. [Typical setups (examples)](#5-typical-setups-examples)
6. [Widgets and the 2.5D scene](#6-widgets-and-the-25d-scene)
7. [Energy plan and prices](#7-energy-plan-and-prices)
8. [Created states (reference)](#8-created-states-reference)
9. [Troubleshooting / FAQ](#9-troubleshooting--faq)

---

## 1. Concepts

**Entity.** Everything SolarCockpit knows about is an *entity*: one row in the configuration table
that points to an existing ioBroker state delivering the current power (W or kW). SolarCockpit does
not talk to devices itself - it only reads states that other adapters (Shelly, Modbus, Tibber, …)
already provide.

**Categories.**

| Category | Meaning | Examples |
|---|---|---|
| Producer | generates energy | PV string, balcony power plant |
| Consumer | uses energy | house meter, heat pump, wallbox, smart plug |
| Storage | stores energy | home battery |
| Grid | connection to the public grid | smart meter, Tibber Pulse, inverter grid register |
| Other resource | reserved for later (gas, water) | - |

**Sign convention.** Inside SolarCockpit, *positive* always means **import from the grid** /
**charging the battery**; producers and consumers are positive when they produce/consume. If a
source reports the opposite (e.g. a meter showing export as positive), tick *Invert sign*.

**Aggregate meters and "rest power".** A whole-house meter (e.g. Shelly 3EM) already contains
everything behind it. If some of those devices have their own meter (smart plugs), enter the
aggregate meter as an entity and give each child entity the aggregate's ID as *Parent
(aggregate) ID*. SolarCockpit then shows `restPower` = aggregate − sum of the children, so nothing
is counted twice. A producer that feeds in *behind* the house meter (balcony power plant) is
already netted out of the aggregate's reading - tick *Netted into parent* for it.

**Energy balance.** Production + grid import = consumption + battery charging + losses. If one
measurement is unreliable, SolarCockpit can compute the grid or the battery from all the others
("balance"). Whatever the meters together still cannot explain is shown as **measurement
residual** - a useful health indicator for your measurements.

**Losses.** Inverters and batteries lose energy. You can enter estimated efficiencies (SolarCockpit
creates separate *loss* entities from them), or - for a hybrid inverter with an AC output register
- let SolarCockpit measure the real inverter loss (DC inputs − AC output).

---

## 2. Prerequisites

- ioBroker with js-controller 5 or newer, Node.js 20 or newer, admin 6 or newer.
- **Location set** in *Admin → System settings* (latitude/longitude). The PV forecast, the sun
  position and the scene need it.
- **Power states** for everything you want to see (W or kW).
- **Recommended: a history adapter** - `history`, `influxdb` (1.x or 2.x) or `sql` - with logging
  enabled for every power state you add as an entity (in the object browser: gear icon of the
  state → enable logging). Without history SolarCockpit still works live, but there is no
  today/yesterday/7-day history, no ML forecast correction and no household load profile.
- **Optional:** vis-2 (widgets, scene), `tibberlink` (dynamic prices).

---

## 3. Installation

Version 0.1.0 is not yet in the ioBroker repository. Install the release package from GitHub:

1. Open the [releases page](https://github.com/tangermaier/ioBroker.solarcockpit/releases) and copy
   the link of the attached `iobroker.solarcockpit-<version>.tgz`.
2. On the ioBroker host run `iobroker url <copied link>` - or in Admin → *Adapters* use the
   GitHub/cat icon *"Install from custom URL"* and paste the link.
3. Add an instance of *SolarCockpit* (Admin → Adapters → SolarCockpit → "+").
4. If you use vis-2: restart the vis-2 instance afterwards so the widgets appear.

> Installing directly from the repository URL is not supported: the repository contains only
> source code, the release package contains the built widgets and scene.

---

## 4. Configuration, step by step

All settings are on one page (Admin → Instances → solarcockpit.0 → gear icon).

### 4.1 History data

| Field | What to enter |
|---|---|
| History instance | The instance that logs your power states, e.g. `influxdb.0`, `history.0`, `sql.0`. Leave empty to run without history. |

SolarCockpit reads hourly averages via the standard `getHistory` interface. Note for InfluxDB 1.x:
hours without data are filled with the previous value by that adapter.

### 4.2 Look-back (timeline)

| Field | Meaning |
|---|---|
| Look-back days | How far the timeline slider in the forecast card and the scene can go back (0 = forecast only). |
| Forecast color / Actual-values color | Curve colors in widget and scene. |

### 4.3 Prices

| Field | Meaning |
|---|---|
| Use dynamic prices from tibberlink | Read current and upcoming 15-minute prices from `tibberlink`. |
| tibberlink instance / Tibber home | Which instance and which home (list is loaded live; the instance must be running). |
| Grid purchase price state | Without Tibber: a state holding your price in ct/kWh. Leave empty and SolarCockpit creates an editable starter value under `0_userdata.0`. |
| Feed-in tariff state | Your feed-in tariff in ct/kWh (fixed; with Tibber it is treated as 0 during negative spot prices). |

### 4.4 Energy plan

| Field | Meaning |
|---|---|
| Duration (h) / Power (kW) | A typical shiftable appliance (washing machine: 2 h, 2 kW). The plan finds its cheapest start. |
| Max. grid export power (W) | Export limit of your inverter (0 = none). Surplus above it is curtailed - the plan takes that into account. |

### 4.5 Entities (the table)

Add one row per meter. Columns that do not apply to the category can stay empty.

**Basic columns (all entities)**

| Column | Meaning |
|---|---|
| Entity ID | Technical, unique, lower case (`pv_east`, `house`, `battery`). Becomes `entities.<id>.*`. |
| Name | Display name. |
| Category | Producer / Consumer / Storage / Grid / Other. |
| Power state | The state with the current power. |
| Unit | W or kW. |
| Invert sign | Source uses the opposite sign. |
| Noise threshold W | Values below this magnitude count as 0 (sensor noise, frozen readings). |
| Energy state | Optional cumulative kWh counter. |
| Parent (aggregate) ID | ID of the aggregate meter this reading is included in. |
| Netted into parent | Producer behind the aggregate meter (see concepts). |
| Color | Color in the diagrams. |

**Producers**

| Column | Meaning |
|---|---|
| Peak power kWp, Tilt °, Azimuth ° | Enables the Open-Meteo forecast for this string. Azimuth: 0 = south, −90 = east, 90 = west. |
| Inverter AC limit W | Caps the forecast (e.g. 800 W balcony inverter). |
| Efficiency % | Estimated DC/AC efficiency → creates an estimated loss entity (100 = off). |

**Storage**

| Column | Meaning |
|---|---|
| State of charge, Capacity kWh | SoC state in % and usable capacity. |
| Charge / discharge efficiency % | Estimated losses (100 = off). |
| Min./Max. SoC %, Max. power kW, Wear cost ct/kWh | Limits and battery ageing cost for the energy plan. |
| Inverter AC output | AC output state of a hybrid inverter → **measured** inverter loss. |
| Inverter DC producers (IDs) | Comma-separated IDs of the PV entities on that inverter. |

**Grid / storage: power source**

| Column | Meaning |
|---|---|
| Power source | *Measurement* (default), *Balance* (computed from all other categories) or *Measurement, balance on outage*. Only one entity may come from the balance. |
| Outage after (s) | Seconds without updates before the fallback takes over (default 120). |
| Fallback measurement | A second meter used before the balance (e.g. the inverter's grid register when a cloud meter is down). |
| Invert fallback | Sign of that second meter. |
| Export state (grid only) | For meters with two positive values (import and export, e.g. Tibber Pulse): power = import − export. |

Save - the instance restarts. After about two minutes (first ML training) forecast and plan appear.

---

## 5. Typical setups (examples)

**A) PV + battery + smart meter**

| ID | Category | Power state | Notes |
|---|---|---|---|
| `pv_east`, `pv_west` | Producer | inverter PV1/PV2 power | kWp, tilt, azimuth per string |
| `battery` | Storage | battery power | SoC + capacity; *Invert sign* if discharge is positive |
| `grid` | Grid | smart meter power | |
| `house` | Consumer | house meter (e.g. Shelly 3EM) | |

**B) Balcony power plant behind the house meter.** Add it as a producer with
*Parent (aggregate) ID* = `house` and tick *Netted into parent*. The house meter only sees the
remaining consumption; SolarCockpit adds the balcony plant back so the consumption is correct.

**C) Smart plugs under the house meter.** Each plug: Consumer, *Parent* = `house`. `house.restPower`
then shows "everything else".

**D) Cloud meter with separate import/export values (Tibber Pulse).** Grid entity: power state =
`…powerConsumption`, export state = `…powerProduction`, power source = *Measurement, balance on
outage*, optional fallback = your inverter's grid register.

---

## 6. Widgets and the 2.5D scene

Open the vis-2 editor; the widget set **SolarCockpit** contains:

| Widget | What it shows | Minimum binding |
|---|---|---|
| **Energy Flow Arrows** | Sankey-style flows from sources to consumers incl. losses and measurement residual; tap for full screen with *Now / Today / Yesterday / 7 days*. | Number of participants + one power state per participant (`solarcockpit.0.entities.<id>.power`). |
| **Forecast & weather** | Forecast curve with actual values, weather, timeline slider, recommendation and current plan mode. | Pre-filled with `solarcockpit.0.*` defaults. |
| **Energy Plan** | Price, PV/load, planned SoC, modes and appliance window over the plan horizon; tap for full screen. | Pre-filled defaults. |
| **Yield & energy flow** | Compact ring diagram (producer, grid, storage, consumer). | The four `summary.<category>.power` states (pre-filled). |

**The 2.5D scene** is a separate page served by the adapter:
`http://<iobroker>:8082/solarcockpit/index.html` (port of your `web` instance). It shows real 3D
buildings, the sun path, the forecast/actual yield as a band, building shadows and weather.
Embed it in vis-2 with a *basic iFrame* widget on a view named **`SolarCockpit3D`** - the forecast
card and the ring diagram open that view when tapped.
URL parameters: `?lang=de` (language), `?lat=…&lon=…` (show another place; your own building
shadows are hidden then).

---

## 7. Energy plan and prices

The plan looks ahead as far as prices are known (Tibber publishes tomorrow's prices around
13:00) in 15-minute steps and chooses per step:

| Mode | Meaning |
|---|---|
| Self-consumption | Normal operation: PV covers the house, surplus charges the battery. |
| Grid charging | Charge the battery from the grid now because the energy is worth more later. |
| Hold battery | Don't discharge now; the battery energy is more valuable later. |
| Export before charging | Export now and charge later from PV (avoids curtailment). |

It uses the PV forecast, the household load profile (median per hour over 28 days, workdays and
weekends separately) and your battery limits. `plan.expectedSavings` is the advantage over
plain self-consumption.

**The plan is advisory - SolarCockpit does not control your inverter.** It writes its suggestion
to `plan.*`; acting on it (manually or by your own script) is your decision.

---

## 8. Created states (reference)

| State | Meaning |
|---|---|
| `entities.<id>.power` | Normalized power (W) of an entity. |
| `entities.<id>.restPower` | Aggregate minus children. |
| `entities.<id>.energyToday / energyYesterday / energyLast7Days` | Energy from history (kWh). |
| `entities.<id>.source`, `rawPower`, `balancePower` | Diagnostics for grid/storage power sources. |
| `entities.<id>.forecastPower`, `forecastToday`, `forecastTomorrow` | PV forecast per producer. |
| `summary.<category>.power` | Sum per category. |
| `summary.balanceResidual.*` | Measurement residual (live and history). |
| `summary.producer.forecast*` / `actualPower` | Combined forecast and actual series (JSON). |
| `summary.weather.*` | Current weather and hourly weather series. |
| `prices.*` | Current purchase price, feed-in tariff, Tibber level, price source. |
| `plan.*` | Plan (JSON), current mode, target SoC, marginal cost, expected savings, status. |
| `recommendation.*` | Recommendation text, cheapest appliance window, surplus figures. |
| `costs.today / yesterday` | Grid cost (import × price − export × tariff). |

---

## 9. Troubleshooting / FAQ

**Values jump or show small phantom flows.** Set a *noise threshold* for the affected entity.

**Measurement residual is large.** Check signs (*Invert sign*) and units (W vs kW) first. A constant
residual of 50-150 W is usually unmeasured self-consumption of inverter/battery - configure the
inverter AC output to measure it.

**No forecast.** Location set in system settings? Producer has kWp, tilt and azimuth? The adapter
needs internet access to `api.open-meteo.com`.

**No today/yesterday values, no ML correction.** History instance selected? Logging enabled for
*every* power state used? Check the adapter log for `getHistory` errors.

**"≈ estimated" next to the grid.** The grid meter delivers no values, the balance stands in.

**Energy plan shows "No price data".** Check the price states or the tibberlink instance/home.

**Widgets missing in vis-2.** Restart the vis-2 instance after installing/updating the adapter.

**Texts in the wrong language.** Backend texts follow *Admin → System settings → Language*; the
widgets follow the vis-2 language. After changing the system language restart the SolarCockpit,
vis-2 and web instances.
