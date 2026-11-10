import { enqueueDefineWord } from '../jobs'
import { addWord, listWords, removeWord, restoreWord, setMeaning, suggestions } from '../learning/words'
import { authed } from '../orpc'

export const wordRoutes = {
	add: authed.words.add.handler(async ({ input, context }) => {
		const { word, existing, needsDefining } = await addWord(context.user.id, input)
		if (needsDefining) await enqueueDefineWord({ userId: context.user.id, cardId: word.id })
		return { word, existing }
	}),
	list: authed.words.list.handler(({ context }) => listWords(context.user.id)),
	suggestions: authed.words.suggestions.handler(({ input, context }) => suggestions(context.user.id, input.sectionId)),
	update: authed.words.update.handler(({ input, context }) => setMeaning(context.user.id, input.id, input.meaning)),
	remove: authed.words.remove.handler(({ input, context }) => removeWord(context.user.id, input.id)),
	restore: authed.words.restore.handler(({ input, context }) => restoreWord(context.user.id, input.id)),
}
