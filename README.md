# Asset Calendar Standalone

A standalone React + TypeScript calendar component designed for **Snipe-IT asset workflows**.

It supports four operational modes:

* **`view`** → read-only availability and reservation overview
* **`checkout`** → choose a legal checkout end time for selected assets
* **`reserve`** → create one or more future reservation periods for selected assets
* **`edit`** → fully edit the **complete set of periods per asset for one or more editable users**

The component is built so the same calendar can later be embedded into a dedicated Snipe-IT tab.

---

# Core integration idea

The calendar receives a list of assets as input.

Each asset includes:

* identity info (`id`, `name`)
* existing reservations already in the system
* optional UI color

Depending on the mode, the calendar returns either:

* **new legal additions per asset** (`checkout`, `reserve`)
* **the full final legal editable set per asset and per user** (`edit`)

This keeps backend integration explicit and predictable.

---

# Input format

```ts
export type TimePeriod = {
  start: string; // YYYY-MM-DD HH:mm
  end: string;   // YYYY-MM-DD HH:mm
};

export type ExistingReservation = TimePeriod & {
  userName: string;
};

export type Asset = {
  id: string;
  name: string;
  color?: string;
  existingPeriods: ExistingReservation[];
};

export type CalendarInput = {
  mode: 'view' | 'checkout' | 'reserve' | 'edit';
  currentUser?: string;
  currentUsers?: string[];
  continuousCutMode?: boolean;
  assets: Asset[];
};
```

---

# Output format

```ts
export type CalendarOutput = {
  assets: Array<
    | {
        id: string;
        name: string;
        selectedPeriods: TimePeriod[];
      }
    | {
        id: string;
        name: string;
        users: {
          userName: string;
          selectedPeriods: TimePeriod[];
        }[];
      }
  >;
};
```

---

# Important output semantics

## Checkout mode output

In **checkout mode**, the returned periods are:

> the **new legal checkout periods to add per asset**

This means:

* output contains only the newly selected legal checkout time window
* periods are already cut safely per asset
* overlap conflicts are already removed by the calendar logic
* backend can directly create checkout entries from this output

### Meaning

This is **not** the full reservation history.
It is only the **new legal addition per asset**.

---

## Reserve mode output

In **reserve mode**, the returned periods are:

> the **new legal reservation periods to add per asset**

This includes:

* split periods caused by existing reservations
* repeated reservations if repeat mode was used
* per-asset legal slicing
* automatic visual safety limiting if split groups become too fragmented

### Meaning

This is also **not** the full reservation history.
It is the **new validated additions per asset only**.

Your backend should **append these periods**.

---

## Edit mode output

In **edit mode**, the returned periods are:

> the **complete final legal set of reservation periods per asset for the listed editable users**

This is the key difference.

The calendar guarantees that the output is the **entire final truth state** for the editable users after editing.

So if:

* one period was resized
* one period was deleted
* one new one was added
* everything else stayed untouched

then output still contains:

> **all remaining periods for every listed editable user on every asset**

including unchanged ones.

### Meaning

Your backend should treat edit mode output as:

> **replace the current reservation set for the listed editable users on each asset with this exact returned list**

Reservations belonging to users **not included** in `currentUsers` stay outside the editable output and remain non-editable in the calendar.

---

# Editable users in edit mode

Edit mode supports two input styles:

## Single editable user

```ts
{
  mode: 'edit',
  currentUser: 'Alice',
  assets: [...]
}
```

## Multiple editable users

```ts
{
  mode: 'edit',
  currentUsers: ['Alice', 'Bob'],
  assets: [...]
}
```

Rules:

* all reservations belonging to users in `currentUsers` are editable
* all reservations belonging to other users remain visible but are not editable
* overlap protection is still checked **per asset**
* editable users cannot be moved onto each other or onto blocked reservations from non-editable users

---

# Mode behavior reference

## View

Purpose:

* show availability
* compare multiple assets
* inspect overlaps
* inspect month and week views

Features:

* per-asset colors
* hover details in week and month view
* current day highlight in month view
* visual omission warning if more than 8 assets

---

## Checkout

Purpose:

* select a legal checkout end time
* starts automatically from current hour

Features:

* default 1 hour selection
* resize from visible legal end
* automatic cut around conflicts
* cancel resets to 1 hour
* returns **new legal periods to add per asset**

---

## Reserve

Purpose:

* create one or more future reservations

Features:

* multiple independent reservation chips
* repeat every N weeks
* repeat count
* add new reservation blocks
* automatic conflict cutting
* conflict-safe visual split limiting
* returns **new legal periods to add per asset**

---

## Edit

Purpose:

* modify one or more users’ reservations per asset

Features:

* each asset keeps its own color
* editable users can be one user or many users
* periods of listed editable users are editable
* periods of all other users are visible but not editable
* add periods by activating asset + user, then clicking a time slot
* remove selected period
* resize start and end
* move whole visible periods
* overlap protection is enforced per asset across all reservations
* returns **complete final legal set per editable user per asset**

---

# Safety and readability safeguards

## Asset display limit (`view`, `edit`)

The UI color palette supports 8 strong distinct colors.

Because larger sets become unreadable quickly:

* maximum **8 assets are rendered visually**
* extra assets are listed below the calendar
* the message remains visible while in the view

This keeps the interface readable on desktop and mobile.

---

## Split bar limit (`checkout`, `reserve`)

When selected assets split into too many independent legal bars:

* the system allows selection to continue
* but preview is capped to **8 visible split groups**
* limiting asset groups inherit the most restrictive visible split
* a friendly message appears below the calendar
* the message disappears automatically when selection becomes simpler

This prevents unreadable fragmentation.

---

# Snipe-IT integration recommendation

## Asset list pages

Examples:

* `/hardware`
* `/categories/{id}`

Workflow:

1. User selects assets with checkboxes
2. Selected asset ids are loaded
3. Backend fetches existing reservations
4. Open calendar tab in desired mode
5. Pass selected assets into `CalendarInput`
6. Use output according to mode semantics above

---

## Asset detail page

Single asset detail pages should open the calendar with:

* exactly one asset
* any mode
* full edit support

---

# Development

Run locally:

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

---

# Backend rule summary

## For checkout + reserve

Use output as:

> **new legal periods to append per asset**

## For edit

Use output as:

> **full replacement set per asset for the listed editable users**

That distinction is the key integration rule for Snipe-IT.
