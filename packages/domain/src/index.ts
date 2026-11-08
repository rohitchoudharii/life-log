export const PILLARS = ['mind', 'body', 'heart', 'path'] as const
export type Pillar = (typeof PILLARS)[number]
