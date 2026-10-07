import { describe, expect, it } from 'vitest';

import { boundingRect, corners, rectInFrame, rotate, textAngle } from '../src/lib/highlights/rotation';


describe('rotated highlight rects', () => {
    // A tilted OCR line from a real scan: about -1.2°
    const transform = [7.903, -0.164, 0.172, 8.28, 58.515, 151.373];
    const angle = textAngle(transform);

    it('takes the angle of slightly tilted text only', () => {
        expect(angle).toBeCloseTo(Math.atan2(-0.164, 7.903));
        expect(textAngle([10, 0, 0, 10, 0, 0])).toBe(0);
        expect(textAngle([0, -0.72, 93, 0, 0, 0])).toBe(0); // vertical text
    });

    it('maps a rect in the text frame onto the tilted line', () => {
        const [x, y] = rotate(58.515, 151.373, -angle);
        const width = 225.3;
        const [ltx, lty, rtx, rty, lbx, lby] = corners({ rect: [x, y, x + width, y + 8.28], angle });
        // the baseline starts at the item origin and follows the text direction
        expect(lbx).toBeCloseTo(58.515);
        expect(lby).toBeCloseTo(151.373);
        expect(rty - lty).toBeCloseTo(width * Math.sin(angle));
        expect(rtx - ltx).toBeCloseTo(width * Math.cos(angle));
    });

    it('converts between frames and bounds in page coordinates', () => {
        const r = { rect: [0, 0, 100, 10] as [number, number, number, number], angle: 0.1 };
        expect(rectInFrame(r, 0.1)).toBe(r.rect);
        expect(rectInFrame(r, 0)).toEqual(boundingRect([r]));
        // a rect of the same line with a slightly different angle lands next to it
        const [l2, b2] = rectInFrame({ rect: [100, 0, 150, 10], angle: 0.101 }, 0.1);
        expect(l2).toBeCloseTo(100, 0);
        expect(b2).toBeCloseTo(0, 0);
        const [left, bottom, right, top] = boundingRect([r]);
        expect(left).toBeCloseTo(-10 * Math.sin(0.1));
        expect(bottom).toBeCloseTo(0);
        expect(right).toBeCloseTo(100 * Math.cos(0.1));
        expect(top).toBeCloseTo(100 * Math.sin(0.1) + 10 * Math.cos(0.1));
    });
});
