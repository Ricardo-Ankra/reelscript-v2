import 'server-only';
import { anthropic } from '../ai/anthropic';
import { tokenizeSpokenWords } from './tokenize';
import {
  buildEmphasisSystemPrompt,
  buildEmphasisUserPrompt,
  parseEmphasisAnnotations,
  type EmphasisDensity,
} from './emphasis-pass';
import type { TtsAlignment } from '../voice/alignment';
import type { WordEmphasis } from './types';

// Server-only caller for the caption emphasis pass (caption emphasis revision,
// 2026-06-16). Pure prompt-building + parsing live in emphasis-pass.ts; this is
// the one impure step (the Haiku call). It NEVER throws — any failure returns no
// emphasis so captions still render (all-normal words).
//
// IMPORTANT: it tokenizes the scene's words with the SAME canonical tokenizer the
// caption builder uses, so the indices the model returns line up with the words
// the renderer draws.

export async function annotateSceneEmphasis(input: {
  alignment: TtsAlignment;
  sceneScript: string;
  density: EmphasisDensity;
  model: string;
}): Promise<WordEmphasis[]> {
  const words = tokenizeSpokenWords(input.alignment);
  if (words.length === 0) return [];

  try {
    const msg = await anthropic().messages.create({
      model: input.model,
      max_tokens: 1024,
      system: buildEmphasisSystemPrompt(),
      messages: [
        { role: 'user', content: buildEmphasisUserPrompt(words, input.sceneScript, input.density) },
      ],
    });
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return parseEmphasisAnnotations(text, words.length);
  } catch {
    return []; // emphasis is best-effort; never block a render on it
  }
}
