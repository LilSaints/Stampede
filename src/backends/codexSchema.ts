import { Ajv } from 'ajv';
import { default as formats } from 'ajv-formats';
export type Schema = Record<string, any>;
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
(formats as unknown as (ajv: Ajv) => void)(ajv);
const removed = new Set(['format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'uniqueItems', 'multipleOf', 'default', 'examples']);
const supported = new Set(['type', 'properties', 'required', 'items', 'enum', 'const', 'anyOf', 'description', 'title', '$defs', '$ref', 'additionalProperties', '$schema']);
function fail(location: string, reason: string): never { throw new Error(`schema not supported for backend codex: ${location}: ${reason}`); }
export function validateSchema(schema: Schema) {
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) throw new Error('invalid schema: root must be an object with properties');
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some((key: string) => !Object.hasOwn(schema.properties, key)))) throw new Error('invalid schema: required must be a subset of properties');
  try { return ajv.compile(schema); } catch (error) { throw new Error(`invalid schema: ${(error as Error).message}`); }
}
export function codexSchema(original: Schema) {
  validateSchema(original);
  const resolve = (schema: Schema): Schema => {
    if (!schema.$ref) return schema;
    if (!schema.$ref.startsWith('#/')) fail('$ref', 'only local references are supported');
    let result: any = original;
    for (const part of schema.$ref.slice(2).split('/')) result = result?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (!result || typeof result !== 'object') fail('$ref', `unresolved reference ${schema.$ref}`);
    return result;
  };
  function admitsNull(schema: Schema, seen = new Set<Schema>()): boolean {
    if (seen.has(schema)) return false;
    seen.add(schema);
    if (schema.$ref && !admitsNull(resolve(schema), seen)) return false;
    if (schema.type && schema.type !== 'null' && !(Array.isArray(schema.type) && schema.type.includes('null'))) return false;
    if (schema.enum && !schema.enum.includes(null)) return false;
    if (Object.hasOwn(schema, 'const') && schema.const !== null) return false;
    if (schema.anyOf && !schema.anyOf.some((s: Schema) => admitsNull(s, new Set(seen)))) return false;
    return true;
  }
  function layout(source: Schema, seen = new Set<Schema>()): unknown {
    if (seen.has(source)) return 'recursive';
    seen.add(source);
    if (source.$ref) return layout(resolve(source), seen);
    if (source.properties) return Object.fromEntries(Object.keys(source.properties).sort().map(key => [key, [!(source.required ?? []).includes(key), layout(source.properties[key], new Set(seen))]]));
    if (source.items) return [layout(source.items, seen)];
    return null;
  }
  function disjoint(left: Schema, right: Schema): boolean {
    left = resolve(left); right = resolve(right);
    const types = (s: Schema) => Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    const a = types(left), b = types(right);
    if (a.length && b.length && !a.some((t: string) => b.includes(t) || t === 'integer' && b.includes('number') || t === 'number' && b.includes('integer'))) return true;
    for (const key of left.required ?? []) if ((right.required ?? []).includes(key)) {
      const l = left.properties?.[key], r = right.properties?.[key];
      const values = (s: Schema | undefined) => s && Object.hasOwn(s, 'const') ? [s.const] : s?.enum;
      const x = values(l), y = values(r);
      if (x && y && !x.some((v: unknown) => y.some((w: unknown) => JSON.stringify(v) === JSON.stringify(w)))) return true;
    }
    return false;
  }
  function convert(schema: Schema, location: string): Schema {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) fail(location, 'boolean and tuple schemas are unsupported');
    const output: Schema = {};
    for (const [key, value] of Object.entries(schema)) {
      if (removed.has(key)) continue;
      if (!supported.has(key)) fail(`${location}.${key}`, 'unsupported construct');
      if (key === '$ref') { resolve(schema); output[key] = value; }
      else if (key === '$defs') output[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v as Schema, `${location}.$defs.${k}`)]));
      else if (key === 'items') output.items = convert(value, `${location}.items`);
      else if (key === 'anyOf') {
        for (let i = 0; i < value.length; i++) for (let j = i + 1; j < value.length; j++) {
          if (JSON.stringify(layout(value[i])) !== JSON.stringify(layout(value[j])) && !disjoint(value[i], value[j])) fail(location, 'anyOf branches with different optional layouts need a required discriminator');
        }
        output.anyOf = value.map((v: Schema, i: number) => convert(v, `${location}.anyOf[${i}]`));
      }
      else if (!['properties', 'required', 'additionalProperties'].includes(key)) output[key] = structuredClone(value);
    }
    if (schema.type === 'object' || schema.properties) {
      if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) fail(location, 'dictionaries are unsupported; use an array of {key, value} objects');
      output.type = schema.type ?? 'object'; output.properties = {}; output.additionalProperties = false;
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        const child = value as Schema;
        const converted = convert(child, `${location}.${key}`);
        if (!(schema.required ?? []).includes(key)) {
          if (admitsNull(child)) fail(`${location}.${key}`, 'optional nullable properties lose absent/null distinction; make required or non-nullable');
          output.properties[key] = { anyOf: [converted, { type: 'null' }] };
        } else output.properties[key] = converted;
      }
      output.required = Object.keys(output.properties);
    }
    return output;
  }
  const schema = convert(original, '$');
  function transform(value: any, source: Schema, encoding: boolean): any {
    if (source.$ref) return transform(value, resolve(source), encoding);
    if (source.anyOf) {
      // Choose the branch against the corresponding encoded/original schema.
      const candidate = source.anyOf.find((branch: Schema) => {
        const shape = encoding ? branch : convert(branch, '$.anyOf');
        try { return ajv.compile({ ...shape, $defs: encoding ? original.$defs : schema.$defs })(value); } catch { return false; }
      });
      if (candidate) return transform(value, candidate, encoding);
    }
    if (Array.isArray(value) && source.items) return value.map(v => transform(v, source.items, encoding));
    if (value && typeof value === 'object' && !Array.isArray(value) && source.properties) {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(source.properties)) {
        const optional = !(source.required ?? []).includes(key);
        if (!Object.hasOwn(value, key)) { if (encoding && optional) output[key] = null; continue; }
        if (!encoding && optional && value[key] === null) continue;
        output[key] = transform(value[key], child as Schema, encoding);
      }
      // Preserve extras during decode so original validation can reject them.
      for (const key of Object.keys(value)) if (!Object.hasOwn(source.properties, key)) output[key] = value[key];
      return output;
    }
    return value;
  }
  return { schema, encode: (value: unknown) => transform(value, original, true), decode: (value: unknown) => transform(value, original, false) };
}
