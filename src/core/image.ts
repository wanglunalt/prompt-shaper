const DEFAULT_SHOT_PROMPT = '修复截图中展示的 Bug';

export { DEFAULT_SHOT_PROMPT };

export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取截图失败'));
    reader.readAsDataURL(file);
  });
}

export function imageFileFromClipboard(data: DataTransfer | null): File | null {
  const items = data?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

/** Keep error text readable while avoiding multi-megabyte requests. */
export function compactImage(dataUrl: string, maxEdge = 1024): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      if (scale === 1 && dataUrl.startsWith('data:image/jpeg') && dataUrl.length < 350_000) {
        resolve(dataUrl);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
