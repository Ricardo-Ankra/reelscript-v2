import 'server-only';
import { serverEnv } from '../env.server';
import { makeAssetId, type StockCandidate, type StockSearchParams } from './candidate';

// Pexels adapter (https://api.pexels.com). Photos: /v1/search; videos:
// /videos/search. Auth via the `Authorization: <key>` header. Returns [] when the
// key is absent (the caller branches to degradation). Field shapes confirmed at the
// live smoke; pick a sensibly-sized download file and a small thumbnail for vision.
const PER_PAGE = 8;

// Pexels images are imgix-backed: serve a thumbnail bounded to <=1200px per side for
// the vision model (the many-image request limit is 2000px). We strip any existing
// query and set our own so params don't duplicate. Only the THUMBNAIL is bounded —
// downloadUrl keeps full quality for the actual render.
function sizedThumb(url: string | undefined): string {
  if (!url) return '';
  const base = url.split('?')[0];
  return `${base}?auto=compress&cs=tinysrgb&w=1200&h=1200&fit=clip`;
}

type PexelsPhoto = {
  id: number;
  width: number;
  height: number;
  photographer: string;
  src: { large2x?: string; large?: string; original?: string; medium?: string; tiny?: string };
};
type PexelsVideoFile = { quality: string; file_type: string; width: number; height: number; link: string };
type PexelsVideo = {
  id: number;
  width: number;
  height: number;
  image: string;
  user?: { name?: string };
  video_files: PexelsVideoFile[];
};

export async function searchPexels(params: StockSearchParams): Promise<StockCandidate[]> {
  const key = serverEnv.pexels.apiKey;
  if (!key) return [];
  const q = new URLSearchParams({ query: params.query, per_page: String(PER_PAGE) });
  if (params.orientation) q.set('orientation', params.orientation);

  const base = params.kind === 'video' ? 'https://api.pexels.com/videos/search' : 'https://api.pexels.com/v1/search';
  if (params.kind === 'image') q.set('size', 'large');
  const res = await fetch(`${base}?${q}`, { headers: { Authorization: key } });
  if (!res.ok) throw new Error(`Pexels ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();

  if (params.kind === 'image') {
    return ((json.photos as PexelsPhoto[]) ?? [])
      .filter((p) => !params.minWidth || p.width >= params.minWidth)
      .map((p) => ({
        assetId: makeAssetId('pexels', 'image', p.id),
        provider: 'pexels' as const,
        kind: 'image' as const,
        externalId: String(p.id),
        thumbnailUrl: sizedThumb(p.src.original ?? p.src.large2x ?? p.src.large ?? p.src.medium),
        downloadUrl: p.src.large2x ?? p.src.large ?? p.src.original ?? '',
        width: p.width,
        height: p.height,
        attribution: `Photo by ${p.photographer} on Pexels`,
      }));
  }
  return ((json.videos as PexelsVideo[]) ?? []).map((v) => {
    const mp4s = v.video_files.filter((f) => f.file_type === 'video/mp4' && f.link);
    // Largest file at or below 1280px wide. A 1080-wide output never needs more,
    // and bigger files (>~12MB) can choke Remotion's OffthreadVideo proxy on Lambda.
    const sized = mp4s.slice().sort((a, b) => a.width - b.width);
    const best = sized.filter((f) => f.width <= 1280).pop() ?? sized[0] ?? v.video_files[0];
    return {
      assetId: makeAssetId('pexels', 'video', v.id),
      provider: 'pexels' as const,
      kind: 'video' as const,
      externalId: String(v.id),
      thumbnailUrl: sizedThumb(v.image), // v.image is the full-res poster — bound it
      downloadUrl: best?.link ?? '',
      width: best?.width ?? v.width,
      height: best?.height ?? v.height,
      attribution: `Video by ${v.user?.name ?? 'Pexels'} on Pexels`,
    };
  });
}
