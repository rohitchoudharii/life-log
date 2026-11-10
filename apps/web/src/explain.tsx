import type { ExplainKind } from '@life-log-club/domain'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { client, errorMessage } from './rpc'

const KINDS: { value: ExplainKind; label: string; writing: string }[] = [
	{ value: 'explain', label: 'From first principles', writing: 'Explaining…' },
	{ value: 'analogy', label: 'Analogy', writing: 'Finding an analogy…' },
	{ value: 'example', label: 'Example', writing: 'Working an example…' },
]

/**
 * A selected passage explained over the reader, so reading picks up where it was. It starts at
 * once, from first principles; an analogy or a worked example is one click away, and each kind is
 * asked for once. Nothing is kept: Save idea keeps the passage, in the member's own words.
 */
export function ExplainDialog({ sectionId, passage, onSaveIdea, onClose }: { sectionId: string; passage: string; onSaveIdea?: () => void; onClose: () => void }) {
	const ref = useRef<HTMLDialogElement>(null)
	const [kind, setKind] = useState<ExplainKind>('explain')
	useEffect(() => {
		ref.current?.showModal()
	}, [])
	const explained = useQuery({
		queryKey: ['explain', sectionId, passage, kind],
		queryFn: () => client.readings.explain({ sectionId, passage, kind }),
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	})
	const current = KINDS.find((k) => k.value === kind)!
	const tab = 'rounded-full border px-3 py-1 text-sm aria-pressed:border-world-accent aria-pressed:bg-world-accent aria-pressed:text-world-on-accent'
	return (
		<dialog
			ref={ref}
			aria-labelledby="explain-title"
			onClose={onClose}
			onClick={(e) => e.target === ref.current && onClose()}
			className="m-auto w-[min(100%-2rem,36rem)] rounded-2xl bg-world p-0 font-world text-world-ink shadow-2xl ring-1 ring-world-line backdrop:bg-black/30"
		>
			<div className="grid gap-4 p-5">
				<div className="flex items-center justify-between font-sans">
					<h2 id="explain-title" className="text-sm font-semibold">
						Explain
					</h2>
					<button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-world-muted hover:bg-world-card">
						Close <kbd className="ml-1 rounded border border-world-line px-1 text-xs">Esc</kbd>
					</button>
				</div>
				<blockquote className="max-h-32 overflow-y-auto border-l-2 border-world-accent pl-3 leading-relaxed italic">{passage}</blockquote>
				<div role="group" aria-label="Kind of explanation" className="flex flex-wrap gap-2 font-sans">
					{KINDS.map((k) => (
						<button key={k.value} type="button" aria-pressed={kind === k.value} onClick={() => setKind(k.value)} className={`${tab} border-world-line text-world-ink`}>
							{k.label}
						</button>
					))}
				</div>
				<div aria-live="polite" className="grid min-h-24 gap-3" data-testid="explanation">
					{explained.isPending && <p className="animate-pulse font-sans text-sm text-world-muted">{current.writing}</p>}
					{explained.isError && (
						<div className="grid justify-items-start gap-2 font-sans text-sm">
							<p role="alert" className="text-red">
								{errorMessage(explained.error)}
							</p>
							<button type="button" onClick={() => void explained.refetch()} className="rounded-lg border border-world-line px-3 py-1.5 hover:bg-world-card">
								Try again
							</button>
						</div>
					)}
					{explained.data && (
						<>
							<p className="text-lg leading-relaxed whitespace-pre-wrap">{explained.data.text}</p>
							{explained.data.code && <pre className="overflow-x-auto rounded-xl bg-world-card p-3 text-sm whitespace-pre-wrap">{explained.data.code}</pre>}
							{explained.data.quote && <p className="text-sm text-world-muted italic">From the text: “{explained.data.quote}”</p>}
						</>
					)}
				</div>
				{onSaveIdea && (
					<div className="grid gap-1.5 border-t border-world-line pt-4 font-sans">
						<p className="text-sm text-world-muted">To keep it, save the idea in your own words. It comes back for you to recall.</p>
						<div>
							<button
								type="button"
								onClick={onSaveIdea}
								className="rounded-xl bg-world-accent px-5 py-2.5 text-sm font-semibold text-world-on-accent transition hover:opacity-90"
							>
								Save idea
							</button>
						</div>
					</div>
				)}
			</div>
		</dialog>
	)
}
