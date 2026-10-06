'use client';

import { ImagePlus, Trash2 } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';

import { UserAvatar } from './avatars';
import { apiRequest, Panel, useApi } from './components';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const SIZE = 128;

/** Center-crops and scales the picked image to 128x128 in the browser (WebP, PNG fallback). */
async function toAvatarDataUrl(file: globalThis.File): Promise<string> {
  const url = globalThis.URL.createObjectURL(file);
  try {
    const image = await new Promise<globalThis.HTMLImageElement>((resolve, reject) => {
      const element = new globalThis.Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('A kép nem olvasható'));
      element.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('A kép nem dolgozható fel');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
    const webp = canvas.toDataURL('image/webp', 0.86);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
  } finally {
    globalThis.URL.revokeObjectURL(url);
  }
}

/** Notifies the app shell (top bar avatar) that the profile changed. */
export const PROFILE_UPDATED_EVENT = 'soltrader:profile-updated';

export function ProfilePicturePanel() {
  const { data, refresh } = useApi<{ data: { id: string; email: string; name: string | null; avatarVersion: number | null } }>('/api/auth/me');
  const me = data?.data;
  const input = useRef<globalThis.HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const done = (text: string) => {
    setMessage({ tone: 'ok', text });
    refresh();
    globalThis.dispatchEvent(new globalThis.Event(PROFILE_UPDATED_EVENT));
  };

  const pick = async (event: ChangeEvent<globalThis.HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setMessage({ tone: 'error', text: 'Csak PNG, JPEG vagy WebP kép választható.' });
    if (file.size > MAX_SOURCE_BYTES) return setMessage({ tone: 'error', text: 'A kép legfeljebb 10 MB lehet.' });
    setBusy(true);
    setMessage(null);
    try {
      const image = await toAvatarDataUrl(file);
      await apiRequest('/api/profile/avatar', { method: 'PUT', body: JSON.stringify({ image }) });
      done('Profilkép frissítve.');
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'A feltöltés nem sikerült.' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await apiRequest('/api/profile/avatar', { method: 'DELETE', body: '{}' });
      done('Profilkép eltávolítva.');
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Nem sikerült.' });
    } finally {
      setBusy(false);
    }
  };

  return <Panel title="Profilkép" description="Megjelenik a fejlécben és az admin felhasználólistában. A kép a böngésződben 128×128-ra kicsinyítve töltődik fel (PNG, JPEG vagy WebP).">
    <div className="avatar-settings">
      <UserAvatar userId={me?.id} version={me?.avatarVersion} name={me?.name} email={me?.email} size={72} />
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void pick(event)} />
      <button type="button" className="primary-button" disabled={busy || !me} onClick={() => input.current?.click()}><ImagePlus size={16} aria-hidden="true" /> {busy ? 'Feltöltés…' : me?.avatarVersion ? 'Kép cseréje' : 'Kép feltöltése'}</button>
      {me?.avatarVersion ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void remove()}><Trash2 size={16} aria-hidden="true" /> Eltávolítás</button> : null}
    </div>
    {message ? <p className={message.tone === 'ok' ? 'sfield-help' : 'settings-warning'} role="status">{message.text}</p> : null}
  </Panel>;
}
