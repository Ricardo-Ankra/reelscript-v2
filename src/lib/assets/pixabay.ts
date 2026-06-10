import 'server-only';
import { serverEnv } from '../env.server';
import { makeAssetId, type StockCandidate, type StockSearchParams } from './candidate';

// Pixabay adapter (https://pixabay.com/api). Images: /api/; videos: /api/videos/.
// Auth via the `key` query param. Returns [] when the key is absent. Orientation
// maps to Pixabay's horizontal/vertical/all.
const PER_PAGE = 8;

type PixabayImage = {
  id: number;
  webformatURL: string;
  previewURL: string;
  largeImageURL: string;
  imageWidth: number;
  imageHeight: number;
  user: string;
};
type PixabayVideoSize = { url: string; width: number; height: number; thumbnail?: string };
type PixabayVideo = {
  id: number;
  duration: number;
  user: string;
  videos: { large?: PixabayVideoSize; medium?: PixabayVideoSize; small?: PixabayVideoSize; tiny?: PixabayVideoSize };
};

function pxOrientation(o?: string): string {
  if (o === 'portrait') return 'vertical';
  if (o === 'landscape') return 'horizontal';
  return 'all';
}

export async function searchPixabay(params: StockSearchParams): Promise<StockCandidate[]> {
  const key = serverEnv.pixabay.apiKey;
  if (!key) return [];
  const q = new URLSearchParams({ key, q: params.query, per_page: String(PER_PAGE), safesearch: 'true' });

  if (params.kind === 'image') {
    q.set('image_type', 'photo');
    q.set('orientation', pxOrientation(params.orientation));
    if (params.minWidth) q.set('min_width', String(params.minWidth));
    const res = await fetch(`https://pixabay.com/api/?${q}`);
    if (!res.ok) throw new Error(`Pixabay ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return ((json.hits as PixabayImage[]) ?? []).map((h) => ({
      assetId: makeAssetId('pixabay', 'image', h.id),
      provider: 'pixabay' as const,
      kind: 'image' as const,
      externalId: String(h.id),
      thumbnailUrl: h.webformatURL ?? h.previewURL,
      downloadUrl: h.largeImageURL ?? h.webformatURL,
      width: h.imageWidth,
      height: h.imageHeight,
      attribution: `Image by ${h.user} on Pixabay`,
    }));
  }

  const res = await fetch(`https://pixabay.com/api/videos/?${q}`);
  if (!res.ok) throw new Error(`Pixabay ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return ((json.hits as PixabayVideo[]) ?? []).map((h) => {
    // Prefer medium (~1280) over large (can be 4K) to keep files OffthreadVideo-safe.
    const v = h.videos.medium ?? h.videos.small ?? h.videos.large ?? h.videos.tiny;
    return {
      assetId: makeAssetId('pixabay', 'video', h.id),
      provider: 'pixabay' as const,
      kind: 'video' as const,
      externalId: String(h.id),
      thumbnailUrl: v?.thumbnail ?? '',
      downloadUrl: v?.url ?? '',
      width: v?.width ?? 0,
      height: v?.height ?? 0,
      attribution: `Video by ${h.user} on Pixabay`,
    };
  });
}
