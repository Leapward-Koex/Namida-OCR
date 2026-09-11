export type ReadingDirection = 'horizontal' | 'vertical';
type Point = { x: number; y: number };
type Region = { points: readonly Point[] };

export function regionBounds(region: Region) {
    const left = Math.min(...region.points.map(point => point.x));
    const right = Math.max(...region.points.map(point => point.x));
    const top = Math.min(...region.points.map(point => point.y));
    const bottom = Math.max(...region.points.map(point => point.y));
    return { left, right, top, bottom, width: right - left, height: bottom - top };
}

/** Japanese column ordering is an application layout policy, separate from CTC.
 * Infer it from region geometry, never from recognized characters or test labels.
 * Mixed-orientation documents need a layout model; snips use the dominant direction.
 */
export function orderTextRegions<T extends Region>(regions: readonly T[], direction?: ReadingDirection) {
    const items = regions.map((region, index) => ({ region, index, ...regionBounds(region) }));
    const verticalExtent = items.reduce((sum, item) => sum + Math.max(0, item.height - item.width), 0);
    const horizontalExtent = items.reduce((sum, item) => sum + Math.max(0, item.width - item.height), 0);
    const resolved = direction ?? (verticalExtent > horizontalExtent ? 'vertical' : 'horizontal');
    // Group overlapping centers into rows/columns before sorting along each line.
    // This avoids a non-transitive comparator for staggered text regions.
    const vertical = resolved === 'vertical';
    const crossCenter = (item: typeof items[number]) => vertical
        ? (item.left + item.right) / 2 : (item.top + item.bottom) / 2;
    const crossSize = (item: typeof items[number]) => vertical ? item.width : item.height;
    const alongStart = (item: typeof items[number]) => vertical ? item.top : item.left;
    items.sort((a, b) => (crossCenter(a) - crossCenter(b)) * (vertical ? -1 : 1) || a.index - b.index);
    const groups: typeof items[] = [];
    for (const item of items) {
        const group = groups.find(entries => entries.every(other =>
            Math.abs(crossCenter(item) - crossCenter(other)) <= Math.min(crossSize(item), crossSize(other)) / 2));
        if (group) group.push(item);
        else groups.push([item]);
    }
    return {
        direction: resolved,
        regions: groups.flatMap(group => group.sort((a, b) => alongStart(a) - alongStart(b) || a.index - b.index)
            .map(item => item.region)),
    };
}
