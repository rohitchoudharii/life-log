/**
 * What a part of a book is for (issue #2). `drop`: front and back matter that is not the book
 * (a cover, the copyright page, the index). `notes`: endnotes, which are not a section; they will
 * open from their markers. `reference`: a bibliography, kept to read without questions. `body`:
 * everything else, including a foreword, preface, introduction, epilogue and appendices.
 */
export type Matter = 'drop' | 'notes' | 'reference' | 'body'

// EPUB 3 structural semantics: https://www.w3.org/TR/epub-ssv-11/
const TYPES: Record<string, Matter> = {
	cover: 'drop',
	titlepage: 'drop',
	'copyright-page': 'drop',
	toc: 'drop',
	index: 'drop',
	acknowledgments: 'drop',
	acknowledgements: 'drop',
	imprint: 'drop',
	colophon: 'drop',
	dedication: 'drop',
	epigraph: 'drop',
	seriespage: 'drop',
	loi: 'drop',
	lot: 'drop',
	endnotes: 'notes',
	footnotes: 'notes',
	rearnotes: 'notes',
	bibliography: 'reference',
}

/** Types that say a part is the book itself, whatever its title. */
const BODY_TYPES = new Set(['chapter', 'part', 'division', 'volume', 'subchapter'])

/** For books without semantics (EPUB 2, PDFs), from the title alone. */
const TITLES: [RegExp, Matter][] = [
	[/^(table of )?contents$|^index$|^acknowledge?ments?$|^about the authors?$|^(also|other books|books) by\b|^copyright\b|^cover$|^title page$|^dedication$|^epigraph$|^colophon$|^imprint$|^list of (figures|tables|illustrations)$/, 'drop'],
	// Project Gutenberg's front page and licence are not the book.
	[/^the project gutenberg e(book|text)|project gutenberg.*licen[cs]e|^full license$/, 'drop'],
	[/^(end|foot)?notes$/, 'notes'],
	[/^(references|bibliography|select bibliography|works cited|further reading)$/, 'reference'],
]

/**
 * Classifies a part of a book from its EPUB `epub:type` values (on the part, its file, or the
 * book's landmarks), then from its title. Section numbers ("7 References") are ignored.
 */
export function matterOf({ types = [], title }: { types?: readonly string[]; title: string }): Matter {
	for (const type of types) {
		const matter = TYPES[type]
		if (matter) return matter
	}
	if (types.some((t) => BODY_TYPES.has(t))) return 'body'
	const plain = title
		.toLowerCase()
		.replace(/^(\d+(\.\d+)*\.?|[ivxlc]+\.|appendix [a-z\d]+[.:]?)\s+/, '')
		.replace(/[.:]$/, '')
		.trim()
	return TITLES.find(([pattern]) => pattern.test(plain))?.[1] ?? 'body'
}
