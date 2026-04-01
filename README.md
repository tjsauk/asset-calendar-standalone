# Asset Calendar Standalone

A standalone React calendar component for asset reservation, checkout, and view flows.

## Quick start

```bash
npm install
npm run dev
```

Open the local Vite URL.

## Input contract

```ts
{
  mode: 'view' | 'reserve' | 'checkout';
  currentUser: string;
  continuousCutMode?: boolean;
  assets: {
    id: string;
    name: string;
    existingPeriods: {
      start: string;   // YYYY-MM-DD HH:MM
      end: string;     // YYYY-MM-DD HH:MM
      userName: string;
    }[];
  }[];
}
```

## Output contract

```ts
{
  assets: {
    id: string;
    name: string;
    selectedPeriods: {
      start: string;
      end: string;
    }[];
  }[];
}
```

## Snipe-IT integration in simple steps

1. Add a page or tab with `<div id="asset-calendar-root"></div>`.
2. Build one JSON payload in Blade and assign it to `window.assetCalendarInput`.
3. Load the built calendar script.
4. On confirm, send the output JSON to Laravel.
5. Validate conflicts again on the backend before saving.

## Example mounting

```html
<div id="asset-calendar-root"></div>
<script>
  window.assetCalendarInput = {
    mode: 'reserve',
    currentUser: 'General kenobi',
    continuousCutMode: true,
    assets: []
  };

  window.assetCalendarOnConfirm = function (output) {
    console.log(output);
  };
</script>
```

## GitHub upload steps

### 1. Create a new repository on GitHub
Create an empty repo, for example `asset-calendar-standalone`.

### 2. Put these files in a local folder
Unzip this package.

### 3. Open terminal in that folder
Run:

```bash
git init
git add .
git commit -m "Initial standalone asset calendar"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/asset-calendar-standalone.git
git push -u origin main
```

### 4. Install and test locally
Run:

```bash
npm install
npm run dev
```

### 5. Later integration into Snipe-IT
Use the `CalendarInput` JSON shape to feed selected assets and existing reservations into the calendar.
