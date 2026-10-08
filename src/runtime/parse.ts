import { parse, type Node } from 'acorn';

export interface Meta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: { title: string; detail?: string; model?: string }[];
}
type Ast = Node & Record<string, any>;
function literal(node: Ast): unknown {
  if (node.type === 'Literal' && !node.regex && !node.bigint) return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return -node.argument.value;
  if (node.type === 'ArrayExpression') return node.elements.map((n: Ast | null) => { if (!n) throw new Error('meta cannot contain array holes'); return literal(n); });
  if (node.type === 'ObjectExpression') {
    const value: Record<string, unknown> = Object.create(null);
    for (const prop of node.properties) {
      if (prop.type !== 'Property' || prop.computed || prop.method || prop.shorthand || prop.kind !== 'init') throw new Error('meta must be a pure literal');
      const key = prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value);
      if (Object.hasOwn(value, key)) throw new Error(`duplicate meta property: ${key}`);
      value[key] = literal(prop.value);
    }
    return value;
  }
  throw new Error('meta must be a pure literal');
}

export function parseWorkflow(source: string): { meta: Meta; body: string } {
  let ast: Ast;
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, locations: true }) as Ast;
  } catch (error) {
    throw new Error(`${(error as Error).message}; scripts are plain JavaScript`, { cause: error });
  }
  const first = ast.body[0];
  const declaration = first?.declaration;
  if (first?.type !== 'ExportNamedDeclaration' || declaration?.kind !== 'const' || declaration.declarations.length !== 1 || declaration.declarations[0].id.name !== 'meta') {
    throw new Error('first statement must be export const meta = { name, description }');
  }
  const meta = literal(declaration.declarations[0].init) as Meta;
  if (!meta || typeof meta.name !== 'string' || !meta.name.trim() || typeof meta.description !== 'string') throw new Error('meta requires name and description strings');
  if (meta.phases && (!Array.isArray(meta.phases) || meta.phases.some(p => !p || typeof p.title !== 'string'))) throw new Error('invalid meta.phases');
  function walk(node: any): void {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string' && (node.type.startsWith('Import') || node.type.startsWith('Export'))) throw new Error('imports and additional exports are unavailable in workflow scripts');
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  ast.body.slice(1).forEach(walk);
  // Preserve original line numbers, including multiline metadata.
  const body = source.slice(0, first.start) + source.slice(first.start, first.end).replace(/[^\r\n]/g, ' ') + source.slice(first.end);
  try { parse(`async function __main(){\n${body}\n}`, { ecmaVersion: 'latest', sourceType: 'script' }); }
  catch (error) { throw new Error(`invalid workflow body: ${(error as Error).message}`); }
  return { meta, body };
}
