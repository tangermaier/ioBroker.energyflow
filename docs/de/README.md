# EnergyFlow – Einrichtungsanleitung

Diese Anleitung führt dich vom ersten Kontakt mit dem Adapter bis zum fertigen Energie-Dashboard.
Erst die Begriffe, dann jede Einstellung, dann die Widgets. English version: [../en/README.md](../en/README.md).

**Inhalt**

1. [Begriffe](#1-begriffe)
2. [Voraussetzungen](#2-voraussetzungen)
3. [Installation](#3-installation)
4. [Konfiguration Schritt für Schritt](#4-konfiguration-schritt-für-schritt)
5. [Typische Anlagen (Beispiele)](#5-typische-anlagen-beispiele)
6. [Widgets und 2,5D-Szene](#6-widgets-und-25d-szene)
7. [Energieplan und Preise](#7-energieplan-und-preise)
8. [Angelegte States (Referenz)](#8-angelegte-states-referenz)
9. [Fehlersuche / FAQ](#9-fehlersuche--faq)

---

## 1. Begriffe

**Entity.** Alles, was EnergyFlow kennt, ist eine *Entity*: eine Zeile in der Konfigurationstabelle,
die auf einen vorhandenen ioBroker-State mit der aktuellen Leistung (W oder kW) zeigt. EnergyFlow
spricht selbst mit keinem Gerät – es liest nur States, die andere Adapter (Shelly, Modbus, Tibber …)
bereits liefern.

**Kategorien.**

| Kategorie | Bedeutung | Beispiele |
|---|---|---|
| Erzeuger | erzeugt Energie | PV-String, Balkonkraftwerk |
| Verbraucher | verbraucht Energie | Hauszähler, Wärmepumpe, Wallbox, Smart-Plug |
| Speicher | speichert Energie | Hausakku |
| Netz | Anschluss ans öffentliche Netz | Smart Meter, Tibber Pulse, Netzregister des Wechselrichters |
| Sonstige Ressource | für später reserviert (Gas, Wasser) | – |

**Vorzeichen.** In EnergyFlow bedeutet *positiv* immer **Netzbezug** bzw. **Akku laden**; Erzeuger
und Verbraucher sind positiv, wenn sie erzeugen bzw. verbrauchen. Meldet eine Quelle es andersherum
(z. B. Einspeisung positiv), setze *Vorzeichen umkehren*.

**Sammelmessung und „Restleistung“.** Ein Hauszähler (z. B. Shelly 3EM) enthält bereits alles, was
dahinter hängt. Haben einige dieser Geräte einen eigenen Zähler (Smart-Plugs), lege den Hauszähler
als Entity an und trage bei jedem Kind die ID des Hauszählers als *Parent (Sammelmessung) ID* ein.
EnergyFlow zeigt dann `restPower` = Sammelmessung − Summe der Kinder; nichts wird doppelt gezählt.
Ein Erzeuger, der *hinter* dem Hauszähler einspeist (Balkonkraftwerk), steckt bereits verrechnet
im Zählerwert – setze bei ihm *In Parent verrechnet*.

**Energiebilanz.** Erzeugung + Netzbezug = Verbrauch + Akkuladung + Verluste. Ist eine Messung
unzuverlässig, kann EnergyFlow Netz oder Akku aus allen anderen berechnen („Bilanz“). Was die
Messungen zusammen dann noch nicht erklären, zeigt die **Messabweichung** – ein guter Gradmesser
für die Qualität deiner Messungen.

**Verluste.** Wechselrichter und Akkus verlieren Energie. Du kannst geschätzte Wirkungsgrade
eintragen (daraus entstehen eigene *Verlust*-Entities) oder – bei einem Hybrid-Wechselrichter mit
AC-Ausgangsregister – den echten Wechselrichter-Verlust messen lassen (DC-Eingänge − AC-Ausgang).

---

## 2. Voraussetzungen

- ioBroker mit js-controller ab 5, Node.js ab 20, Admin ab 6.
- **Standort gesetzt** unter *Admin → Systemeinstellungen* (Breiten-/Längengrad). Prognose,
  Sonnenstand und Szene brauchen ihn.
- **Leistungs-States** für alles, was du sehen willst (W oder kW).
- **Empfohlen: ein History-Adapter** – `history`, `influxdb` (1.x oder 2.x) oder `sql` – mit
  aktivierter Aufzeichnung für jeden Leistungs-State, den du als Entity einträgst (Objektbrowser:
  Zahnrad am State → Aufzeichnung aktivieren). Ohne Historie läuft EnergyFlow live, aber ohne
  Heute/Gestern/7-Tage-Werte, ohne ML-Korrektur der Prognose und ohne Lastprofil.
- **Optional:** vis-2 (Widgets, Szene), `tibberlink` (dynamische Preise).

---

## 3. Installation

Version 0.1.0 ist noch nicht im ioBroker-Repository. Installiere das Release-Paket von GitHub:

1. Öffne die [Releases-Seite](https://github.com/tangermaier/ioBroker.energyflow/releases) und
   kopiere den Link der angehängten Datei `iobroker.energyflow-<version>.tgz`.
2. Auf dem ioBroker-Host `iobroker url <kopierter Link>` ausführen – oder in Admin → *Adapter* über
   das GitHub-/Katzen-Symbol *„Installieren aus eigener URL“* den Link einfügen.
3. Instanz anlegen (Admin → Adapter → EnergyFlow → „+“).
4. Mit vis-2: die vis-2-Instanz danach neu starten, damit die Widgets erscheinen.

> Eine Installation direkt von der Repository-URL wird nicht unterstützt: Das Repository enthält
> nur Quellcode, das Release-Paket die fertig gebauten Widgets und die Szene.

---

## 4. Konfiguration Schritt für Schritt

Alle Einstellungen liegen auf einer Seite (Admin → Instanzen → energyflow.0 → Zahnrad).

### 4.1 Verlaufsdaten

| Feld | Eintrag |
|---|---|
| History-Instanz | Die Instanz, die deine Leistungs-States aufzeichnet, z. B. `influxdb.0`, `history.0`, `sql.0`. Leer = ohne Historie. |

EnergyFlow liest Stundenmittel über die Standardschnittstelle `getHistory`. Hinweis zu InfluxDB 1.x:
Stunden ohne Daten füllt dieser Adapter mit dem Vorwert auf.

### 4.2 Rückblick (Zeitregler)

| Feld | Bedeutung |
|---|---|
| Rückblick-Tage | Wie weit der Zeitregler in Prognose-Karte und Szene zurückreicht (0 = nur Prognose). |
| Farbe Prognose / Farbe Ist-Werte | Kurvenfarben in Widget und Szene. |

### 4.3 Preise

| Feld | Bedeutung |
|---|---|
| Dynamische Preise aus Tibberlink verwenden | Aktuelle und kommende 15-Minuten-Preise aus `tibberlink` lesen. |
| Tibberlink-Instanz / Tibber-Zuhause | Welche Instanz und welches Zuhause (Liste wird live geladen; die Instanz muss laufen). |
| Netzbezugspreis-State | Ohne Tibber: State mit deinem Preis in ct/kWh. Leer lassen, dann legt EnergyFlow einen editierbaren Startwert unter `0_userdata.0` an. |
| Einspeisevergütungs-State | Deine Vergütung in ct/kWh (fest; mit Tibber bei negativen Börsenpreisen als 0 behandelt). |

### 4.4 Energieplan

| Feld | Bedeutung |
|---|---|
| Laufzeit (h) / Leistung (kW) | Ein typischer verschiebbarer Verbraucher (Waschmaschine: 2 h, 2 kW). Der Plan sucht dessen günstigsten Start. |
| Max. Einspeiseleistung (W) | Einspeisegrenze deines Wechselrichters (0 = keine). Überschuss darüber wird abgeregelt – der Plan berücksichtigt das. |

### 4.5 Entities (die Tabelle)

Pro Zähler eine Zeile. Spalten, die zur Kategorie nicht passen, bleiben leer.

**Grundspalten (alle Entities)**

| Spalte | Bedeutung |
|---|---|
| Entity-ID | Technisch, eindeutig, klein geschrieben (`pv_ost`, `haus`, `akku`). Wird zu `entities.<id>.*`. |
| Name | Anzeigename. |
| Kategorie | Erzeuger / Verbraucher / Speicher / Netz / Sonstige. |
| Leistungs-State | Der State mit der aktuellen Leistung. |
| Einheit | W oder kW. |
| Vorzeichen umkehren | Quelle nutzt das umgekehrte Vorzeichen. |
| Rauschschwelle W | Werte unterhalb dieses Betrags zählen als 0 (Sensorrauschen, eingefrorene Werte). |
| Energie-State | Optionaler kumulierter kWh-Zähler. |
| Parent (Sammelmessung) ID | ID der Sammelmessung, in der dieser Wert enthalten ist. |
| In Parent verrechnet (invertiert) | Erzeuger hinter der Sammelmessung (siehe Begriffe). |
| Farbe | Farbe in den Diagrammen. |

**Erzeuger**

| Spalte | Bedeutung |
|---|---|
| Peak-Leistung kWp, Neigung °, Ausrichtung ° | Schaltet die Open-Meteo-Prognose für diesen String ein. Ausrichtung: 0 = Süd, −90 = Ost, 90 = West. |
| Wechselrichter-AC-Limit W | Deckelt die Prognose (z. B. 800-W-Balkonwechselrichter). |
| Wirkungsgrad % | Geschätzter DC/AC-Wirkungsgrad → eigene geschätzte Verlust-Entity (100 = aus). |

**Speicher**

| Spalte | Bedeutung |
|---|---|
| Ladezustand, Kapazität kWh | SoC-State in % und nutzbare Kapazität. |
| Lade-/Entlade-Wirkungsgrad % | Geschätzte Verluste (100 = aus). |
| Min./Max. Ladestand %, Max. Lade-/Entladeleistung kW, Verschleißkosten Ct/kWh | Grenzen und Alterungskosten für den Energieplan. |
| WR-AC-Ausgang | AC-Ausgangsleistung eines Hybrid-Wechselrichters → **gemessener** Wechselrichter-Verlust. |
| WR-DC-Erzeuger (IDs) | Kommagetrennte IDs der PV-Entities an diesem Wechselrichter. |

**Netz / Speicher: Leistungsquelle**

| Spalte | Bedeutung |
|---|---|
| Leistungsquelle | *Messung* (Standard), *Bilanz* (aus allen anderen Kategorien berechnet) oder *Messung, Bilanz bei Ausfall*. Nur eine Entity darf aus der Bilanz kommen. |
| Ausfall nach (s) | Sekunden ohne Aktualisierung, bevor der Ersatz greift (Standard 120). |
| Ersatz-Messung | Zweiter Zähler, der vor der Bilanz einspringt (z. B. Netzregister des Wechselrichters, wenn ein Cloud-Zähler ausfällt). |
| Ersatz invertieren | Vorzeichen dieses zweiten Zählers. |
| Einspeise-State (nur Netz) | Für Zähler mit zwei positiven Werten (Bezug und Einspeisung, z. B. Tibber Pulse): Leistung = Bezug − Einspeisung. |

Speichern – die Instanz startet neu. Nach etwa zwei Minuten (erstes ML-Training) erscheinen
Prognose und Plan.

---

## 5. Typische Anlagen (Beispiele)

**A) PV + Akku + Smart Meter**

| ID | Kategorie | Leistungs-State | Hinweise |
|---|---|---|---|
| `pv_ost`, `pv_west` | Erzeuger | PV1-/PV2-Leistung des Wechselrichters | kWp, Neigung, Ausrichtung je String |
| `akku` | Speicher | Akkuleistung | SoC + Kapazität; *Vorzeichen umkehren*, falls Entladen positiv ist |
| `netz` | Netz | Leistung des Smart Meters | |
| `haus` | Verbraucher | Hauszähler (z. B. Shelly 3EM) | |

**B) Balkonkraftwerk hinter dem Hauszähler.** Als Erzeuger mit *Parent* = `haus` anlegen und
*In Parent verrechnet* setzen. Der Hauszähler sieht nur den Restverbrauch; EnergyFlow rechnet das
Balkonkraftwerk wieder hinzu, damit der Verbrauch stimmt.

**C) Smart-Plugs unter dem Hauszähler.** Jeder Plug: Verbraucher, *Parent* = `haus`.
`haus.restPower` zeigt dann „alles andere“.

**D) Cloud-Zähler mit getrennten Bezugs-/Einspeisewerten (Tibber Pulse).** Netz-Entity:
Leistungs-State = `…powerConsumption`, Einspeise-State = `…powerProduction`, Leistungsquelle =
*Messung, Bilanz bei Ausfall*, optional Ersatz-Messung = Netzregister deines Wechselrichters.

---

## 6. Widgets und 2,5D-Szene

Im vis-2-Editor enthält das Widget-Set **EnergyFlow**:

| Widget | Zeigt | Mindest-Verknüpfung |
|---|---|---|
| **Energy Flow Arrows** | Flüsse von den Quellen zu den Verbrauchern inkl. Verlusten und Messabweichung; Antippen öffnet das Vollbild mit *Jetzt / Heute / Gestern / 7 Tage*. | Anzahl Teilnehmer + je Teilnehmer ein Leistungs-State (`energyflow.0.entities.<id>.power`). |
| **Energy Flow – Forecast** | Prognosekurve mit Ist-Werten, Wetter, Zeitregler, Empfehlung und aktuellem Planmodus. | Mit `energyflow.0.*`-Standardwerten vorbelegt. |
| **Energy Plan** | Preis, PV/Last, geplanter Ladestand, Modi und Verbraucher-Fenster über den Planungshorizont; Antippen öffnet das Vollbild. | Vorbelegt. |
| **Energy Flow Diagram** | Kompaktes Ringdiagramm (Erzeuger, Netz, Speicher, Verbraucher). | Die vier `summary.<kategorie>.power`-States (vorbelegt). |

**Die 2,5D-Szene** ist eine eigene Seite des Adapters:
`http://<iobroker>:8082/energyflow/index.html` (Port deiner `web`-Instanz). Sie zeigt echte
3D-Gebäude, die Sonnenbahn, Prognose und Ist-Ertrag als Band, Gebäudeschatten und das Wetter.
Binde sie in vis-2 mit einem *basic iFrame*-Widget auf einer View namens **`Energyflow3D`** ein –
Prognose-Karte und Ringdiagramm öffnen diese View beim Antippen.
URL-Parameter: `?lang=en` (Sprache), `?lat=…&lon=…` (anderen Ort zeigen; die eigenen
Gebäudeschatten werden dann ausgeblendet).

---

## 7. Energieplan und Preise

Der Plan schaut so weit voraus, wie Preise bekannt sind (Tibber veröffentlicht die Preise für
morgen gegen 13 Uhr), in 15-Minuten-Schritten, und wählt je Schritt:

| Modus | Bedeutung |
|---|---|
| Eigenverbrauch | Normalbetrieb: PV deckt das Haus, Überschuss lädt den Akku. |
| Netzladen | Akku jetzt aus dem Netz laden, weil die Energie später mehr wert ist. |
| Akku halten | Jetzt nicht entladen; die Akkuenergie ist später wertvoller. |
| Einspeisen vor Laden | Jetzt einspeisen und später aus PV laden (vermeidet Abregelung). |

Er nutzt die PV-Prognose, das Lastprofil des Haushalts (Median je Stunde über 28 Tage, Werktag und
Wochenende getrennt) und deine Akku-Grenzen. `plan.expectedSavings` ist der Vorteil gegenüber
reinem Eigenverbrauch.

**Der Plan ist nur beratend – EnergyFlow steuert deinen Wechselrichter nicht.** Er schreibt seinen
Vorschlag nach `plan.*`; ob und wie du ihn umsetzt (manuell oder per eigenem Skript), entscheidest du.

---

## 8. Angelegte States (Referenz)

| State | Bedeutung |
|---|---|
| `entities.<id>.power` | Normalisierte Leistung (W) einer Entity. |
| `entities.<id>.restPower` | Sammelmessung minus Kinder. |
| `entities.<id>.energyToday / energyYesterday / energyLast7Days` | Energie aus der Historie (kWh). |
| `entities.<id>.source`, `rawPower`, `balancePower` | Diagnose der Leistungsquelle bei Netz/Speicher. |
| `entities.<id>.forecastPower`, `forecastToday`, `forecastTomorrow` | PV-Prognose je Erzeuger. |
| `summary.<kategorie>.power` | Summe je Kategorie. |
| `summary.balanceResidual.*` | Messabweichung (live und Historie). |
| `summary.producer.forecast*` / `actualPower` | Kombinierte Prognose- und Ist-Reihen (JSON). |
| `summary.weather.*` | Aktuelles Wetter und stündliche Wetterreihe. |
| `prices.*` | Aktueller Bezugspreis, Einspeisevergütung, Tibber-Preisniveau, Preisquelle. |
| `plan.*` | Plan (JSON), aktueller Modus, Ziel-Ladestand, Grenzkosten, erwarteter Vorteil, Status. |
| `recommendation.*` | Empfehlungstext, günstigstes Verbraucher-Fenster, Überschusswerte. |
| `costs.today / yesterday` | Netzkosten (Bezug × Preis − Einspeisung × Vergütung). |

---

## 9. Fehlersuche / FAQ

**Werte springen oder kleine Phantomflüsse.** *Rauschschwelle* für die betroffene Entity setzen.

**Messabweichung ist groß.** Zuerst Vorzeichen (*Vorzeichen umkehren*) und Einheiten (W/kW) prüfen.
Eine konstante Abweichung von 50–150 W ist meist der ungemessene Eigenverbrauch von Wechselrichter/
Akku – mit dem AC-Ausgang des Wechselrichters lässt er sich messen.

**Keine Prognose.** Standort in den Systemeinstellungen gesetzt? Erzeuger mit kWp, Neigung und
Ausrichtung? Der Adapter braucht Internetzugang zu `api.open-meteo.com`.

**Keine Heute/Gestern-Werte, keine ML-Korrektur.** History-Instanz gewählt? Aufzeichnung für *jeden*
verwendeten Leistungs-State aktiv? Im Adapter-Log nach `getHistory`-Fehlern suchen.

**„≈ geschätzt“ am Netz.** Der Netzzähler liefert keine Werte, die Bilanz springt ein.

**Energieplan zeigt „Keine Preisdaten“.** Preis-States bzw. tibberlink-Instanz/-Zuhause prüfen.

**Widgets fehlen in vis-2.** Nach Installation/Update die vis-2-Instanz neu starten.

**Texte in der falschen Sprache.** Backend-Texte folgen *Admin → Systemeinstellungen → Sprache*,
die Widgets der vis-2-Sprache. Nach einer Sprachänderung die Instanzen von EnergyFlow, vis-2 und
web neu starten.
