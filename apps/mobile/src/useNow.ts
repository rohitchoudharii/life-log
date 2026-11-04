import { useEffect, useState } from 'react'

/** The current time, updated every second while `active`. Timers derive from timestamps, so a backgrounded app catches up. */
export function useNow(active: boolean) {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!active) return
		const tick = () => setNow(Date.now())
		const first = setTimeout(tick, 0)
		const id = setInterval(tick, 1000)
		return () => {
			clearTimeout(first)
			clearInterval(id)
		}
	}, [active])
	return now
}

export function formatClock(ms: number) {
	const total = Math.max(0, Math.round(ms / 1000))
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
