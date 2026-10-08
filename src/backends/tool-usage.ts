/** Record dependency names only; tool inputs/results can contain secrets. */
export function externalTools(event: any): string[] {
  const names: string[] = [];
  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) if (block.type === 'tool_use' && typeof block.name === 'string') names.push(block.name);
  }
  if (event.type === 'stream_event' && event.event?.type === 'content_block_start' && event.event.content_block?.type === 'tool_use') names.push(event.event.content_block.name);
  if (['item.started', 'item.completed'].includes(event.type)) {
    if (event.item?.type === 'web_search') names.push('WebSearch');
    if (event.item?.type === 'mcp_tool_call' && typeof event.item.server === 'string' && typeof event.item.tool === 'string') names.push(`mcp__${event.item.server}__${event.item.tool}`);
  }
  return [...new Set(names.filter(name => typeof name === 'string' &&
    (['WebFetch', 'WebSearch'].includes(name) || name.startsWith('mcp__') && !/^mcp__(?:stampede|plugin_stampede_stampede)__/.test(name))).map(name => name.slice(0, 200)))];
}
