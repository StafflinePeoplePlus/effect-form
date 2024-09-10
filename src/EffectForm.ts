import { ArrayFormatter, JSONSchema, Schema, type ParseResult } from '@effect/schema';
import { Effect, Either, Option, Array, Record, Match, Data, Predicate } from 'effect';

export type PrimitiveValue = string | null | readonly PrimitiveValue[] | PrimitiveValueRecord;
export interface PrimitiveValueRecord extends Record<string, PrimitiveValue> {}

export namespace EffectForm {
	export type Any = EffectForm<any, any, any, Schema.Schema.Any>;
	export type Context<F> =
		F extends EffectForm<any, any, infer R, infer M> ? R & Schema.Schema.Context<M> : never;
	export type FieldsSchema<F extends Any> = F['fields'];
	export type Fields<F extends Any> = Schema.Schema.Type<FieldsSchema<F>>;
	export type MessageSchema<F extends Any> = F['message'];
	export type Message<F extends Any> = Schema.Schema.Type<MessageSchema<F>>;
}
export class EffectForm<A, I, R, M> extends Data.TaggedClass('EffectForm')<{
	fields: Schema.Schema<A, I, R>;
	message: M;
}> {}
export const make = <A, I extends PrimitiveValueRecord, R, M extends Schema.Schema.Any>(
	fields: Schema.Schema<A, I, R>,
	message: M,
) => new EffectForm({ fields, message });

export class ValidatedForm<F extends EffectForm.Any> {
	static decode<F extends EffectForm.Any>(
		formDef: F,
	): (
		data: unknown,
	) => Effect.Effect<ValidatedForm<F>, ParseResult.ParseError, EffectForm.Context<F>> {
		const parse = Schema.decodeUnknown(ValidatedForm.makeSchema(formDef));
		return (data) =>
			parse(data).pipe(
				Effect.andThen(
					({ data, fields, message }) => new ValidatedForm(formDef, data, fields, message),
				),
			);
	}

	static makeSchema<F extends EffectForm.Any>(formDef: F) {
		return Schema.Struct({
			data: Schema.Either({
				left: Schema.Array(FormFieldError),
				right: formDef.fields,
			}),
			fields: Schema.Record({
				key: Schema.String,
				value: Schema.Struct({
					_tag: Schema.Literal('String', 'Array'),
					value: Schema.Union(
						Schema.Array(Schema.NullOr(Schema.String)),
						Schema.String,
						Schema.Null,
					),
					errors: Schema.Option(Schema.NonEmptyArray(FormFieldError)),
					attributes: Schema.Struct({
						name: Schema.String,
						required: Schema.Boolean,
						minlength: Schema.optional(Schema.Number),
						maxlength: Schema.optional(Schema.Number),
						pattern: Schema.optional(Schema.String),
						min: Schema.optional(Schema.Number),
						max: Schema.optional(Schema.Number),
					}),
				}),
			}) as unknown as Schema.Schema<
				FormFields<Schema.Schema.Encoded<EffectForm.FieldsSchema<F>>>,
				{
					[K in keyof Schema.Schema.Encoded<EffectForm.FieldsSchema<F>>]: {
						_tag: 'String' | 'Array';
						value: string | null | readonly (string | null)[];
						errors: Schema.OptionEncoded<Array.NonEmptyReadonlyArray<FormFieldError>>;
						attributes: FormFieldAttributes;
					};
				},
				never
			>,
			message: Schema.Option(formDef.message),
		});
	}

	encoded: Effect.Effect<
		Schema.Schema.Encoded<ReturnType<typeof ValidatedForm.makeSchema<F>>>,
		ParseResult.ParseError,
		EffectForm.Context<F>
	>;
	public fields: FormFields<Schema.Schema.Encoded<EffectForm.FieldsSchema<F>>>;

	constructor(
		formDef: F,
		public data: Either.Either<EffectForm.Fields<F>, readonly FormFieldError[]>,
		fields: FormFields<Schema.Schema.Encoded<EffectForm.FieldsSchema<F>>>,
		public message: Option.Option<EffectForm.Message<F>>,
	) {
		this.fields = Record.map(fields, (field) => {
			if (field._tag === 'Array') {
				return new Proxy(field, {
					get(target, prop, receiver) {
						if (typeof prop === 'string') {
							const index = Number(prop);
							if (!Number.isNaN(index)) {
								return new Proxy(
									{},
									{
										get(_target, prop) {
											if (prop === 'value') {
												return field.value[index];
											}
											if (prop === 'errors') {
												return field.errors.pipe(
													Option.map((errors) => errors.filter((error) => error.path[1] === index)),
													Option.filter(Array.isNonEmptyReadonlyArray),
												);
											}
											if (prop === 'attributes') {
												return field.attributes;
											}
											return undefined;
										},
										set(_target, prop, value) {
											if (prop === 'value') {
												field.value[index] = value;
												return true;
											}
											return false;
										},
									},
								);
							}
						}
						return Reflect.get(target, prop, receiver);
					},
				});
			}
			return field;
		}) as FormFields<Schema.Schema.Encoded<EffectForm.FieldsSchema<F>>>;
		const encode = Effect.sync(() => Schema.encode(ValidatedForm.makeSchema(formDef)));
		this.encoded = encode.pipe(Effect.andThen((encode) => encode(this)));
	}

	setMessage(message: EffectForm.Message<F>): this {
		this.message = Option.some(message);
		return this;
	}

	public clearErrors() {
		this.message = Option.none();
		for (const value of Record.values(this.fields)) {
			value.errors = Option.none();
		}
		return this;
	}
}

export type FormFieldError = typeof FormFieldError.Type;
const FormFieldError = Schema.Struct({
	path: Schema.Array(Schema.Union(Schema.String, Schema.Number)),
	message: Schema.String,
});
export type FormFields<I = Record<string, string>> = {
	[K in keyof I]: FormField<I[K]>;
};
export type FormField<I = string> = I extends readonly (infer V extends PrimitiveValue)[]
	? {
			_tag: 'Array';
			value: V[];
			errors: Option.Option<Array.NonEmptyReadonlyArray<FormFieldError>>;
			attributes: FormFieldAttributes;

			[index: number]: FormField<V>;
		}
	: {
			_tag: 'String';
			value: I | null;
			errors: Option.Option<Array.NonEmptyReadonlyArray<FormFieldError>>;
			attributes: FormFieldAttributes;
		};
export type FormFieldAttributes = {
	name: string;
	required: boolean;

	// text input validation
	minlength?: number;
	maxlength?: number;
	pattern?: string;

	// number input validation
	min?: number;
	max?: number;
};

const whenType = Match.discriminator('type');

export type Validate<F extends EffectForm.Any> = (
	payload: Payload,
) => Effect.Effect<ValidatedForm<F>, ParseResult.ParseError, EffectForm.Context<F>>;

export const validate = <F extends EffectForm.Any>(formDef: F): Validate<F> => {
	const jsonSchema = JSONSchema.make(formDef.fields);
	if (!('type' in jsonSchema) || jsonSchema.type !== 'object') {
		throw new Error('Schema passed to EffectForm.validate is expected to be an object type');
	}
	const fieldDefs = fieldDefsFromJSONSchema(jsonSchema);

	const decodeFormData = Schema.decodeUnknown(Schema.partial(Schema.encodedSchema(formDef.fields)));
	const decodeData = Schema.decodeUnknown(formDef.fields, { errors: 'all' });
	return (
		payload: Payload,
	): Effect.Effect<ValidatedForm<F>, ParseResult.ParseError, EffectForm.Context<F>> =>
		Effect.all([
			decodeData(normalisePayload(fieldDefs, payload, null)).pipe(
				Effect.either,
				Effect.andThen(
					Either.match({
						onRight: (x) => Effect.succeed(Either.right(x)),
						onLeft: (err) =>
							ArrayFormatter.formatError(err).pipe(
								Effect.map((issues) => issues as FormFieldError[]),
								Effect.map(Either.left),
							),
					}),
				),
			),
			decodeFormData(normalisePayload(fieldDefs, payload, undefined)),
		]).pipe(
			Effect.andThen(([data, formData]) => {
				const allErrors = data.pipe(
					Either.getLeft,
					Option.getOrElse(() => []),
				);
				type I = Schema.Schema.Encoded<EffectForm.FieldsSchema<F>>;
				return new ValidatedForm(
					formDef,
					data,
					Record.map(fieldDefs, (field, key) => {
						// TODO: handle structs?
						const errors = Array.filterMap(allErrors, (error) =>
							FieldType.$match(field.type, {
								String: () =>
									error.path.length === 1 && error.path[0] === key
										? Option.some(error)
										: Option.none(),
								Array: () =>
									error.path.length === 2 &&
									error.path[0] === key &&
									typeof error.path[1] === 'number'
										? Option.some(error)
										: Option.none(),
							}),
						);
						return {
							_tag: field.type._tag,
							value: formData[key] ?? null,
							errors: Array.isNonEmptyReadonlyArray(errors) ? Option.some(errors) : Option.none(),
							attributes: field.attributes,
						} as FormField<I[keyof I]>;
					}) as FormFields<I>,
					Option.none(),
				);
			}),
		);
};

const validationFromJSONSchema = (schema: JSONSchema.JsonSchema7) => {
	const validation: Omit<FormFieldAttributes, 'name' | 'required'> & {
		required?: false;
	} = {};
	Match.value(schema).pipe(
		whenType('number', 'integer', (schema) => {
			if (schema.minimum !== undefined) validation.min = schema.minimum;
			if (schema.maximum !== undefined) validation.max = schema.maximum;
		}),
		whenType('string', (schema) => {
			if (schema.minLength !== undefined) validation.minlength = schema.minLength;
			if (schema.maxLength !== undefined) validation.maxlength = schema.maxLength;
			if (schema.pattern !== undefined) validation.pattern = schema.pattern;
		}),
		Match.when({ type: 'array', items: Predicate.isObject }, (schema) => {
			Object.assign(validation, validationFromJSONSchema(schema.items));
		}),
		Match.when({ anyOf: Match.any }, (schema) => {
			for (const subSchema of schema.anyOf) {
				Object.assign(validation, validationFromJSONSchema(subSchema as JSONSchema.JsonSchema7));
			}
		}),
		Match.when({ enum: (x) => x.includes(null) }, () => {
			validation.required = false;
		}),
		Match.orElse(() => {}),
	);
	return validation;
};

export type Payload = FormData | PrimitiveValueRecord;
const normalisePayload = <VoidValue>(fields: FieldDefs, payload: Payload, voidValue: VoidValue) => {
	if (payload instanceof FormData) {
		// TODO: structs?
		const nullify = (value: File | string | null) =>
			value instanceof File ? null : value === '' ? null : value;
		return Record.map(fields, (field, key) =>
			FieldType.$match(field.type, {
				String: ({ emptyValue }) => nullify(payload.get(key)) ?? emptyValue,
				Array: ({ items }) => {
					if (FieldType.$is('Array')(items)) {
						throw new Error('Nested arrays are not yet supported.');
					}
					return payload.getAll(key).map((value) => nullify(value) ?? items.emptyValue);
				},
			}),
		);
	}

	return Record.map(fields, (field, key) =>
		FieldType.$match(field.type, {
			String: () => payload[key] ?? voidValue,
			Array: () => payload[key] ?? [],
		}),
	);
};

type FieldDefs = Record<string, { type: FieldType; attributes: FormFieldAttributes }>;
const fieldDefsFromJSONSchema = (jsonSchema: JSONSchema.JsonSchema7Object): FieldDefs =>
	Record.map(jsonSchema.properties, (fieldJSONSchema, key) => {
		const type = fieldTypeFromJSONSchema(fieldJSONSchema);
		return {
			type,
			attributes: {
				name: key,
				required: jsonSchema.required.includes(key),
				...validationFromJSONSchema(fieldJSONSchema),
			} satisfies FormFieldAttributes,
		};
	});

type FieldType = Data.TaggedEnum<{
	String: { emptyValue: string | null };
	Array: { items: FieldType };
}>;
const FieldType = Data.taggedEnum<FieldType>();
const fieldTypeFromJSONSchema: (schema: JSONSchema.JsonSchema7) => FieldType =
	Match.type<JSONSchema.JsonSchema7>().pipe(
		whenType('array', (schema) => {
			if (schema.items === undefined) throw new Error('expected type for array items');
			if (Array.isArray(schema.items)) throw new Error('expected single type for array items');
			return FieldType.Array({ items: fieldTypeFromJSONSchema(schema.items) });
		}),
		// TODO: annoying that this is special-cased, I think we probably need to migrate off using JSONSchema
		// to allow using Effect schema annoations to clean this up
		Match.when({ enum: ['true', 'false', 'on', 'off'] }, () =>
			FieldType.String({ emptyValue: 'off' }),
		),
		Match.when({ anyOf: Match.any }, (schema) => {
			if (schema.anyOf.some((x) => 'enum' in x && (x.enum as unknown[]).includes(null))) {
				return FieldType.String({ emptyValue: null });
			}
			return FieldType.String({ emptyValue: '' });
		}),
		Match.when({ enum: (x) => x.includes(null) }, () => FieldType.String({ emptyValue: null })),
		Match.orElse(() => FieldType.String({ emptyValue: '' })),
	);
