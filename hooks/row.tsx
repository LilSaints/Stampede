import type { ClientModule } from 'claude-code';

/**
 * One run of text in a row, styled as its Text props say. `dim: 'rest'` is
 * muted until the pointer is over the row, as the desktop's own headers and
 * finished task titles are.
 */
export type RowPart = { text: string; dim?: true | 'rest'; bold?: true; color?: 'error' | 'warning' };
/** A row: what a click on it sends back, a title, an optional second line and a right-hand note. */
export type RowProps = { id: string; title: RowPart[]; detail?: RowPart[]; right?: RowPart[] };

/**
 * A surface module whose whole region is one click target, as the desktop's
 * own task cards and Workflow phase rows expand and collapse on a click
 * anywhere in them. A click (the button coming up inside the region) posts
 * the row's id to the hooks module, which toggles what it names.
 */
const Row: ClientModule<RowProps, { hover: boolean }> = (props, surface) => {
  const { Box, Text } = surface.elements;
  if (surface.state === undefined) {
    // The id is fixed for the instance: its key names the same run or phase.
    surface.onPointer(event => {
      if (event.type === 'enter' || event.type === 'leave') { surface.setState({ hover: event.type === 'enter' }); return; }
      // An up outside the region ends a drag that left it: no click. The size
      // is 0 until the first layout, when nothing is known to be outside.
      const inside = event.x >= 0 && event.y >= 0 && (!surface.columns || event.x < surface.columns) && (!surface.rows || event.y < surface.rows);
      if (event.type === 'up' && inside) surface.post({ toggle: props.id });
    });
    surface.setState({ hover: false });
  }
  const hover = surface.state?.hover === true;
  const line = (parts: RowPart[]) => <Text wrap="truncate">{parts.map(part => <Text {...(part.dim === true || part.dim === 'rest' && !hover ? { dimColor: true } : {})} {...(part.bold ? { bold: true } : {})} {...(part.color ? { color: part.color } : {})}>{part.text}</Text>)}</Text>;
  return <Box flexDirection="column" flexGrow={1}>
    <Box justifyContent="space-between" gap={1}>
      <Box flexShrink={1} minWidth={0}>{line(props.title)}</Box>
      {props.right ? line(props.right) : null}
    </Box>
    {props.detail ? line(props.detail) : null}
  </Box>;
};
export default Row;
