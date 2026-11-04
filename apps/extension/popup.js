// Peak capture. Sends the page you are looking at to Peak, which keeps only its article.
// Every value from a page or the server is set with textContent, never as HTML.

const $ = (id) => document.getElementById(id)
const DEFAULTS = { apiUrl: 'http://localhost:8787', appUrl: 'http://localhost:8081' }
const NEW_BUCKET = '__new'
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES = 20

let settings = { ...DEFAULTS }
let token = null
let email = ''

const show = (...ids) => {
	for (const id of ['email-form', 'code-form', 'capture-form', 'done']) $(id).hidden = !ids.includes(id)
	$('sign-out').hidden = !token
}
const status = (text) => ($('status').textContent = text ?? '')
const error = (err) => ($('error').textContent = err ? (err instanceof Error ? err.message : String(err)) : '')

async function api(method, path, body) {
	let res
	try {
		res = await fetch(settings.apiUrl + path, {
			method,
			headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	} catch {
		throw new Error(`Can't reach Peak at ${settings.apiUrl}. Is it running? You can change the address in Settings.`)
	}
	const json = await res.json().catch(() => ({}))
	if (res.status === 401 && token) {
		await chrome.storage.local.remove('token')
		token = null
		show('email-form')
		throw new Error('Your sign-in expired. Sign in again.')
	}
	if (!res.ok) throw new Error(json.error ?? `Peak answered ${res.status}`)
	return json
}

async function activeTab() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
	return tab
}

async function showCapture() {
	show('capture-form')
	const tab = await activeTab()
	$('page-title').textContent = tab?.title ?? ''
	const capturable = tab?.url && /^https?:/.test(tab.url)
	$('page-host').textContent = capturable ? new URL(tab.url).hostname : 'Peak can capture web pages only, not this tab.'
	$('capture').disabled = !capturable

	const { collections } = await api('GET', '/collections')
	const select = $('bucket')
	const { lastBucket } = await chrome.storage.local.get('lastBucket')
	select.replaceChildren()
	const add = (value, label) => {
		const o = document.createElement('option')
		o.value = value
		o.textContent = label
		select.append(o)
	}
	add('', 'None')
	for (const c of collections) add(c.id, c.name)
	add(NEW_BUCKET, 'New bucket…')
	// Pages from one site usually go in one bucket, so the last one is picked again.
	if (collections.some((c) => c.id === lastBucket)) select.value = lastBucket
	$('new-bucket-label').hidden = select.value !== NEW_BUCKET
}

$('bucket').addEventListener('change', () => {
	$('new-bucket-label').hidden = $('bucket').value !== NEW_BUCKET
	if ($('bucket').value === NEW_BUCKET) $('new-bucket').focus()
})

$('email-form').addEventListener('submit', async (e) => {
	e.preventDefault()
	error()
	email = $('email').value.trim()
	try {
		await api('POST', '/auth/otp/request', { email })
		$('code-sent').textContent = `We sent a code to ${email}.`
		show('code-form')
		$('code').focus()
	} catch (err) {
		error(err)
	}
})

$('code-form').addEventListener('submit', async (e) => {
	e.preventDefault()
	error()
	try {
		const { token: t } = await api('POST', '/auth/otp/verify', {
			email,
			code: $('code').value.trim(),
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		})
		token = t
		await chrome.storage.local.set({ token })
		await showCapture()
	} catch (err) {
		error(err)
	}
})

$('back').addEventListener('click', () => show('email-form'))

$('sign-out').addEventListener('click', async () => {
	await api('POST', '/auth/logout').catch(() => {})
	await chrome.storage.local.remove('token')
	token = null
	error()
	status()
	show('email-form')
})

/** Runs in the page: the page as the user sees it now, including what scripts and sign-ins added. */
function readPage() {
	return { url: location.href, title: document.title, html: document.documentElement.outerHTML }
}

/** Runs in the page, so images load with the site's own cookies: the ones Peak's server could not get. */
async function readImages(srcs, maxBytes) {
	const out = []
	for (const src of srcs) {
		try {
			const res = await fetch(src, { credentials: 'include' })
			if (!res.ok) continue
			const blob = await res.blob()
			if (!blob.type.startsWith('image/') || blob.size > maxBytes) continue
			const data = await new Promise((resolve, reject) => {
				const r = new FileReader()
				r.onload = () => resolve(String(r.result).split(',')[1])
				r.onerror = reject
				r.readAsDataURL(blob)
			})
			out.push({ src, data })
		} catch {
			// Blocked even for the page; the article keeps its text without this image.
		}
	}
	return out
}

$('capture-form').addEventListener('submit', async (e) => {
	e.preventDefault()
	error()
	$('capture').disabled = true
	try {
		const tab = await activeTab()
		let collectionId = $('bucket').value || null
		if (collectionId === NEW_BUCKET) {
			const name = $('new-bucket').value.trim()
			if (!name) throw new Error('Name the new bucket')
			collectionId = (await api('POST', '/collections', { name })).collection.id
		}
		await chrome.storage.local.set({ lastBucket: collectionId })

		status('Reading the page…')
		const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage })
		status('Saving the article and its images…')
		const { item, missingImages } = await api('POST', '/items/capture', {
			...page,
			collectionId,
			questionIntensity: $('intensity').value,
			questionStyle: 'mixed',
		})

		let rescued = 0
		if (missingImages.length) {
			status(`Fetching ${missingImages.length} image${missingImages.length === 1 ? '' : 's'} the site blocked…`)
			const [{ result: images }] = await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: readImages,
				args: [missingImages.slice(0, MAX_IMAGES), MAX_IMAGE_BYTES],
			})
			for (const img of images) if (await api('POST', `/items/${item.id}/images`, img).then(() => true, () => false)) rescued++
		}

		status()
		$('done-text').textContent = `Added "${item.title}". Peak is writing its questions now.${missingImages.length ? ` ${rescued} of ${missingImages.length} blocked images were saved.` : ''}`
		$('open').href = `${settings.appUrl}/read/${item.id}`
		show('done')
	} catch (err) {
		status()
		error(err)
	} finally {
		$('capture').disabled = false
	}
})

$('again').addEventListener('click', () => showCapture().catch(error))

$('save-settings').addEventListener('click', async () => {
	const apiUrl = ($('api-url').value.trim() || DEFAULTS.apiUrl).replace(/\/$/, '')
	const appUrl = ($('app-url').value.trim() || DEFAULTS.appUrl).replace(/\/$/, '')
	error()
	try {
		// Another server needs permission to be reached from the extension.
		const origin = `${new URL(apiUrl).origin}/*`
		if (!(await chrome.permissions.contains({ origins: [origin] })) && !(await chrome.permissions.request({ origins: [origin] })))
			throw new Error('Peak needs permission to reach that server')
		settings = { apiUrl, appUrl }
		await chrome.storage.local.set({ settings })
		status('Saved')
		if (token) await showCapture()
	} catch (err) {
		error(err)
	}
})

async function start() {
	const stored = await chrome.storage.local.get(['token', 'settings'])
	settings = { ...DEFAULTS, ...stored.settings }
	$('api-url').value = settings.apiUrl
	$('app-url').value = settings.appUrl
	token = stored.token ?? null
	if (!token) return show('email-form')
	try {
		await showCapture()
	} catch (err) {
		error(err)
	}
}

start()
