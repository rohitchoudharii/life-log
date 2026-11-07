/**
 * Writes questions for fixed sample texts with a real key and prints them with their levels and
 * every rule the model broke, so prompt versions can be compared on the same input.
 *
 *   LIFE_LOG_CLUB_PROVIDER=anthropic LIFE_LOG_CLUB_MODEL=claude-… LIFE_LOG_CLUB_API_KEY=… pnpm --filter @life-log-club/llm eval [--intensity thorough] [--style mixed] [--budget 4000] [--skip-check] [files…]
 *
 * --budget lowers the reply budget so even a short text takes several calls, which exercises the linking pass.
 * --skip-check turns off the second-pass quality check, which is on by default as in the app.
 */
import { parseMarkdown, QUESTION_INTENSITIES, QUESTION_STYLES, sectionText, splitSections, type QuestionIntensity, type QuestionStyle } from '@life-log-club/core'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { isProviderId, linkSections, planBatches, providers, writeQuestions, type GeneratedQuestion, type OnRejected } from '../src'

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { intensity: { type: 'string', default: 'standard' }, style: { type: 'string', default: 'mixed' }, budget: { type: 'string' }, 'skip-check': { type: 'boolean', default: false } },
})
const intensity = values.intensity as QuestionIntensity
const style = values.style as QuestionStyle
if (!QUESTION_INTENSITIES.includes(intensity) || !QUESTION_STYLES.includes(style)) throw new Error('Bad --intensity or --style')
const providerId = process.env.LIFE_LOG_CLUB_PROVIDER ?? 'anthropic'
const model = process.env.LIFE_LOG_CLUB_MODEL
const apiKey = process.env.LIFE_LOG_CLUB_API_KEY
if (!isProviderId(providerId) || !model || !apiKey) throw new Error('Set LIFE_LOG_CLUB_PROVIDER, LIFE_LOG_CLUB_MODEL, and LIFE_LOG_CLUB_API_KEY')
const provider = providers[providerId]
const budget = values.budget ? Number(values.budget) : undefined
const prefs = { intensity, style, qualityCheck: !values['skip-check'] }

const dir = join(import.meta.dirname, 'fixtures')
const files = positionals.length ? positionals : readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f))

const totals = { questions: 0, aboveRecall: 0, firstRejected: 0, checkRejected: 0, dropped: 0, calls: 0 }
const types = new Map<string, number>()
const reasons = new Map<string, number>()
const onRejected: OnRejected = (stage, rejected) => {
	if (stage === 'first') totals.firstRejected += rejected.length
	else if (stage === 'checked') totals.checkRejected += rejected.length
	else totals.dropped += rejected.length
	for (const r of rejected) {
		console.log(`  ${stage === 'first' ? 'rejected' : stage === 'checked' ? 'CHECKED ' : 'DROPPED '}: ${r.prompt}\n            ${r.reasons.join('; ')}`)
		for (const why of r.reasons) {
			const key = why.replace(/"[^"]*"/g, '"…"').replace(/\d+/g, 'N')
			reasons.set(key, (reasons.get(key) ?? 0) + 1)
		}
	}
}

const print = (q: GeneratedQuestion, titles: string[]) => {
	const c = q.content as {
		prompt: string
		code?: string
		mustHave?: string[]
		options?: string[]
		answerIndex?: number
		answer?: number
		unit?: string
		tolerance?: number
		steps?: string[]
		output?: string
		solution?: string
	}
	const where = [...q.alsoSections, q.section].map((i) => titles[i]).join(' + ')
	const indent = (text: string) => text.replace(/^/gm, '      ')
	console.log(`\n  [${q.level} · ${q.type}] ${where}\n  ${c.prompt}`)
	if (c.code) console.log(`    code:\n${indent(c.code)}`)
	for (const p of c.mustHave ?? []) console.log(`    • ${p}`)
	c.options?.forEach((o, i) => console.log(`    ${i === c.answerIndex ? '✓' : ' '} ${o}`))
	if (q.type === 'worked_problem') console.log(`    = ${c.answer} ${c.unit ?? ''} (± ${c.tolerance})\n    solution: ${c.solution}`)
	if (q.type === 'order_steps') c.steps?.forEach((x, i) => console.log(`    ${i + 1}. ${x}`))
	if (q.type === 'predict_output') console.log(`    prints:\n${indent(c.output ?? '')}`)
	totals.questions++
	if (q.level !== 'recall') totals.aboveRecall++
	types.set(q.type, (types.get(q.type) ?? 0) + 1)
}

for (const file of files) {
	const sections = splitSections(parseMarkdown(readFileSync(file, 'utf8')), basename(file, '.md'))
	const inputs = sections.map((s) => ({ title: s.title, level: s.level, wordCount: s.wordCount, text: sectionText(s) }))
	const batches = planBatches(inputs, intensity, budget)
	console.log(`\n=== ${basename(file)}: ${sections.length} sections in ${batches.length} call(s), ${intensity}, ${style}`)
	const ideas: string[][] = sections.map(() => [])
	for (const batch of batches) {
		const out = await writeQuestions(provider, apiKey, model, inputs, batch, prefs, onRejected)
		totals.calls++
		for (const [i, list] of out.ideas) ideas[i] = list
		out.questions.forEach((q) => print(q, inputs.map((s) => s.title)))
	}
	if (batches.length > 1) {
		console.log('\n  -- linking pass')
		const links = await linkSections(provider, apiKey, model, inputs.map((s, i) => ({ title: s.title, ideas: ideas[i]! })), prefs, onRejected)
		totals.calls++
		links.forEach((q) => print(q, inputs.map((s) => s.title)))
	}
}

const pct = (n: number) => `${totals.questions ? Math.round((n / totals.questions) * 100) : 0}%`
console.log(`\n=== Summary
questions kept: ${totals.questions}
above recall:   ${pct(totals.aboveRecall)} (rule: at least 60%)
types:          ${[...types].map(([t, n]) => `${t} ${pct(n)}`).join(', ')}
rejected on first try: ${totals.firstRejected}, by the quality check: ${totals.checkRejected}, dropped after rewrite: ${totals.dropped}
batch and linking calls: ${totals.calls} (rewrites not counted)
most common problems:`)
for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${n}× ${why}`)
