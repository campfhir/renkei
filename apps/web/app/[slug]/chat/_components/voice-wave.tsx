'use client';

/**
 * The voice, drawn: a wave that moves with the sound — the microphone's
 * level while the person talks, the speaker's while the assistant does —
 * inside a glow that swells and feathers with the same signal. With no
 * sound behind it (thinking, or nothing to measure) the wave still moves,
 * slowly, so the screen never looks frozen. Colour is the person's own
 * choice: a rainbow, or one hue.
 *
 * Canvas, redrawn every frame it is on screen: three sine layers at
 * different speeds whose amplitude follows a smoothed level (quick to
 * rise, slower to fall, like a meter), a gradient stroke, and behind it a
 * blurred radial glow whose size and opacity track the same level.
 */

import { useEffect, useRef } from 'react';
import type { VoiceAccent } from '@renkei/user-prefs/prefs';

export type WaveAccent = VoiceAccent;

export const WAVE_ACCENTS: { id: WaveAccent; label: string; colors: string[] }[] = [
  {
    id: 'rainbow',
    label: 'Rainbow',
    colors: ['#F43F5E', '#F59E0B', '#22C55E', '#0EA5E9', '#8B5CF6', '#EC4899'],
  },
  { id: 'blue', label: 'Blue', colors: ['#38BDF8', '#2563EB', '#1D4ED8'] },
  { id: 'violet', label: 'Violet', colors: ['#C084FC', '#7C3AED', '#6D28D9'] },
  { id: 'emerald', label: 'Emerald', colors: ['#6EE7B7', '#059669', '#047857'] },
  { id: 'amber', label: 'Amber', colors: ['#FCD34D', '#F59E0B', '#D97706'] },
  { id: 'rose', label: 'Rose', colors: ['#FDA4AF', '#E11D48', '#BE123C'] },
];

export function accentColors(accent: WaveAccent): string[] {
  return (WAVE_ACCENTS.find((entry) => entry.id === accent) ?? WAVE_ACCENTS[0]).colors;
}

export type WaveTone = 'listening' | 'speaking' | 'thinking' | 'idle';

export default function VoiceWave({
  level,
  tone,
  accent,
  width = 320,
  height = 160,
  className,
}: {
  /** The sound right now, 0–1: microphone while listening, speaker while speaking. */
  level: number;
  tone: WaveTone;
  accent: WaveAccent;
  width?: number;
  height?: number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  // The latest inputs, read by the animation loop without restarting it.
  const inputs = useRef({ level, tone, accent });
  inputs.current = { level, tone, accent };

  useEffect(() => {
    const element = canvas.current;
    const halo = glow.current;
    if (!element || !halo) return;
    const context = element.getContext('2d');
    if (!context) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    element.width = width * scale;
    element.height = height * scale;
    context.scale(scale, scale);

    let smoothed = 0;
    let phase = 0;
    let frame = 0;
    let last = performance.now();

    const draw = (now: number) => {
      const elapsed = Math.min(0.1, (now - last) / 1000);
      last = now;
      const { level: target, tone: currentTone, accent: currentAccent } = inputs.current;
      // A meter: quick to rise, slower to fall.
      const wanted = Math.min(1, Math.max(0, target));
      smoothed += (wanted - smoothed) * (wanted > smoothed ? 0.35 : 0.08);
      // Sound moves the wave; with none, it idles — quickly while
      // thinking, barely at all when idle.
      const idle = currentTone === 'thinking' ? 0.14 : currentTone === 'idle' ? 0.05 : 0.08;
      const amplitude = idle + smoothed * 0.9;
      const speed = reduceMotion
        ? 0
        : currentTone === 'thinking'
          ? 2.4
          : currentTone === 'speaking'
            ? 3.2 + smoothed * 3
            : 1.6 + smoothed * 2;
      phase += elapsed * speed;

      const colors = accentColors(currentAccent);
      const gradient = context.createLinearGradient(0, 0, width, 0);
      colors.forEach((color, index) => gradient.addColorStop(index / (colors.length - 1), color));

      context.clearRect(0, 0, width, height);
      const middle = height / 2;
      const layers = [
        { frequency: 1.0, offset: 0, weight: 1, alpha: 0.95, line: 3 },
        { frequency: 1.6, offset: 1.3, weight: 0.65, alpha: 0.55, line: 2 },
        { frequency: 2.3, offset: 2.9, weight: 0.4, alpha: 0.35, line: 1.5 },
      ];
      for (const layer of layers) {
        context.beginPath();
        for (let x = 0; x <= width; x += 2) {
          const t = x / width;
          // Feathered ends: the wave tapers to nothing at both edges.
          const envelope = Math.sin(Math.PI * t) ** 1.4;
          const y =
            middle +
            Math.sin(t * Math.PI * 2 * layer.frequency + phase * layer.frequency + layer.offset) *
              amplitude *
              layer.weight *
              envelope *
              (height / 2 - 6);
          if (x === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.strokeStyle = gradient;
        context.globalAlpha = layer.alpha;
        context.lineWidth = layer.line;
        context.lineCap = 'round';
        context.stroke();
      }
      context.globalAlpha = 1;

      // The glow: bigger and brighter with the sound, feathered by blur.
      const swell =
        0.75 + smoothed * 0.6 + (currentTone === 'thinking' ? Math.sin(phase) * 0.06 : 0);
      halo.style.transform = `scale(${swell.toFixed(3)})`;
      halo.style.opacity = (0.35 + smoothed * 0.55).toFixed(3);
      halo.style.background = `radial-gradient(closest-side, ${colors[Math.floor(colors.length / 2)]} 0%, ${colors[0]} 45%, transparent 100%)`;

      if (!reduceMotion || smoothed > 0.01) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [width, height]);

  return (
    <div
      className={`relative flex items-center justify-center ${className ?? ''}`}
      style={{ width, height }}
      aria-hidden="true"
    >
      <div
        ref={glow}
        className="voice-glow pointer-events-none absolute inset-0 rounded-full"
        style={{ filter: `blur(${Math.round(height / 5)}px)` }}
      />
      <canvas ref={canvas} style={{ width, height }} className="relative" />
    </div>
  );
}

/**
 * The small wave in a button: five bars that dance to the level when one
 * is given, and on their own when none is — a reply being read, a
 * microphone listening.
 */
export function VoiceWaveIcon({
  level,
  accent,
  className,
}: {
  level?: number | null;
  accent: WaveAccent;
  className?: string;
}) {
  const colors = accentColors(accent);
  const heights = [0.45, 0.8, 1, 0.7, 0.5];
  return (
    <span
      className={`voice-bars inline-flex h-5 w-5 items-end justify-center gap-[2px] ${className ?? ''}`}
      aria-hidden="true"
    >
      {heights.map((base, index) => (
        <span
          key={index}
          className={level == null ? 'voice-bar voice-bar-dance' : 'voice-bar'}
          style={{
            background: colors[index % colors.length],
            animationDelay: `${index * 0.12}s`,
            height:
              level == null
                ? `${base * 100}%`
                : `${Math.max(15, base * 100 * (0.3 + Math.min(1, level) * 1.4))}%`,
          }}
        />
      ))}
    </span>
  );
}
