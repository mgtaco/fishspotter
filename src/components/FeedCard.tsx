"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useCreatureQuiz } from "@/lib/useCreatureQuiz";
import type { BBoxFrame, FeedSnippet } from "./FeedPlayer";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const TRACE_POINT_LIMIT = 22;
const MIN_HIGHLIGHT_SIZE = 28;
const VERTICAL_DEADZONE_FRACTION = 0.34;
const VERTICAL_FOLLOW_EASE_MS = 520;

interface Point {
  x: number;
  y: number;
}

function hasUsableBox(box: BBoxFrame) {
  return [box.x_norm, box.y_norm, box.w_norm, box.h_norm].every(Number.isFinite);
}

function mix(a: number, b: number, amount: number) {
  return a + (b - a) * amount;
}

function interpolateBox(a: BBoxFrame, b: BBoxFrame, amount: number): BBoxFrame {
  return {
    frame_clip: mix(a.frame_clip, b.frame_clip, amount),
    x_norm: mix(a.x_norm, b.x_norm, amount),
    y_norm: mix(a.y_norm, b.y_norm, amount),
    w_norm: mix(a.w_norm, b.w_norm, amount),
    h_norm: mix(a.h_norm, b.h_norm, amount),
  };
}

function easeObjectPosition(current: number, target: number, elapsedMs: number) {
  if (Math.abs(target - current) < 0.0005) return target;
  const amount = 1 - Math.exp(-Math.max(0, elapsedMs) / VERTICAL_FOLLOW_EASE_MS);
  return mix(current, target, amount);
}

function getBoxAtProgress(bboxes: BBoxFrame[], progress: number) {
  if (bboxes.length === 0) return null;
  if (bboxes.length === 1) return bboxes[0];

  const firstFrame = bboxes[0].frame_clip;
  const lastFrame = bboxes[bboxes.length - 1].frame_clip;

  if (lastFrame <= firstFrame) {
    const scaledIndex = clamp01(progress) * (bboxes.length - 1);
    const lowerIndex = Math.floor(scaledIndex);
    const upperIndex = Math.min(bboxes.length - 1, lowerIndex + 1);
    return interpolateBox(bboxes[lowerIndex], bboxes[upperIndex], scaledIndex - lowerIndex);
  }

  const targetFrame = firstFrame + clamp01(progress) * (lastFrame - firstFrame);
  const upperIndex = bboxes.findIndex((box) => box.frame_clip >= targetFrame);
  if (upperIndex === -1) return bboxes[bboxes.length - 1];
  if (upperIndex === 0) return bboxes[0];

  const lower = bboxes[upperIndex - 1];
  const upper = bboxes[upperIndex];
  const span = upper.frame_clip - lower.frame_clip;
  const amount = span > 0 ? (targetFrame - lower.frame_clip) / span : 0;
  return interpolateBox(lower, upper, amount);
}

function getRenderedBox(video: HTMLVideoElement, bbox: BBoxFrame, objectY: number) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const cw = video.clientWidth;
  const ch = video.clientHeight;
  if (!vw || !vh || !cw || !ch) return null;

  const scale = Math.max(cw / vw, ch / vh);
  const renderedWidth = vw * scale;
  const renderedHeight = vh * scale;
  const overflowX = Math.max(0, renderedWidth - cw);
  const overflowY = Math.max(0, renderedHeight - ch);
  const centerXNorm = bbox.x_norm + bbox.w_norm / 2;
  const centerYNorm = bbox.y_norm + bbox.h_norm / 2;
  const centerY = centerYNorm * renderedHeight;
  const objectX = overflowX > 0 ? clamp01((centerXNorm * renderedWidth - cw / 2) / overflowX) : 0.5;
  const currentObjectY = overflowY > 0 ? clamp01(objectY) : 0.5;
  let targetObjectY = currentObjectY;

  if (overflowY > 0) {
    const cyAtCurrentY = centerY - overflowY * currentObjectY;
    const deadzoneHalfHeight = (ch * VERTICAL_DEADZONE_FRACTION) / 2;
    const deadzoneTop = ch / 2 - deadzoneHalfHeight;
    const deadzoneBottom = ch / 2 + deadzoneHalfHeight;

    if (cyAtCurrentY < deadzoneTop) {
      targetObjectY = clamp01((centerY - deadzoneTop) / overflowY);
    } else if (cyAtCurrentY > deadzoneBottom) {
      targetObjectY = clamp01((centerY - deadzoneBottom) / overflowY);
    }
  }

  const left = -overflowX * objectX;
  const top = -overflowY * currentObjectY;
  const cx = left + centerXNorm * renderedWidth;
  const cy = top + centerYNorm * renderedHeight;
  const width = Math.max(MIN_HIGHLIGHT_SIZE, Math.abs(bbox.w_norm) * renderedWidth);
  const height = Math.max(MIN_HIGHLIGHT_SIZE, Math.abs(bbox.h_norm) * renderedHeight);

  return {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
    cx,
    cy,
    viewWidth: cw,
    viewHeight: ch,
    objectX,
    objectY: currentObjectY,
    targetObjectY,
  };
}

interface FeedCardProps {
  snippet: FeedSnippet;
  isActive: boolean;
  preload: boolean;
  hasNext: boolean;
  onAdvance: () => void;
}

export function FeedCard({ snippet, isActive, preload, hasNext, onAdvance }: FeedCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const traceGlowRef = useRef<SVGPolylineElement>(null);
  const traceRef = useRef<SVGPolylineElement>(null);
  const {
    session,
    status,
    myAnswer,
    stats,
    submitting,
    answerText,
    setAnswerText,
    correction,
    acceptCorrection,
    submitOriginal,
    submitError,
    handleSubmit,
  } = useCreatureQuiz(snippet, "/feed");

  const bboxes = useMemo(
    () =>
      (snippet.bboxes ?? [])
        .filter(hasUsableBox)
        .map((box, index) => ({
          ...box,
          frame_clip: Number.isFinite(box.frame_clip) ? box.frame_clip : index,
        }))
        .sort((a, b) => a.frame_clip - b.frame_clip),
    [snippet.bboxes]
  );

  useEffect(() => {
    if (!videoRef.current) return;
    if (isActive) {
      videoRef.current.play().catch(() => {});
    } else {
      videoRef.current.pause();
    }
  }, [isActive]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const overlay = overlayRef.current;
    const traceGlow = traceGlowRef.current;
    const trace = traceRef.current;

    if (!isActive || bboxes.length === 0 || !overlay || !traceGlow || !trace) {
      video.style.objectPosition = "";
      if (overlay) overlay.style.opacity = "0";
      return;
    }

    let raf = 0;
    let points: Point[] = [];
    let verticalObjectY = 0.5;
    let lastTimestamp = 0;

    const tick = (timestamp: number) => {
      const elapsedMs = lastTimestamp > 0 ? timestamp - lastTimestamp : 16.7;
      lastTimestamp = timestamp;
      const dur = video.duration;
      if (Number.isFinite(dur) && dur > 0) {
        const t = Math.min(Math.max(video.currentTime, 0), dur);
        const bbox = getBoxAtProgress(bboxes, t / dur);
        const targetRendered = bbox ? getRenderedBox(video, bbox, verticalObjectY) : null;
        if (bbox && targetRendered) {
          verticalObjectY = easeObjectPosition(verticalObjectY, targetRendered.targetObjectY, elapsedMs);
          const rendered = getRenderedBox(video, bbox, verticalObjectY);
          if (!rendered) {
            raf = requestAnimationFrame(tick);
            return;
          }
          video.style.objectPosition = `${(rendered.objectX * 100).toFixed(2)}% ${(rendered.objectY * 100).toFixed(2)}%`;

          overlay.setAttribute("viewBox", `0 0 ${rendered.viewWidth} ${rendered.viewHeight}`);
          overlay.style.opacity = "1";

          const lastPoint = points[points.length - 1];
          if (!lastPoint || Math.hypot(lastPoint.x - rendered.cx, lastPoint.y - rendered.cy) > 2) {
            points = [...points, { x: rendered.cx, y: rendered.cy }].slice(-TRACE_POINT_LIMIT);
          }
          const pointString = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
          traceGlow.setAttribute("points", pointString);
          trace.setAttribute("points", pointString);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bboxes, isActive]);

  const submitAndAdvance = useCallback(async (submit: () => Promise<boolean>) => {
    if (submitting) return;
    const didSubmit = await submit();
    if (didSubmit && hasNext) {
      window.setTimeout(onAdvance, 250);
    }
  }, [hasNext, onAdvance, submitting]);

  const handleConfirmAndAdvance = useCallback(async () => {
    if (!answerText.trim()) return;
    await submitAndAdvance(() => handleSubmit());
  }, [answerText, handleSubmit, submitAndAdvance]);

  const showStats = myAnswer && stats;
  const hasBboxes = bboxes.length > 0;

  return (
    <article className="flex h-full min-h-0 flex-col bg-[#17252A] text-white md:flex-row">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <video
          ref={videoRef}
          src={snippet.videoUrl}
          poster={snippet.thumbnailUrl}
          muted
          playsInline
          loop
          preload={preload ? "auto" : "metadata"}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ willChange: "object-position" }}
        />
        {hasBboxes && (
          <svg
            ref={overlayRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full opacity-0 transition-opacity duration-150"
            preserveAspectRatio="none"
          >
            <polyline
              ref={traceGlowRef}
              fill="none"
              stroke="rgba(255,255,255,0.14)"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="6"
            />
            <polyline
              ref={traceRef}
              fill="none"
              stroke="rgba(255,255,255,0.55)"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          </svg>
        )}
      </div>

      <aside className="max-h-[46vh] shrink-0 overflow-y-auto border-t border-white/10 bg-[#17252A] px-4 py-4 text-white md:max-h-none md:w-[360px] md:border-l md:border-t-0 md:px-5 md:py-5">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#DEF2F1]">
            {snippet.site} · {snippet.deployment}
          </p>
          <h2 className="font-brand-heading mb-3 text-2xl">What species is this?</h2>

          {!showStats ? (
            <>
              <label
                htmlFor={`species-answer-${snippet.id}`}
                className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-white/75"
              >
                Species name
              </label>
              <input
                id={`species-answer-${snippet.id}`}
                type="text"
                placeholder="Type species name"
                value={answerText}
                onChange={(e) => setAnswerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleConfirmAndAdvance();
                  }
                }}
                autoComplete="off"
                className="mb-3 w-full rounded-2xl border border-white/30 bg-white px-3 py-2.5 text-sm text-[#17252A] outline-none placeholder:text-[#17252A]/55 focus:border-[#DEF2F1]"
                style={{ color: "#17252A", WebkitTextFillColor: "#17252A", caretColor: "#2B7A78" }}
              />
              <AnimatePresence>
                {correction && (
                  <motion.div
                    key="correction"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="mb-3 rounded-2xl border border-white/18 bg-white/10 p-3"
                  >
                    <p className="text-sm text-white/86">
                      Did you mean: <span className="font-semibold text-[#DEF2F1]">{correction.suggestion}</span>?
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <motion.button
                        type="button"
                        onClick={() => submitAndAdvance(acceptCorrection)}
                        whileTap={{ scale: 0.97 }}
                        className="rounded-full bg-[#DEF2F1] px-3 py-1.5 text-xs font-semibold text-[#17252A]"
                      >
                        Yes, use that
                      </motion.button>
                      <motion.button
                        type="button"
                        onClick={() => submitAndAdvance(submitOriginal)}
                        whileTap={{ scale: 0.97 }}
                        className="rounded-full border border-white/30 px-3 py-1.5 text-xs font-semibold text-white hover:border-[#3AAFA9]"
                      >
                        Use my answer
                      </motion.button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              {submitError && (
                <p className="mb-3 text-xs font-medium text-red-200">{submitError}</p>
              )}
              <motion.button
                type="button"
                onClick={handleConfirmAndAdvance}
                disabled={!answerText.trim() || submitting}
                whileTap={!submitting && answerText.trim() ? { scale: 0.97 } : undefined}
                className="w-full rounded-full bg-[#3AAFA9] px-4 py-2.5 text-sm font-semibold text-[#17252A] hover:bg-[#59c8c3] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
              >
                {submitting
                  ? "Submitting…"
                  : hasNext
                    ? "Confirm and load next video"
                    : "Confirm selection"}
              </motion.button>
              {status !== "loading" && !session && (
                <p className="mt-2 text-xs text-white/75">
                  <Link href={`/auth/signin?callbackUrl=${encodeURIComponent("/feed")}`} className="text-[#DEF2F1] underline underline-offset-4">
                    Sign in
                  </Link> to record your answer and keep your PEBL streak alive.
                </p>
              )}
            </>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={myAnswer!.isCorrect ? "correct" : "wrong"}
                initial={myAnswer!.isCorrect ? { scale: 0.9, opacity: 0 } : { x: 0 }}
                animate={
                  myAnswer!.isCorrect
                    ? { scale: 1, opacity: 1 }
                    : { x: [0, -10, 10, -8, 8, 0] }
                }
                transition={
                  myAnswer!.isCorrect
                    ? { type: "spring", stiffness: 300, damping: 20 }
                    : { duration: 0.4 }
                }
                className="space-y-3"
              >
                <p className="text-sm font-medium text-[#DEF2F1]">
                  You said: {myAnswer!.chosenOption}{" "}
                  {myAnswer!.isCorrect && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 400, delay: 0.1 }}
                    >
                      ✓ Correct!
                    </motion.span>
                  )}
                </p>
                <div className="text-xs">
                  <p className="mb-1 font-medium uppercase tracking-[0.14em] text-white/80">Community response</p>
                  <ul className="space-y-0.5">
                    {stats!.stats.slice(0, 4).map((s) => (
                      <li key={s.option} className="flex items-center gap-2">
                        <span className="w-20">{s.option}</span>
                        <span className="text-white/65">{s.percent}%</span>
                        <div className="max-w-[120px] flex-1 overflow-hidden rounded bg-white/12 h-1.5">
                          <div className="h-full rounded bg-[#3AAFA9]" style={{ width: `${s.percent}%` }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-white/65">PEBL reference: {stats!.staffAnswer}</p>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-white/75">
                  {hasNext && (
                    <motion.button
                      type="button"
                      onClick={onAdvance}
                      whileTap={{ scale: 0.97 }}
                      className="rounded-full bg-[#3AAFA9] px-4 py-2 text-sm font-semibold text-[#17252A] hover:bg-[#59c8c3]"
                    >
                      Load next video
                    </motion.button>
                  )}
                  <Link href="/feed/browse" className="text-[#DEF2F1] underline underline-offset-4">Open archive</Link>
                </div>
              </motion.div>
            </AnimatePresence>
          )}
      </aside>
    </article>
  );
}
