import { Schema } from '@effect/schema';

export const Date = Schema.Date.annotations({ jsonSchema: { format: 'date' } });

export type BooleanLiteral = typeof Boolean.Encoded;
export const booleanFromLiteral = (value: BooleanLiteral) => value === 'true' || value === 'on';

interface Boolean extends Schema.Schema<boolean, 'true' | 'false' | 'on' | 'off'> {}
export const Boolean: Boolean = Schema.transform(
	Schema.Literal('true', 'false', 'on', 'off'),
	Schema.Boolean,
	{
		encode: (value) => (value ? 'true' : 'false'),
		decode: booleanFromLiteral,
	},
).annotations({ identifier: 'Boolean' });
