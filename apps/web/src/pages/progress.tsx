import type { ProgressSummary } from '@life-log-club/contract'
import { calibrationLine, type GapBucket, RECALL_MIN_REVIEWS } from '@life-log-club/domain'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { orpc } from '../rpc'

const DAYS = 84
const percent = (right: number, total: number) => `${Math.round((right / total) * 100)}%`
const GAP_LABELS: Record<GapBucket, string> = {
	'1d': '1 day',
	'2d': '2 days',
	'3d': '3 days',
	month: '4 days to 4 weeks',
	quarter: '1 to 3 months',
	longer: 'Over 3 months',
}
const STATUS_LABELS = [
	['new', 'New', 'Not started yet'],
	['learning', 'Learning', 'In the 1, 2 and 3 day steps'],
	['known', 'Known', 'Likely recalled now (85% or more)'],
	['fading', 'Fading', 'Less likely recalled now'],
] as const

function Block({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
	const id = `progress-${title.toLowerCase().replace(/\W+/g, '-')}`
	return (
		<section aria-labelledby={id} className="grid gap-3 rounded-2xl border border-world-line bg-world-card p-5">
			<div>
				<h2 id={id} className="text-xl">
					{title}
				</h2>
				<p className="font-sans text-sm text-world-muted">{sub}</p>
			</div>
			{children}
		</section>
	)
}

/** A rate that rests on fewer than 20 answers is shown as a count, not a percentage. */
function Rate({ right, total, testId }: { right: number; total: number; testId?: string }) {
	if (total < RECALL_MIN_REVIEWS)
		return (
			<p className="font-sans text-sm text-world-muted" data-testid={testId}>
				Not enough reviews yet ({total} of {RECALL_MIN_REVIEWS})
			</p>
		)
	return (
		<p className="text-3xl font-semibold" data-testid={testId}>
			{percent(right, total)} <span className="font-sans text-sm font-normal text-world-muted">of {total} right</span>
		</p>
	)
}

/** A bar from 0 to 100%, with the member's target as a mark when given. */
function Bar({ right, total, target }: { right: number; total: number; target?: number }) {
	return (
		<div className="relative h-2.5 w-full overflow-hidden rounded-full bg-world-line" aria-hidden>
			<div className="h-full rounded-full bg-world-accent" style={{ width: total ? `${(right / total) * 100}%` : 0 }} />
			{target !== undefined && <div className="absolute inset-y-0 w-0.5 bg-red" style={{ left: `${target * 100}%` }} />}
		</div>
	)
}

function Ideas({ ideas }: { ideas: ProgressSummary['ideas'] }) {
	return (
		<Block title="Ideas" sub="Every idea and lesson, by how well you hold it now.">
			<dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
				{STATUS_LABELS.map(([key, label, hint]) => (
					<div key={key} className="rounded-xl border border-world-line p-3">
						<dt className="font-sans text-xs font-medium tracking-wide text-world-muted uppercase">{label}</dt>
						<dd className="text-3xl font-semibold" data-testid={`ideas-${key}`}>
							{ideas.total[key]}
						</dd>
						<dd className="font-sans text-xs text-world-muted">{hint}</dd>
					</div>
				))}
			</dl>
			{ideas.readings.length > 0 && (
				<table className="w-full font-sans text-sm">
					<thead className="text-left text-xs text-world-muted">
						<tr>
							<th className="py-1 font-medium">Reading</th>
							{STATUS_LABELS.map(([key, label]) => (
								<th key={key} className="py-1 text-right font-medium">
									{label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{ideas.readings.map((r) => (
							<tr key={r.readingId} className="border-t border-world-line">
								<td className="py-1.5 pr-2">{r.title}</td>
								{STATUS_LABELS.map(([key]) => (
									<td key={key} className="py-1.5 text-right tabular-nums">
										{r.counts[key]}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			)}
		</Block>
	)
}

function RecallAtReview({ recall }: { recall: ProgressSummary['recallAtReview'] }) {
	const weekLabel = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
	return (
		<Block
			title="Recall at review"
			sub={`Ideas past the steps, the first answer of the day in Review, last ${DAYS / 7} weeks. Your target is ${Math.round(recall.target * 100)}%.`}
		>
			<Rate right={recall.right} total={recall.total} testId="recall-at-review" />
			{recall.total >= RECALL_MIN_REVIEWS && (
				<ul className="grid gap-2 font-sans text-sm">
					{recall.weeks.map((w) => (
						<li key={w.week.toISOString()} className="grid grid-cols-[6rem_1fr_6rem] items-center gap-3">
							<span className="text-world-muted">Week of {weekLabel(w.week)}</span>
							<Bar right={w.right} total={w.total} target={recall.target} />
							<span className="text-right tabular-nums">
								{percent(w.right, w.total)} · {w.total}
							</span>
						</li>
					))}
				</ul>
			)}
		</Block>
	)
}

function RecallByGap({ gaps }: { gaps: ProgressSummary['recallByGap'] }) {
	return (
		<Block title="Recall by gap" sub="Answers in Review, by the time since you last recalled the idea.">
			<ul className="grid gap-2 font-sans text-sm" data-testid="recall-by-gap">
				{gaps.map((g) => (
					<li key={g.gap} className="grid grid-cols-[8rem_1fr_7rem] items-center gap-3">
						<span className="text-world-muted">{GAP_LABELS[g.gap]}</span>
						<Bar right={g.right} total={g.total} />
						<span className="text-right tabular-nums">{g.total ? `${g.right} of ${g.total} right` : 'None yet'}</span>
					</li>
				))}
			</ul>
		</Block>
	)
}

function Dumps({ dumps }: { dumps: ProgressSummary['dumps'] }) {
	const day = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
	return (
		<Block title="Brain dumps" sub="How many key ideas each dump after reading covered.">
			{dumps.length ? (
				<ul className="grid gap-2 font-sans text-sm" data-testid="dumps">
					{dumps.map((d) => (
						<li key={d.attemptId} className="grid grid-cols-[1fr_8rem] items-center gap-3 md:grid-cols-[14rem_1fr_8rem]">
							<span className="truncate">
								<span className="text-world-muted">{day(d.at)} · </span>
								{d.reading}
							</span>
							<span className="hidden md:block">
								<Bar right={d.covered} total={d.total} />
							</span>
							<span className="text-right tabular-nums">
								{d.covered} of {d.total} ideas
							</span>
						</li>
					))}
				</ul>
			) : (
				<p className="font-sans text-sm text-world-muted">No brain dumps yet. Recall a section after reading it.</p>
			)}
		</Block>
	)
}

/** Practice minutes a week on each skill, with its target as a mark, oldest week first. */
function Practice({ practice }: { practice: ProgressSummary['practice'] }) {
	return (
		<Block title="Practice" sub="Minutes a week on each skill, against its target.">
			{practice.length ? (
				<ul className="grid gap-4" data-testid="practice">
					{practice.map((p) => {
						const top = Math.max(1, p.weeklyMinutes ?? 0, ...p.weeks.map((w) => w.minutes))
						const thisWeek = p.weeks.at(-1)?.minutes ?? 0
						return (
							<li key={p.skillId} className="grid gap-2">
								<p className="flex justify-between gap-3 font-sans text-sm">
									<span className="font-medium">{p.name}</span>
									<span className="text-world-muted tabular-nums">
										{thisWeek}
										{p.weeklyMinutes !== null ? ` of ${p.weeklyMinutes}` : ''} min this week
									</span>
								</p>
								<div className="relative h-12">
									<ol aria-label={`${p.name}: minutes by week`} className="flex h-full items-end gap-1">
										{p.weeks.map((w) => (
											<li key={w.week.toISOString()} className="flex h-full flex-1 items-end" title={`${w.minutes} min`}>
												<div className="w-full rounded-t-sm bg-world-accent" style={{ height: `${(w.minutes / top) * 100}%`, minHeight: w.minutes ? 3 : 0 }} />
												<span className="sr-only">{w.minutes} min</span>
											</li>
										))}
									</ol>
									{p.weeklyMinutes !== null && (
										<div aria-hidden className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-red" style={{ bottom: `${(p.weeklyMinutes / top) * 100}%` }} />
									)}
								</div>
							</li>
						)
					})}
				</ul>
			) : (
				<p className="font-sans text-sm text-world-muted">
					No practice in these weeks. Log practice on a{' '}
					<Link to="/mind/skills" className="underline underline-offset-2">
						skill
					</Link>{' '}
					after a session.
				</p>
			)}
		</Block>
	)
}

/** Progress: what the member knows and what is fading, measured at review, never flattered. */
/** How often each confidence was right: a percentage from 20 answers, counts below that. */
function Calibration({ calibration }: { calibration: ProgressSummary['calibration'] }) {
	const { sureWrongThisMonth, ...levels } = calibration
	const line = calibrationLine(levels, RECALL_MIN_REVIEWS)
	return (
		<Block title="Calibration" sub="How often you were right when you said you were sure, thought so, or guessed.">
			<p className="font-sans text-sm" data-testid="calibration">
				{line || 'No answers with a confidence yet.'}
			</p>
			<p className="font-sans text-sm text-world-muted" data-testid="sure-wrong">
				Sure but wrong this month: {sureWrongThisMonth}
			</p>
		</Block>
	)
}

export function Progress() {
	const summary = useQuery(orpc.progress.summary.queryOptions({ input: { days: DAYS } }))
	const data = summary.data
	return (
		<section className="mx-auto grid w-full max-w-3xl gap-6">
			<header className="grid gap-1">
				<Link to="/mind" className="font-sans text-sm text-world-muted">
					← The reading room
				</Link>
				<h1 className="text-3xl font-semibold tracking-tight">Progress</h1>
				<p className="text-world-muted">Recall measured when ideas come back, not pages read.</p>
			</header>
			{data && (
				<>
					<Ideas ideas={data.ideas} />
					<RecallAtReview recall={data.recallAtReview} />
					<RecallByGap gaps={data.recallByGap} />
					<Calibration calibration={data.calibration} />
					<Dumps dumps={data.dumps} />
					<Practice practice={data.practice} />
				</>
			)}
		</section>
	)
}
