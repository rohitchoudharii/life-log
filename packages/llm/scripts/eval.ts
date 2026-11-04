/**
 * Writes questions for fixed sample texts with a real key and prints them with their levels and
 * every rule the model broke, so prompt versions can be compared on the same input.
 *
 *   PEAK_PROVIDER=anthropic PEAK_MODEL=claude-… PEAK_API_KEY=… pnpm --filter @peak/llm eval [--intensity thorough] [--style mixed] [--budget 4000] [files…]
 *
 * --budget lowers the reply budget so even a short text takes several calls, which exercises the linking pass.
 */
import { parseMarkdown, QUESTION_INTENSITIES, QUESTION_STYLES, sectionText, splitSections, type QuestionIntensity, type QuestionStyle } from '@peak/core'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { isProviderId, linkSections, planBatches, providers, writeQuestions, type GeneratedQuestion, type OnRejected } from '../src'

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { intensity: { type: 'string', default: 'standard' }, style: { type: 'string', default: 'mixed' }, budget: { type: 'string' } },
})
const intensity = values.intensity as QuestionIntensity
const style = values.style as QuestionStyle
if (!QUESTION_INTENSITIES.includes(intensity) || !QUESTION_STYLES.includes(style)) throw new Error('Bad --intensity or --style')
const providerId = process.env.PEAK_PROVIDER ?? 'anthropic'
const model = process.env.PEAK_MODEL
const apiKey = process.env.PEAK_API_KEY
if (!isProviderId(providerId) || !model || !apiKey) throw new Error('Set PEAK_PROVIDER, PEAK_MODEL, and PEAK_API_KEY')
const provider = providers[providerId]
const budget = values.budget ? Number(values.budget) : undefined

const dir = join(import.meta.dirname, 'fixtures')
const files = positionals.length ? positionals : readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f))

const totals = { questions: 0, aboveRecall: 0, mcq: 0, firstRejected: 0, dropped: 0, calls: 0 }
const reasons = new Map<string, number>()
const onRejected: OnRejected = (stage, rejected) => {
	if (stage === 'first') totals.firstRejected += rejected.length
	else totals.dropped += rejected.length
	for (const r of rejected) {
		console.log(`  ${stage === 'first' ? 'rejected' : 'DROPPED '}: ${r.prompt}\n            ${r.reasons.join('; ')}`)
		for (const why of r.reasons) {
			const key = why.replace(/"[^"]*"/g, '"…"').replace(/\d+/g, 'N')
			reasons.set(key, (reasons.get(key) ?? 0) + 1)
		}
	}
}

const print = (q: GeneratedQuestion, titles: string[]) => {
	const c = q.content as { prompt: string; mustHave?: string[]; options?: string[]; answerIndex?: number }
	const where = [...q.alsoSections, q.section].map((i) => titles[i]).join(' + ')
	console.log(`\n  [${q.level} · ${q.type}] ${where}\n  ${c.prompt}`)
	for (const p of c.mustHave ?? []) console.log(`    • ${p}`)
	c.options?.forEach((o, i) => console.log(`    ${i === c.answerIndex ? '✓' : ' '} ${o}`))
	totals.questions++
	if (q.level !== 'recall') totals.aboveRecall++
	if (q.type === 'mcq') totals.mcq++
}

for (const file of files) {
	const sections = splitSections(parseMarkdown(readFileSync(file, 'utf8')), basename(file, '.md'))
	const inputs = sections.map((s) => ({ title: s.title, level: s.level, wordCount: s.wordCount, text: sectionText(s) }))
	const batches = planBatches(inputs, intensity, budget)
	console.log(`\n=== ${basename(file)}: ${sections.length} sections in ${batches.length} call(s), ${intensity}, ${style}`)
	const ideas: string[][] = sections.map(() => [])
	for (const batch of batches) {
		const out = await writeQuestions(provider, apiKey, model, inputs, batch, { intensity, style }, onRejected)
		totals.calls++
		for (const [i, list] of out.ideas) ideas[i] = list
		out.questions.forEach((q) => print(q, inputs.map((s) => s.title)))
	}
	if (batches.length > 1) {
		console.log('\n  -- linking pass')
		const links = await linkSections(provider, apiKey, model, inputs.map((s, i) => ({ title: s.title, ideas: ideas[i]! })), { intensity, style }, onRejected)
		totals.calls++
		links.forEach((q) => print(q, inputs.map((s) => s.title)))
	}
}

const pct = (n: number) => `${totals.questions ? Math.round((n / totals.questions) * 100) : 0}%`
console.log(`\n=== Summary
questions kept: ${totals.questions}
above recall:   ${pct(totals.aboveRecall)} (rule: at least 60%)
multiple choice: ${pct(totals.mcq)}
rejected on first try: ${totals.firstRejected}, dropped after rewrite: ${totals.dropped}
batch and linking calls: ${totals.calls} (rewrites not counted)
most common problems:`)
for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${n}× ${why}`)
