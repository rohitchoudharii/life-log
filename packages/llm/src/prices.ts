/**
 * Hand-kept list prices in US dollars per million tokens, by model family. The first family whose
 * pattern matches the model id wins, so put narrower patterns first. Update when providers
 * change their prices; a model that matches none has no estimate.
 */
const PRICES: { family: RegExp; input: number; output: number }[] = [
	{ family: /haiku/, input: 1, output: 5 },
	{ family: /sonnet/, input: 3, output: 15 },
	{ family: /opus|fable/, input: 15, output: 75 },
	{ family: /nano|luna/, input: 0.1, output: 0.4 },
	{ family: /mini|terra/, input: 0.4, output: 1.6 },
	{ family: /^(gpt-|o\d)/, input: 2, output: 8 },
]

/** The estimated cost of one call in US dollars, or null for a model with no known price. */
export function estimateCost(model: string, inputTokens: number | null, outputTokens: number | null): number | null {
	const price = PRICES.find((p) => p.family.test(model))
	if (!price) return null
	return ((inputTokens ?? 0) * price.input + (outputTokens ?? 0) * price.output) / 1_000_000
}
