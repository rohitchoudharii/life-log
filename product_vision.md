# Life Log Club: product vision

**One line:** Life Log Club makes sure you don't forget what life teaches you, and lets you look back at how far you've come.

Versions and order of work are decided later. This document describes the whole product.

## Who it's for

- Me first, then a small circle of close friends and family, by invite only.
- It is not a public app. Nobody can reach it until I decide to roll it out.
- Each person's log is private to them. Members don't share anything with each other for now.

## Principles

- **Simple:** logging or reading anything takes one or two clicks. Typing a value or a note doesn't count as a click.
- **Smart defaults:** the app fills in what it can (last workout's numbers, today's date, the person you logged last), so most logs are just Save.
- **One Log button:** a **+ Log** button on every screen, and a keyboard shortcut, open quick capture.
- **Not tied to a schedule:** the app does not assume a daily routine or fixed times. It works whenever I open it.

## Learning and doing

Learning and doing matter most, so they sit at the heart of the app.

- **Learning** is reading: books, articles and pages, split into sections.
- **Doing** is recall: after reading, you work to bring back what you read, then review it at growing gaps. Recall is what turns reading into understanding.
- **Later, doing grows into projects:** milestones and goal planning for the projects in life that help me grow, in the style of *Getting Things Done* (see Path).

## The idea

A tree adds one ring every year. Each ring is a log of how that year went. Life Log Club does the same for a person, across four pillars that each grow at their own pace.

## The loop

1. **Capture:** add one entry in a few seconds, as text, a photo, a link, or a short form.
2. **Reflect:** the AI asks one good question and pulls out what matters.
3. **Keep:** the app does one or more of three things with the entry (below).
4. **Grow:** progress shows up as records, milestones and a history per pillar.

### Three things the app does with an entry

| | What it is | Examples | What the app does |
| --- | --- | --- | --- |
| **Remember** | Lessons and ideas | A concept from a book, a lesson from a hard conversation | Brings it back on a spaced schedule until it sticks |
| **Relive** | Moments worth keeping | A trip, an achievement, a personal record, a good evening with friends | Brings it back when you look back, on this day, and on hard days |
| **Track** | Numbers over time | Sets and weight, protein, sleep, reading time | Shows progress, records and trends |

Remember keeps the mind sharp. Relive and Track keep motivation alive: when you are down, seeing the gym log, past achievements and past trips reminds you what you have already done.

## Screens

### Design direction: Pillar worlds

Chosen from five design iterations. Each pillar is its own world with its own character, because each is a different part of life:

- **Mind, the reading room:** warm cream paper, serif type for reading, a focused reader with recall built in, index-card review.
- **Body, the training log:** dark, bold numbers, a set-by-set logger with steppers for weight and reps, a rest timer after each set, one-click meals.
- **Heart, the journal:** warm cards for people, the last person already picked so a meeting is one line plus Save, a "before you meet" note, mood in one click.
- **Home, the swallow's hub:** one card per pillar that previews its world and grows into it when clicked.

The shared chrome stays the same everywhere, so it is still one app: the navy sidebar (a bottom tab bar on phone), the red **+ Log** button, search, and the shortcuts (L to log, / to search, 1 to 4 to switch worlds).

Trade-off to manage: three visual styles cost more to build and keep consistent, so they share one set of components and tokens, and each world only changes colours, type and the main layout.

### Home

An overview of all four pillars on one screen. Each pillar shows a short summary of where it stands (for example ideas due for review, the last workout, the last person logged) and opens its own dashboard in one click.

### Pillar dashboards

Each pillar has its own dashboard, designed for what that part of life needs. The dashboards do not share one layout. The operation I use most in each pillar gets the most prominent place.

| Pillar | Main operations |
| --- | --- |
| **Mind** | Reading and recall |
| **Body** | Workout and meal |
| **Heart** | Person log |
| **Path** | Deferred |

## Operations

Each operation lists how many clicks it takes.

### Mind

| Operation | Clicks | Example |
| --- | --- | --- |
| Add a reading | 1 | Paste a link or drop a file, then click Add |
| Continue a reading | 1 | Click the book; it opens where I stopped |
| Recall after a section | 1 | Click Recall, write what I remember, then answer the questions |
| Review due ideas | 1 | Click Review and answer each idea |
| Save an idea | 2 | Select text, then click Save idea |
| Finish a book | 1 | Click Finished |

### Body

| Operation | Clicks | Example |
| --- | --- | --- |
| Log a workout | 1 | Click Repeat last workout, change one weight, save |
| Log one set | 1 | Bench 80 kg × 8, then Add |
| Log protein or a meal | 1 | Click "Shake 30 g" |
| Log sleep or body weight | 1 | Type the value, then Save |
| See records | 1 | Click an exercise to see its records and chart |

### Heart

| Operation | Clicks | Example |
| --- | --- | --- |
| Log a meeting with a person | 2 | Pick the person, write one line, Save |
| Add a person | 2 | Type a name and details, Save |
| Log a moment | 2 | Add a photo and one line, Save |
| Mood check-in | 1 | Click one of five faces |

### Path

Deferred. We decide its operations later.

### Across all pillars

- Edit or delete an entry
- Search all entries
- Look back: history and records per pillar
- Sign in, manage devices, settings

## Looking back for motivation

On hard days, the app shows proof of what I have already done:

- Personal records and how far the gym numbers have come
- Past achievements and milestones, including books finished
- Past trips and good moments, with photos
- What happened on this day in earlier years
- Wins and lessons I wrote on earlier hard days

## The four pillars

| Pillar | Colour | Covers | Ring meaning |
| --- | --- | --- | --- |
| **Mind** | Indigo `#3B4A8C` | Reading, concepts, skills, creativity | Ideas learned and remembered |
| **Body** | Coral `#E85D50` | Gym, sleep, food, health | Training done, health trends |
| **Heart** | Amber `#F0A93B` | People, relationships, emotions, moments | Time and care given to people, mood |
| **Path** | Green `#2F6E3F` | Work, money, purpose, trips, bucket list, achievements | Goals moved forward |

Every entry belongs to a pillar. The engine below runs under all four.

### Mind

- **Reader:** import links and files (later, the Chrome extension); split into sections
- **Books as goals and milestones:** a book I plan to read can be a goal ("finish *Peak* by March"), and finishing a book is a milestone, with the key lessons from it
- **Recall check:** after a section, write what you remember (brain dump), then answer AI-written questions
- **Spaced review:** ideas come back after 1, 2 and 3 days, then at growing gaps
- **Vocabulary:** new words come back the same way
- **Teach-back:** explain a topic in your own words; the AI checks it against the source
- **Mental models:** save ideas as cards, linked to the readings they came from
- **Skills:** pick a skill, set a practice goal, log deliberate-practice sessions (*Peak*)

### Body

- **Gym log:** exercises, sets, reps, weight, time; templates; repeat last session
- **Progress:** personal records, weekly volume, charts per exercise, progress photos
- **Food (light):** protein and meals in one tap or one line; no calorie counting by default
- **Sleep and rest:** bedtime, wake time, naps, energy (1 to 5)
- **Health record:** doctor visits, tests, results and symptoms with dates

### Heart

- **People:** a profile per person (how you met, birthday, interests, things that matter to them)
- **Interactions:** quick capture after meeting someone; "before you meet" card with the last conversation and open threads
- **Mood check-in:** mood and energy in one tap, with an optional note
- **Moments:** evenings out, the sky, small good things, with a photo
- **Wins and gratitude:** a few lines, resurfaced on hard days

### Path (deferred)

Path's operations are not decided yet. These ideas stay as notes:

- **Work productivity:** do things faster, reduce friction, and learn better at work
- **Projects and milestones (*Getting Things Done* style):** one inbox for open loops; projects across life with milestones and a clear next action; a weekly review
- **Goals:** yearly themes, quarterly goals, weekly actions
- **Trips:** places, dates, photos and stories
- **Bucket list:** things to do, see and learn, with a photo and story when ticked off
- **Achievements:** milestones from all four pillars
- **Money (light):** money decisions and the lessons from them; savings goals

## Later: context shared between pillars

In future, pillars will share context. For example, a finished book (Mind) becomes a milestone or achievement (Path), and a person (Heart) can appear on a moment or a trip. We don't design this yet, but the data model should not block it.

## The engine

- **Entry:** one data model for everything logged. Every entry has a time, a pillar, and optional people and photos.
- **Lessons and spaced recall:** any entry can produce a lesson; lessons share one review scheduler with reading.
- **Look back:** history, records, on this day, and the motivation view above.
- **AI coach:** uses my own LLM key. Asks reflection questions, summarises weeks, spots patterns.
- **Search:** across all entries, filterable by pillar and person.

## Platforms

1. **Web app first**, served from my own server. Over time I want to use the phone less and the web more.
2. **Phone app second**, for what a browser can't do well: an alarm (planned later), reliable notifications, quick capture on the go, and health data import.
3. **Chrome extension** for capturing pages, using the same server.

## Security and access

Goal: as hard to get into as a banking app, but it never signs me out in the middle of reading, a test, or anything else.

### Now (base frame)

- **Allowed emails only:** only email addresses on an allowlist can create an account or sign in. Everyone else sees the same "can't sign in" message, so the app doesn't reveal who is on the list.
- **Basic login:** email and password. Passwords are stored only as strong hashes (argon2id). Repeated failed attempts are slowed down and then locked for a while.
- **No private network:** Tailscale is out, because members shouldn't have to install anything. The site is reachable on the internet, and the login is the gate.
- **Stays signed in:** the session lasts a long time and renews while in use. No idle timeout. After 30 days away from a device, it asks for the password again.
- **Remote sign-out:** a list of signed-in devices, with sign-out for a lost one.
- **Data protection:** HTTPS only; encrypted at rest; private fields (people notes, LLM keys) encrypted again with an app key; regular backups; a log of every sign-in.

### Later (once there is a domain)

- **Passkeys:** sign in with Face ID, Touch ID or a security key, with backup codes. Passkeys are tied to a domain, so they wait until the domain is fixed.
- **Trusted devices:** a new browser or device must be approved from a device that is already trusted, with an alert.
- **Hidden until rollout:** an access proxy in front of the site (for example Cloudflare Access with an email allowlist), so strangers can't even reach the sign-in page. Members don't install anything.

## How we build it

Base frame first, then small incremental releases (agile). Each release adds one feature on top of the frame and is usable on its own.

The base frame runs on my own computer first. Hosting is decided in a later step.

The base frame is what every later feature stands on:

- **Server, database and web app shell**
- **Security and access:** allowed-emails-only login with email and password, long sessions with the 30-day re-check, remote sign-out
- **The entry:** one data model for everything logged
- **The review scheduler:** one spaced schedule shared by reading ideas and life lessons
- **Home and pillar dashboards:** the overview and an empty dashboard per pillar, ready for features
- **Brand and theme:** logo, colours, pillar colours, type

## Technical approach

Chosen from four plans: **API plus clients**. One typed API service owns all data, login and background work. The web app, and later the phone app and the Chrome extension, are separate clients that talk to it only through a shared API contract.

- **Language:** TypeScript everywhere.
- **API:** Node.js with Hono and oRPC (a typed contract shared by every client).
- **Web app:** React single-page app built with Vite; TanStack Router and TanStack Query for instant, optimistic updates with undo.
- **Design:** Tailwind CSS with shared design tokens; each Pillar world switches its own colours and type.
- **Data:** Postgres with Drizzle; background jobs in Postgres with pg-boss.
- **Reused from the old app:** the review scheduler, page extraction, PDF and EPUB import, and the AI prompts, with their tests.
- **Later:** an Expo phone app and a WXT Chrome extension, using the same API contract.
- **Monitoring:** no extra tools in the base frame. Use the hosting platform's logs and a free uptime check; add SigNoz or PostHog only if a real need appears.

## Brand

- **Feeling:** the logo should build trust, connectedness, growth and confidence.
- **Mark:** a swallow in American traditional tattoo style, climbing to the upper right (`apps/mobile/assets/logo.png`). Sailors earned a swallow for every 5,000 nautical miles, and swallows return to the same nest every year: proof of the miles you have lived, and a promise to come home. Its four tips (two wingtips, two tail points) are the four pillars.
- **Brand colours:** navy `#1F2A4A`, cream `#F2E8D5`, red `#C8372D`, black `#141414`. The app icon, splash and Android icon background use the cream.
- **Colour:** each pillar has its own colour, used across the app (tabs, charts, tags). The app UI stays black and white; colour marks the pillars only.
- **Monochrome version:** needed for the favicon, the Android monochrome icon and dark mode.
- **Voice:** calm, honest, a little warm. A training partner, not a cheerleader.

## Open questions

- [x] Can members of the club share anything with each other? Not for now; everything is private.
- [x] Should a trusted device ask for a passkey again after a long time away? Yes, after 30 days away.
- [ ] Plan the alarm feature for the phone app.
- [x] What should work productivity cover? Doing things faster, reducing friction, and learning better.
- [x] Voice capture? Yes, but later, not in the base frame. Uses: a gym note between sets, a note while walking after meeting someone, a spoken brain dump after reading, teach-back out loud.
- [x] Import from other apps? Not planned. Capture pages with the web extension for now; explore imports later.
- [x] Keep the name "Life Log Club"? Yes.
- [x] A simplified swallow for very small sizes? Yes. Redraw the swallow as SVG, plus a simpler SVG mark for the 16 px browser tab icon, where the detailed swallow blurs into a smudge.
- [x] Versions? Design the base frame first, then release in small increments.
- [x] Signature screens? Replaced by a Home overview and one dashboard per pillar, each with its own design.
- [x] Design direction? Pillar worlds (iteration 5 of 5).
- [ ] Path: which operations does it have?
- [ ] Home: what exactly does each pillar's summary show?
- [x] Technical approach? API plus clients (approach 2 of 4).
- [x] Tailscale? No; members shouldn't install anything.
- [x] Passkeys now? No. Email and password for allowed emails only; passkeys once there is a domain.
- [x] SigNoz and PostHog? Not in the base frame.
- [x] Login type? Email and password (not emailed codes).
- [ ] Hosting (deferred to a later step; the base frame runs on my computer first): AWS or self-hosted. Options: AWS Lightsail managed (containers + managed Postgres, about $41/month, least upkeep), one AWS Lightsail server I maintain (about $13/month), or a computer at home.
- [ ] Domain: buy one now, or use the hosting platform's free address until later?
