import { type Block, blockText, countWords, insertHeadings } from '@life-log-club/domain'
import { headingsRequest, parseHeadings } from '@life-log-club/llm'
import { callAi, withinBudget } from '../learning/ai'

/** Past this many words one call would cost too much and reply too slowly; the text is cut by length instead. */
const MAX_WORDS = 50_000

/** What the AI reads for one block. Code is shortened: its first lines say what it is about. */
function promptText(block: Block) {
	if (block.type === 'page') return `(page ${block.number})`
	if (block.type === 'image') return `(image${block.alt ? `: ${block.alt}` : ''})`
	if (block.type === 'code') return `(code) ${block.text.slice(0, 400)}`
	return blockText(block)
}

/**
 * Asks the member's AI where headings go in text that has none (issue #1, rule 3), and inserts
 * them as heading blocks marked `source: 'ai'`. The AI only names places and titles, so the
 * text itself never changes. Without a key, past the monthly budget, on a provider failure, or on
 * a reply that fails its checks, the blocks come back as they were, and the caller splits them by
 * length alone.
 */
export async function addAiHeadings(userId: string, blocks: Block[]): Promise<Block[]> {
	if (blocks.reduce((n, b) => n + countWords(blockText(b)), 0) > MAX_WORDS) return blocks
	try {
		if (!(await withinBudget(userId))) return blocks
		const reply = await callAi(userId, 'headings', (model) => headingsRequest(model, blocks.map(promptText)))
		const headings = reply === null ? null : parseHeadings(reply, blocks.length)
		return headings ? insertHeadings(blocks, headings) : blocks
	} catch (error) {
		console.warn('[headings]', error instanceof Error ? error.message : error)
		return blocks
	}
}
