import type { ClientModule } from 'claude-code';

/**
 * One run of text in a row, styled as its Text props say. `dim: 'rest'` is
 * muted until the pointer is over the row, as the desktop's own headers and
 * finished task titles are. `since` makes it an elapsed time that counts up
 * each second from `from`, `now` being the hooks module's clock when it drew
 * `text` (which shows until the first second passes).
 */
export type RowPart = { text: string; dim?: true | 'rest'; bold?: true; color?: 'error' | 'warning'; since?: { from: string; now: number } };
/** A row: what a click on it sends back, a title, an optional second line and a right-hand note. */
export type RowProps = { id: string; title: RowPart[]; detail?: RowPart[]; right?: RowPart[] };
type RowState = { hover: boolean; base: number; ticks: number };

/** The pane's elapsed-time format: 45s, 12m 28s, 1h 12m. */
function span(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
// The props each instance last drew with, for its clock, which ticks between draws.
const latest = new WeakMap<object, RowProps>();
const parts = (props: RowProps) => [...props.title, ...props.detail ?? [], ...props.right ?? []];
const base = (props: RowProps) => parts(props).find(part => part.since)?.since?.now ?? 0;

/**
 * A surface module whose whole region is one click target, as the desktop's
 * own task cards and Workflow phase rows expand and collapse on a click
 * anywhere in them. A click (the button coming up inside the region) posts
 * the row's id to the hooks module, which toggles what it names. Its elapsed
 * times tick on the surface's own clock, so the pane is never redrawn for them.
 */
const Row: ClientModule<RowProps, RowState> = (props, surface) => {
  const { Box, Text } = surface.elements;
  latest.set(surface, props);
  if (surface.state === undefined) {
    // The id is fixed for the instance: its key names the same run or phase.
    surface.onPointer(event => {
      if (event.type === 'enter' || event.type === 'leave') { surface.setState({ ...surface.state!, hover: event.type === 'enter' }); return; }
      // An up outside the region ends a drag that left it: no click. The size
      // is 0 until the first layout, when nothing is known to be outside.
      const inside = event.x >= 0 && event.y >= 0 && (!surface.columns || event.x < surface.columns) && (!surface.rows || event.y < surface.rows);
      if (event.type === 'up' && inside) surface.post({ toggle: props.id });
    });
    // Seconds count from the hooks module's latest drawing: new props start them again.
    if (parts(props).some(part => part.since)) surface.every(1000, () => {
      const now = base(latest.get(surface) ?? props), state = surface.state!;
      surface.setState({ ...state, base: now, ticks: state.base === now ? state.ticks + 1 : 1 });
    });
    surface.setState({ hover: false, base: base(props), ticks: 0 });
  }
  const hover = surface.state?.hover === true, ticks = surface.state?.base === base(props) ? surface.state.ticks : 0;
  const text = (part: RowPart) => part.since && ticks ? span(part.since.now + ticks * 1000 - Date.parse(part.since.from)) : part.text;
  const line = (parts: RowPart[]) => <Text wrap="truncate">{parts.map(part => <Text {...(part.dim === true || part.dim === 'rest' && !hover ? { dimColor: true } : {})} {...(part.bold ? { bold: true } : {})} {...(part.color ? { color: part.color } : {})}>{text(part)}</Text>)}</Text>;
  return <Box flexDirection="column" flexGrow={1}>
    <Box justifyContent="space-between" gap={1}>
      <Box flexShrink={1} minWidth={0}>{line(props.title)}</Box>
      {props.right ? line(props.right) : null}
    </Box>
    {props.detail ? line(props.detail) : null}
  </Box>;
};
export default Row;
