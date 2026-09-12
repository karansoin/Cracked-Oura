import { useCallback, useEffect, useState } from 'react';

/** Observe an element's content width so layouts can adapt to the space they
 *  actually have (a side panel can shrink the main column below any viewport breakpoint). */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
    const [el, setEl] = useState<T | null>(null);
    const [width, setWidth] = useState(0);
    const ref = useCallback((node: T | null) => setEl(node), []);
    useEffect(() => {
        if (!el) return;
        const ro = new ResizeObserver(entries => {
            for (const e of entries) setWidth(e.contentRect.width);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [el]);
    return [ref, width];
}
