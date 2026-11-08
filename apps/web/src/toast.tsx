import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react'

type Toast = { id: number; text: string; undo?: () => void }

const ToastContext = createContext<(toast: Omit<Toast, 'id'>) => void>(() => {})

/** Shows one short message at a time, with an optional Undo, for 6 seconds. */
export function ToastProvider({ children }: { children: ReactNode }) {
	const [toast, setToast] = useState<Toast | null>(null)
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
	const show = useCallback((t: Omit<Toast, 'id'>) => {
		clearTimeout(timer.current)
		const id = Date.now()
		setToast({ ...t, id })
		timer.current = setTimeout(() => setToast((cur) => (cur?.id === id ? null : cur)), 6000)
	}, [])
	return (
		<ToastContext value={show}>
			{children}
			<div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 md:bottom-6">
				{toast && (
					<div
						key={toast.id}
						role="status"
						className="pointer-events-auto flex max-w-md animate-[toast-in_.18s_ease-out] items-center gap-4 rounded-xl bg-navy px-4 py-3 text-sm text-white shadow-lg"
					>
						<span className="min-w-0 truncate">{toast.text}</span>
						{toast.undo && (
							<button
								type="button"
								className="shrink-0 font-semibold text-heart hover:underline"
								onClick={() => {
									toast.undo?.()
									setToast(null)
								}}
							>
								Undo
							</button>
						)}
					</div>
				)}
			</div>
		</ToastContext>
	)
}

export const useToast = () => useContext(ToastContext)
