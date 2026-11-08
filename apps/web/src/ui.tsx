import type { ComponentProps, ReactNode } from 'react'

export function Field({ label, ...input }: { label: string } & ComponentProps<'input'>) {
	return (
		<label className="grid gap-1.5 text-sm">
			<span className="font-medium text-ink/80">{label}</span>
			<input
				className="rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-base outline-none focus:border-navy focus:ring-2 focus:ring-navy/20"
				{...input}
			/>
		</label>
	)
}

export function Button({ className = '', ...props }: ComponentProps<'button'>) {
	return (
		<button
			className={`rounded-lg bg-navy px-4 py-2.5 font-medium text-white transition hover:bg-navy/90 active:scale-[0.98] disabled:opacity-60 ${className}`}
			{...props}
		/>
	)
}

export function ErrorText({ children }: { children: ReactNode }) {
	if (!children) return null
	return (
		<p role="alert" className="rounded-lg bg-red/10 px-3 py-2 text-sm text-red">
			{children}
		</p>
	)
}

/** The centered card used by the sign-in and welcome pages. */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
	return (
		<main className="grid min-h-dvh place-items-center bg-cream px-4 py-10">
			<div className="w-full max-w-sm">
				<div className="mb-6 flex items-center gap-3">
					<img src="/logo.png" alt="" className="size-12 rounded-xl" />
					<span className="font-serif text-xl text-navy">Life Log Club</span>
				</div>
				<div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-ink/5">
					<h1 className="mb-5 text-xl font-semibold">{title}</h1>
					{children}
				</div>
			</div>
		</main>
	)
}
