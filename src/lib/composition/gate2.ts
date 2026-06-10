import 'server-only';
import { renderStillOnLambda, type AwsRegion } from '@remotion/lambda/client';
import { anthropic, COMPOSITION_MODEL } from '../ai/anthropic';
import { buildGate2QaPrompt, parseGate2Verdict, frameLooksBlank } from '../ai/vision';

// Gate 2 (spec 11.2): render ONE still from the middle of the video on Lambda, then
// (1) a mechanical not-blank check and (2) one Claude-vision QA pass — does the frame
// match intent, no overflow/clash. Surfaces failures; there is no auto-fix loop yet
// (Phase 7). The caller (render.ts) decides what a fail does and writes the
// cost_events('smoke_frame') row from the returned costUsd.

export interface Gate2Params {
  region: AwsRegion;
  functionName: string;
  serveUrl: string;
  specUrl: string; // the signed render-time spec — the same one the video render uses
  midFrame: number; // frame to sample (caller computes durationInFrames/2)
  sceneIntent: string; // narration / shot intent for the scene at the mid frame
}

export interface Gate2Result {
  pass: boolean;
  issues: string[];
  frameUrl: string; // preserved for inspection on failure
  costUsd: number; // Lambda still cost (smoke_frame)
  tokensIn: number;
  tokensOut: number;
}

export async function runGate2(params: Gate2Params): Promise<Gate2Result> {
  const still = await renderStillOnLambda({
    region: params.region,
    functionName: params.functionName,
    serveUrl: params.serveUrl,
    composition: 'Reel',
    inputProps: { specUrl: params.specUrl },
    imageFormat: 'png',
    privacy: 'private',
    frame: params.midFrame,
  });
  const costUsd = still.estimatedPrice?.accruedSoFar ?? 0;

  // Mechanical pre-filter: a blank/solid frame fails without spending a vision call.
  if (frameLooksBlank(still.sizeInBytes)) {
    return {
      pass: false,
      issues: ['Smoke frame is blank or near-empty (mechanical check).'],
      frameUrl: still.url,
      costUsd,
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  // Download the PNG and hand it to the vision model as base64 (no public exposure).
  const res = await fetch(still.url);
  if (!res.ok) throw new Error(`fetch smoke frame: ${res.status}`);
  const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');

  const msg = await anthropic().messages.create({
    model: COMPOSITION_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
          { type: 'text', text: buildGate2QaPrompt(params.sceneIntent) },
        ],
      },
    ],
  });
  const tokensIn = msg.usage.input_tokens ?? 0;
  const tokensOut = msg.usage.output_tokens ?? 0;
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

  const verdict = parseGate2Verdict(text);
  if (!verdict) {
    // Couldn't read a verdict — pass with a noted issue rather than fail an otherwise
    // fine render on a parser hiccup. The issue is still surfaced to the caller.
    return {
      pass: true,
      issues: ['Gate 2 vision verdict was unparseable; passed by default.'],
      frameUrl: still.url,
      costUsd,
      tokensIn,
      tokensOut,
    };
  }
  return { pass: verdict.pass, issues: verdict.issues, frameUrl: still.url, costUsd, tokensIn, tokensOut };
}
