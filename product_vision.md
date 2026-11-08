# Life Log Club: product vision

**One line:** a personal operating system for growing in every part of life. You practise, you log it, the app helps you remember and reflect, and you can watch yourself grow, one ring at a time.

## The idea

A tree adds one ring every year. Each ring is a log of how that year went. Life Log Club does the same for a person, across four pillars that each grow at their own pace.

The app already has a working loop for the mind: **read → recall → review at growing gaps**. The product grows by applying the same loop to the rest of life:

1. **Do**: a workout, a conversation, an experiment, a career move
2. **Log**: capture it in seconds, by text, voice, photo or a quick form
3. **Reflect**: the AI asks one or two good questions and pulls out the lesson
4. **Recall**: lessons come back on a spaced schedule, so they stick
5. **Grow**: progress shows up as rings, streaks, milestones and a life timeline

## The four pillars

| Pillar | Colour | Covers | Ring meaning |
| --- | --- | --- | --- |
| **Mind** | Indigo `#3B4A8C` | Intelligence, reading, skills, creativity | Ideas learned and remembered |
| **Body** | Coral `#E85D50` | Workouts, sleep, food, health | Training done, health trends |
| **Heart** | Amber `#F0A93B` | People, relationships, emotions, giving back | Time and care given to people, mood |
| **Path** | Green `#2F6E3F` | Career, money, purpose, bucket list, achievements | Goals moved forward |

Logging and tracking (days, experiments, journeys) are not a fifth pillar. They are the engine that runs under all four.

## Mind (built today, then extended)

**Already built:** reading from links, files and the Chrome extension; sections; AI-generated recall checks; brain dump; spaced review after 1, 2 and 3 days, then at growing gaps; vocabulary; focus sessions; daily reminders.

**Next:**

- **Skill tracks:** pick a skill (Rust, chess, public speaking), set a practice goal, and log deliberate-practice sessions with what you worked on and where you struggled (*Peak*)
- **Mental models library:** save ideas as cards that come back in review, linked to the readings they came from
- **Teach-back:** explain a topic in your own words and the AI grades it against the source (builds on the existing tutor and judge)
- **Creativity log:** side projects, drafts, sketches, with a gallery view

## Body

- **Workout log:** exercises, sets, reps, weight, time; templates for your usual routines; one tap to repeat last session
- **Progress:** personal records, volume per week, charts per exercise, progress photos
- **Recovery:** sleep, soreness, energy (1–5), resting heart rate; Apple Health and Google Fit import later
- **Food (light):** meals as photos or one line, not calorie counting by default
- **Health record:** doctor visits, tests, results, symptoms with dates, so you can answer "when did this start?"
- **Embrace it:** a short post-workout note ("how did it feel, what did you learn") that goes into the same reflection loop

## Heart

### People

- **Person profile:** how you met, birthday, family, interests, likes and dislikes, things they told you that matter
- **Interaction log:** what happened, when, where, how you felt, what they did; quick capture right after a call or meeting
- **Personality notes:** traits and patterns you notice over time, with the AI summarising "what you know about Priya" from all your logs
- **Before you meet:** a briefing card: last conversation, open threads, things to ask about, upcoming dates
- **Talk it through:** ask the AI how to approach a hard conversation, using what you've logged about the person
- **Relationship map:** a graph of the people in your life, grouped by circle (family, close friends, work, community), sized by closeness, with "drifting" alerts when you haven't been in touch

This is a personal app, so notes about other people stay private to you. Notes sent to the AI coach go to your own LLM provider with your key; use nicknames if you prefer. If the API ever runs off your own machine, encrypt the people notes the same way the LLM key is encrypted with `ENCRYPTION_KEY`.

### Emotions

- **Daily check-in:** mood and energy in one tap, with an optional note
- **Patterns:** the AI links mood to sleep, workouts, people and work ("your energy is lower after weeks with no exercise")
- **Gratitude and wins:** a few lines at night, resurfaced on hard days

## Path

- **Career:** roles, projects, wins, feedback received, skills used; a "brag document" that writes itself for reviews and job changes
- **Goals:** yearly themes broken into quarterly goals and weekly actions, each linked to a pillar
- **Bucket list:** things to do, see and learn before you die, with categories, target year, and a photo and story when you tick one off
- **Achievements:** a trophy shelf of milestones from all four pillars
- **Parallel journeys:** several long-running journeys side by side (learning Japanese, training for a marathon, building a startup), each with its own timeline, so you can see how they overlap
- **Money (light):** money decisions and the lessons from them, plus savings goals; not a full budgeting app
- **Values:** write down your principles once, then check weekly reviews against them

## The engine (shared by every pillar)

- **Universal log entry:** one capture screen for anything: text, voice note, photo, link, or a structured form per type. Every entry has a time, a pillar, optional people and optional journey.
- **Day log:** a journal view of each day, built from everything you logged, plus a short "how was today" note
- **Experiments:** "For 30 days I'll sleep by 11pm." A hypothesis, a measure, a daily check-off, and a conclusion at the end that becomes a lesson
- **Lessons and spaced recall:** any entry can produce a lesson. Lessons go into the same review scheduler as reading (`packages/core`), so life lessons come back like flashcards
- **AI coach:** uses your own key (`packages/llm`). Asks reflection questions, summarises weeks, spots patterns across pillars, answers "what did I learn about X?"
- **Search and timeline:** one timeline of your whole life, filterable by pillar, person and journey; full-text and AI search over everything
- **Reviews:** weekly (10 minutes), monthly and yearly. The yearly review draws your new ring.

## Signature screens

- **Today:** due reviews, today's check-in, planned workout, people to reach out to, active experiments
- **Life rings:** a live chart. Each quadrant is a pillar; each ring is a month or year; thickness shows how much you invested. Tap a ring to open that period.
- **Balance wheel:** a score from 1 to 10 for each pillar, updated in the weekly review, so neglected areas stand out
- **People map:** the relationship graph
- **Journeys:** parallel timelines side by side

## Brand

- **Feeling:** the logo should build trust, connectedness, growth and confidence.
- **Mark:** a swallow in American traditional tattoo style, climbing to the upper right (`apps/mobile/assets/logo.png`). Sailors earned a swallow for every 5,000 nautical miles, and swallows return to the same nest every year: proof of the miles you have lived, and a promise to come home. Its four tips (two wingtips, two tail points) are the four pillars.
- **Brand colours:** navy `#1F2A4A`, cream `#F2E8D5`, red `#C8372D`, black `#141414`. The app icon, splash and Android icon background use the cream.
- **Colour:** each pillar has its own colour, used across the app (tabs, charts, tags). The app UI stays black and white; colour marks the pillars only.
- **Monochrome version:** needed for the favicon, the Android monochrome icon and dark mode.
- **Voice:** calm, honest, a little warm. A training partner, not a cheerleader.

## Roadmap

| Phase | Focus | Builds on |
| --- | --- | --- |
| **1. Foundation** | Universal log entry, pillar tags, day log, Today screen showing all pillars, new logo and icons | Existing auth, API, theme |
| **2. Body** | Workout log, templates, progress charts, recovery check-in | Focus sessions, reminders |
| **3. Heart** | People profiles, interaction log, before-you-meet card, mood check-in | LLM tutor for "talk it through" |
| **4. Engine** | Lessons from any entry into spaced review, experiments, weekly review | Review scheduler in `packages/core` |
| **5. Path** | Goals, bucket list, achievements, parallel journeys, career log | Engine from phase 4 |
| **6. Insight** | Life rings, balance wheel, people map, AI cross-pillar patterns, yearly review | Data from all phases |

## Open questions

- [ ] Rename the app, or keep "Life Log Club"? "Club" suits a future group mode; for a personal app, "Life Log" alone also works.
- [ ] Mobile-first only, or a web dashboard for the bigger views (people map, life rings)?
- [ ] Import from other apps (Apple Health, Strava, Goodreads, Google Calendar)? Which first?
- [ ] Voice capture: transcribe on the phone or through the LLM key?
- [x] Which logo? The swallow.
- [ ] Redraw the swallow as a vector (SVG) and make a simplified mark for 16 px favicons.
