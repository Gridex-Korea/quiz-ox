// 사진 문제용: 브라우저에서 이미지를 줄여(긴 변 1280px) 업로드 용량을 수백 KB로 맞춘다. 서버에는 이미지 처리 라이브러리가 없다.
export async function resizeImage(file: File, maxSide = 1280): Promise<Blob> {
  if (file.type === 'image/gif') return file; // 움직이는 GIF는 그대로
  const bitmap = await loadImage(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const keepPng = file.type === 'image/png' && file.size < 600 * 1024;
  const type = keepPng ? 'image/png' : 'image/jpeg';
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지 변환 실패'))), type, 0.86);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 읽을 수 없습니다'));
    };
    img.src = url;
  });
}
