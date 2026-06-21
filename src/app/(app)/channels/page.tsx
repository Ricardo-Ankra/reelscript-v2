import { redirect } from 'next/navigation';

// The channel list now lives on Home (/). Redirect so old links resolve.
export default function ChannelsPage() {
  redirect('/');
}
