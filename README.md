# Eink Wallpaper

A private, text-free daily artwork for a powered Waveshare ESP32-S3 PhotoPainter. It reads the calendars already connected to macOS Calendar plus Seattle weather, asks an LLM to art-direct the day, generates one bichon-led scene, converts it to the display’s native six-color format, and pushes it over the local network.

No Glanceboard, server, custom firmware, Swift helper, or macOS app is involved. One TypeScript CLI runs from a per-user LaunchAgent at 5:30am.

## What it produces

- One full-bleed 800×480 landscape scene.
- Exactly one character: Mello, matched from local dog-only reference crops and rendered as a white fluffy bichon with a subtle cobalt-blue collar.
- No text, clocks, logos, UI, panels, people, or other creatures.
- A warm, sophisticated animation-inspired language: reduced line density, fluid motion, pastel-futuristic gradients, and dimensional environmental texture.
- Personal events lead; unusual events outrank routine ones; severe weather can override the calendar. Every event remaining after configured calendar-name and title-prefix exclusions enters the creative brief with no intake cap. Anchor eligibility controls what may lead, not what is considered. Related events share explicit visual groups so a busy day becomes a few coherent motifs instead of one prop per meeting. Weightlifting always uses a full plated barbell.
- Every edition is a chapter in one year-long bichon story. The generator reuses prior locations when the day remains there, moves with factual travel context when it does not, carries one or two concrete motifs forward, and records the new narrative beat in that day’s metadata.
- Sunday editions become week tapestries: one coherent scene that retains Sunday’s required cues and folds in a small selection of recognizable event echoes from the preceding Monday through Saturday.
- When an edition exists for the same date one year earlier, the new scene visibly reinterprets one of its motifs rather than copying the old composition.
- Native 16:9 model generation, center-cropped by only 3.125% per side to the display’s 5:3 frame.

Only the exact six-color e-ink result is retained. Each accepted daily image creates one human-viewable PNG, one upload-ready BMP, and one metadata JSON at `editions/YYYY/YYYY-MM-DD.*`. Full-color model output and rejected attempts remain in memory only. Raw calendar payloads exist only in memory during a run.

## Requirements

- macOS with Node.js 22 or later.
- Work and personal accounts visible in macOS Calendar.
- One-time macOS Calendar full-access approval for the read-only EventKit CLI.
- A Vercel AI Gateway key with access to `google/gemini-3.1-flash-image`.
- Current Waveshare factory firmware in Mode 2 STA, continuously USB-powered.
- A DHCP reservation for the PhotoPainter. mDNS is used only as fallback.

## Install

```sh
npm install
npm run build
npm link
```

Build the small local EventKit reader, then configure the reserved display address:

```sh
npm run build:calendar
eink-wallpaper setup \
  --display-host DISPLAY_RESERVED_IP \
  --weather-contact CONTACT_EMAIL_OR_URL \
  --weather-latitude HOME_LATITUDE \
  --weather-longitude HOME_LONGITUDE \
  --exclude-calendars "TEAM_CALENDAR,BIRTHDAYS" \
  --exclude-event-prefixes "HOUSEHOLD_MEMBER" \
  --work-source-matchers "COMPANY_DOMAIN"
```

Store the Gateway key using hidden terminal input:

```sh
eink-wallpaper set-gateway-key
```

Authorize the local Calendar reader once:

```sh
eink-wallpaper authorize local
```

The local reader uses an ad-hoc signature. Rebuilding it changes its macOS privacy identity, so always run `eink-wallpaper authorize local` again after `npm run build:calendar`. Normal TypeScript builds do not affect Calendar authorization. `install-agent` verifies Calendar access before installing the schedule.

EventKit reads recurring instances from the local Calendar store. Calendar names and event-title prefixes in the configured exclusion lists are discarded before normalization. Coordinates, calendar filters, source matchers, the display address, and the NWS contact stay in the untracked local configuration. The Gateway key is stored as a generic password in the login Keychain under `com.phamous.eink-wallpaper`; configuration contains no credentials.

## Prepare the PhotoPainter

1. Update to current factory firmware and synchronize its SD-card assets if the shipped firmware predates STA image uploads.
2. Enter Mode 2 and connect to the default `esp_network` access point.
3. Open `http://192.168.4.1/index.html`, configure STA with the trusted home/IoT Wi-Fi, and restart.
4. Reserve the display’s address in the router and use it during `setup`.
5. Keep the frame powered. Do not port-forward it; factory `/dataUP` is unauthenticated HTTP.

The CLI reproduces Waveshare’s protocol exactly: 800×480, six exact colors, Floyd–Steinberg diffusion, uncompressed bottom-up 24-bit BMP, a leading `0x01` STA byte, and an `application/octet-stream` POST to `/dataUP`.

## First run

Check credentials, calendar access, weather, and the display without generating an image:

```sh
eink-wallpaper doctor
```

Generate a replaceable e-ink candidate without changing the frame:

```sh
eink-wallpaper generate --no-upload
```

Generate and publish:

```sh
eink-wallpaper generate --force
```

Install the daily LaunchAgent only after the manual run succeeds:

```sh
eink-wallpaper install-agent
```

The agent runs while the user is logged in. A calendar interval missed during sleep normally runs after wake; logout, reboot before login, or a closed sleeping laptop can delay the edition.

## Commands

```text
eink-wallpaper status
eink-wallpaper doctor
eink-wallpaper generate [--no-upload] [--force]
eink-wallpaper regenerate [--new-concept] [--no-upload]
eink-wallpaper upload ./display.bmp
eink-wallpaper restore YYYY-MM-DD
eink-wallpaper migrate-storage
eink-wallpaper bakeoff
eink-wallpaper set-image-model google/gemini-3.1-flash-image
eink-wallpaper install-agent
eink-wallpaper kick
eink-wallpaper uninstall-agent
```

`regenerate` retains the day’s chosen concept and story chapter but asks for another composition. `regenerate --new-concept` asks for a different eligible anchor or metaphor while preserving story continuity. Rejected attempts and full-color sources are not retained. Published concepts influence a 30-day novelty ledger; the dated edition manifests themselves provide up to 370 days of story and anniversary memory, with no separate database.

The configured image model defaults to Gemini. A different AI Gateway image slug can be selected explicitly, but do not send private calendar context to a provider unless its Gateway route satisfies the desired ZDR and training policy.

Every model request explicitly requires Gateway `zeroDataRetention` and `disallowPromptTraining` in addition to the team setting. Requests fail closed when no compliant provider route is available.

Mello’s cropped identity references live only under `~/Library/Application Support/Eink Wallpaper/references/mello/`. They are never committed, embedded in the daily archive, or written to logs. The Google image model and visual-QA model receive those dog-only crops through the ZDR Gateway request; the original photos are not used at runtime.

`bakeoff` creates 12 anonymized A/B pairs from synthetic scenarios, so it sends no calendar information to the challenger. Open `index.html` and score the displayed six-color results before inspecting `answers.json`. It generates 24 images and never uploads them to the frame.

## Storage

```text
~/Library/Application Support/Eink Wallpaper/
  config.json
  state.json
  latest.bmp
  latest.png
  editions/YYYY/YYYY-MM-DD.png
  editions/YYYY/YYYY-MM-DD.bmp
  editions/YYYY/YYYY-MM-DD.json
  candidates/YYYY-MM-DD.png
  candidates/YYYY-MM-DD.bmp
  candidates/YYYY-MM-DD.json
  cache/

~/Library/Logs/Eink Wallpaper/
~/Library/LaunchAgents/com.phamous.eink-wallpaper.plist
```

Structured logs retain operational metadata for 30 days. They exclude prompts, event titles, notes, calendar identifiers, secrets, coordinates, and addresses. Weather requests use only the configured coordinates; use rounded coordinates because underlying forecast grids are not parcel-level.

`editions/` is the long-term chronological gallery. A date appears there as soon as its artwork passes visual QA, before delivery, so a temporary display outage cannot leave a hole or discard a paid generation. If upload fails, the next normal run retries that exact BMP. Republishing the same local date atomically replaces that date's three files. `candidates/` holds at most one manually generated, unpublished e-ink candidate per date; publishing it through `restore YYYY-MM-DD` moves it into the dated gallery.

Each edition JSON stores the recurring story location, that day’s narrative beat, carried visual motifs, selected Sunday echoes, and any anniversary reinterpretation. This metadata contains private calendar-derived context and remains local; only operational, title-free fields enter the 30-day logs.

## Failure behavior

- The morning edition is immutable after a successful upload unless manually regenerated.
- NWS is primary; Open-Meteo is forecast fallback. Only NWS supplies official alerts.
- Transient weather and display failures receive bounded retries.
- If data gathering, generation, QA, or upload fails, the existing e-ink image remains untouched.
- Visual QA rejects missing/cropped bichons, long-snouted or unsmiling Mello faces, humanoid weightlifting poses, additional characters, readable text/logos, incorrect fitness props, abstract work geometry, severe anatomy problems, franchise imagery, six-color collapse, and merely adequate art direction. Seven dimensions are scored harshly; every score must reach 9/10. Up to five attempts prioritize the hero read without publishing a weak result.
- A successful upload requires Waveshare’s exact response, a 35-second refresh window, and subsequent server reachability. This verifies delivery, not the physical pixels.
- Scheduled failures produce one local macOS notification. Successes stay quiet.

## Factory firmware references

- [Waveshare PhotoPainter wiki](https://www.waveshare.com/wiki/ESP32-S3-PhotoPainter)
- [Official source and firmware](https://github.com/waveshareteam/ESP32-S3-PhotoPainter)
- [Factory upload server](https://github.com/waveshareteam/ESP32-S3-PhotoPainter/blob/main/01_Example/xiaozhi-esp32/components/app_bsp/server_app.cpp)
- [Factory browser conversion](https://github.com/waveshareteam/ESP32-S3-PhotoPainter/blob/main/02_SDCARD/03_sys_ap_html/script.min.js)

Weather fallback attribution: [Weather data by Open-Meteo.com](https://open-meteo.com/) under CC BY 4.0.
