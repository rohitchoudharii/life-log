/** A short, human name for a device, such as "Chrome on macOS", from its user agent. */
export function deviceLabel(userAgent: string | null) {
	const ua = userAgent ?? ''
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /Firefox\//.test(ua)
			? 'Firefox'
			: /Chrome\/|CriOS\//.test(ua)
				? 'Chrome'
				: /Safari\//.test(ua)
					? 'Safari'
					: 'Browser'
	const os = /iPhone/.test(ua)
		? 'iPhone'
		: /iPad/.test(ua)
			? 'iPad'
			: /Android/.test(ua)
				? 'Android'
				: /Mac OS X|Macintosh/.test(ua)
					? 'macOS'
					: /Windows/.test(ua)
						? 'Windows'
						: /Linux/.test(ua)
							? 'Linux'
							: 'unknown device'
	return `${browser} on ${os}`
}
