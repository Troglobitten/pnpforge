/**
 * One game piece (or a supply bowl of them) as seen on the table. The body is a `D·scale` square
 * around the silhouette; the rendered image — silhouette plus its shadow — is a canvas placed inside
 * it and may spill out down-right. The image is lit from the table's fixed light, so the caller
 * undoes any frame rotation and passes it as `yaw` (as dice do).
 */
import { memo, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { liftFor, pieceFrame, type PieceLook } from './model';
import { peekAnyDensity, peekPieceImage, pieceImage, schedulePieceImage, type PieceImage, type PieceReq } from './render';
import './pieces.css';

interface Props {
  look: PieceLook;
  /** CSS px per mm the piece is laid out at. */
  scale: number;
  /** Device px per mm it will appear at on screen (render density). Default: scale × devicePixelRatio. */
  ppm?: number;
  /** Degrees clockwise. */
  yaw?: number;
  /** Held up in the hand: raised, with a longer, softer shadow. */
  lifted?: boolean;
  supply?: boolean;
  className?: string;
  style?: CSSProperties;
}

export const PieceView = memo(function PieceView({ look, scale, ppm, yaw = 0, lifted, supply, className, style }: Props) {
  const frame = pieceFrame(look, !!supply);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shown = useRef<PieceImage | null>(null);
  const density = ppm ?? scale * (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  const { shape, material, color, size, lying } = look;

  useLayoutEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const req: PieceReq = { look: { shape, material, color, size, lying }, yaw, ppm: density, lift: lifted ? liftFor(look) : 0, supply };
    const paint = (img: PieceImage) => {
      if (shown.current === img) return;
      shown.current = img;
      const { win } = img;
      if (cv.width !== img.canvas.width || cv.height !== img.canvas.height) {
        cv.width = img.canvas.width;
        cv.height = img.canvas.height;
      } else cv.getContext('2d')!.clearRect(0, 0, cv.width, cv.height);
      cv.getContext('2d')!.drawImage(img.canvas, 0, 0);
      const left = win.u0 - (frame.uc - frame.D / 2);
      const top = frame.vc + frame.D / 2 - win.v1;
      cv.style.left = `${left * scale}px`;
      cv.style.top = `${top * scale}px`;
      cv.style.width = `${(win.u1 - win.u0) * scale}px`;
      cv.style.height = `${(win.v1 - win.v0) * scale}px`;
    };
    const exact = peekPieceImage(req);
    if (exact) {
      paint(exact);
      return;
    }
    // Something of this pose already on screen or cached: keep showing it, sharpen shortly.
    const near = shown.current && shown.current.win ? null : peekAnyDensity(req);
    if (shown.current || near) {
      if (near) paint(near);
      return schedulePieceImage(req, paint);
    }
    paint(pieceImage(req));
  }, [shape, material, color, size, lying, yaw, density, lifted, supply, scale, frame]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`piece3d ${className ?? ''}`} style={{ width: frame.D * scale, height: frame.D * scale, ...style }}>
      <canvas ref={canvasRef} className="piece3d__img" width={0} height={0} aria-hidden />
    </div>
  );
});
