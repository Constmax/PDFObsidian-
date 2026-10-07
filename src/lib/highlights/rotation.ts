import type { Rect } from 'typings';


/**
 * A rectangle in a frame rotated counterclockwise by `angle` (radians) about the page origin.
 * Highlights on slightly tilted text (typical for OCR text layers of scans) are computed in the text's own frame.
 */
export type RotatedRect = { rect: Rect, angle: number };

// Only slight tilts count as rotated; steeper text (e.g. vertical) keeps the axis-aligned rects,
// because the text layer measurements in geometry.ts assume a near-horizontal text div.
const MAX_ANGLE = 10 * Math.PI / 180;
const MIN_ANGLE = 1e-3;

/** The rotation of a text content item, or 0 if it's (nearly) unrotated or not slightly tilted. */
export function textAngle(transform: number[]): number {
    const angle = Math.atan2(transform[1], transform[0]);
    return MIN_ANGLE < Math.abs(angle) && Math.abs(angle) < MAX_ANGLE ? angle : 0;
}

/** Rotates the point (x, y) counterclockwise by `angle` about the origin. */
export function rotate(x: number, y: number, angle: number): [number, number] {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return [x * cos - y * sin, x * sin + y * cos];
}

/** The page coordinates of the corners in QuadPoints order: left-top, right-top, left-bottom, right-bottom. */
export function corners({ rect: [left, bottom, right, top], angle }: RotatedRect): number[] {
    return [[left, top], [right, top], [left, bottom], [right, bottom]]
        .flatMap(([x, y]) => rotate(x, y, angle));
}

function boundingBox(points: number[]): Rect {
    const xs = points.filter((_, i) => i % 2 === 0);
    const ys = points.filter((_, i) => i % 2 === 1);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The bounding box of `r` in the frame rotated by `angle`. */
export function rectInFrame(r: RotatedRect, angle: number): Rect {
    if (r.angle === angle) return r.rect;
    return boundingBox(corners({ rect: r.rect, angle: r.angle - angle }));
}

/** The axis-aligned bounding box of the given rects in page coordinates. */
export function boundingRect(rects: RotatedRect[]): Rect {
    return boundingBox(rects.flatMap(corners));
}
